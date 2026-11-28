// Runs are jobs. The caller takes the per-graph run lock, writes runs/<job>.json and starts a
// detached worker (the CLI) that does the work, so a run survives a client timeout and the MCP
// server being stopped. Progress lives in files; a killed run is resumable, and finished slots are
// never regenerated because their takes carry the fingerprint they were made from.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { evaluate, slotKey, slotsToRun, type NodeEval, type Slot } from "./evaluate.js";
import { descendants, fileSha, findNode, importReference, inputsOf, nodeState, topoOrder } from "./graph.js";
import { workOf, NODE_SPECS } from "./nodes.js";
import { managedSpend } from "../spend.js";
import { StudioError, assetRel, atomicWrite, graphDir, mutate, now, paths, pidAlive, readBoth, readJson, sleep, type EventInput } from "./store.js";
import type { Executors, ExecutorKind, ExecOutput } from "./execute.js";
import { RUN_SCHEMA, type GraphFile, type RunRecord, type RunScope, type RunStatus, type StateFile, type Take } from "./types.js";
import { cmd, grantCmd, isCli, opt } from "./say.js";
import { DEFAULT_LIMITS, SUBSCRIPTION_RENDER, estimateSlot, renderLabel, studioProfile, type StudioProfile } from "./render.js";
import type { Limits } from "./budget.js";
import { dollars } from "../pricing.js";

const RUN_STALE_MS = 60_000;
const HEARTBEAT_MS = 5_000;
const TERMINAL: RunStatus[] = ["done", "done_with_errors", "stopped", "failed", "interrupted"];

export function parseScope(graph: GraphFile, scope?: string, nodes?: string[]): RunScope {
  if (nodes?.length) {
    for (const n of nodes) findNode(graph, n, "nodes");
    return { kind: "selection", nodes: [...new Set(nodes)] };
  }
  const sc = (scope ?? "all").trim();
  if (!sc || sc === "all") return { kind: "all", nodes: [] };
  if (sc.endsWith("+")) { findNode(graph, sc.slice(0, -1), "scope"); return { kind: "downstream", nodes: [sc.slice(0, -1)] }; }
  findNode(graph, sc, "scope");
  return { kind: "node", nodes: [sc] };
}

export function scopeSet(graph: GraphFile, scope: RunScope): Set<string> {
  if (scope.kind === "all") return new Set(graph.nodes.map(n => n.id));
  if (scope.kind === "downstream") return graph.nodes.some(n => n.id === scope.nodes[0]) ? descendants(graph, scope.nodes[0]!) : new Set();
  return new Set(scope.nodes.filter(id => graph.nodes.some(n => n.id === id)));
}

export const describeScope = (s: RunScope) => s.kind === "all" ? "all" : s.kind === "downstream" ? `${s.nodes[0]}+` : s.nodes.join(",");

// ---------------------------------------------------------------- planning

export interface PlanNode { node: string; type: string; work: "local" | "provider"; slots: number; toRun: number; cached: number; estimate?: boolean;
  /** Provider nodes: "subscription" or the API render label; and the estimated API dollars. */
  renderer?: string; cost?: number }
/** estimate: some count is a lower bound; generationsEstimate / localStepsEstimate say which. */
export interface Plan { scope: string; nodes: PlanNode[]; generations: number; localSteps: number; slots: number; estimate: boolean; generationsEstimate: boolean; localStepsEstimate: boolean; skipped: Array<{ node: string; reason: string; fix?: string }>; staleAfter: string[];
  /** Paid API work in the plan: slots and estimated dollars (pricing.ts). lowerBound when a count
   *  waits on upstream images this run makes. */
  api: { slots: number; cost: number; lowerBound: boolean } }

/** Input images an API slot sends (each adds input tokens to the estimate). */
const inputImagesOf = (slot: Slot) => (slot.image ? 1 : 0) + slot.refs.filter(r => r.role !== "palette" && r.role !== "logo").length + (slot.mask ? 1 : 0);
export const slotEstimate = (slot: Slot) => (slot.render ? estimateSlot(slot.render, { promptChars: (slot.text?.length ?? 0) + 600, inputImages: inputImagesOf(slot) }) : 0);

export async function planRun(project: string, dir: string, graph: GraphFile, state: StateFile, scope: RunScope, newTake: boolean, done = new Set<string>()): Promise<Plan> {
  const evals = await evaluate(graph, state, { dir, project });
  const inScope = scopeSet(graph, scope);
  const changed = new Set<string>();
  const plan: Plan = { scope: describeScope(scope), nodes: [], generations: 0, localSteps: 0, slots: 0, estimate: false, generationsEstimate: false, localStepsEstimate: false, skipped: [], staleAfter: [], api: { slots: 0, cost: 0, lowerBound: false } };
  for (const id of topoOrder(graph)) {
    const ev = evals.get(id)!;
    const node = ev.node;
    const upstreamChanges = inputsOf(graph, id).some(e => changed.has(e.from));
    if (!inScope.has(id)) { if (upstreamChanges) plan.staleAfter.push(id); continue; }
    const work = workOf(node.type, node.settings);
    if (work === "none" || node.type === "reference" || node.type === "canon") { if (upstreamChanges) changed.add(id); continue; }
    let toRun: number, slots = ev.slots.length, estimate = false, cost = 0;
    const isApi = node.type === "finish" || (work === "provider" && node.settings.renderer === "api");
    if (ev.issues.length || ev.blockedBy) {
      // A finish needs a person's (or agent's) approval between the drafts and itself, so it can
      // never run in the same run as the drafts it waits on. Do not count or price it.
      if (node.type === "finish" && ev.blockedBy && !ev.issues.length) {
        plan.skipped.push({ node: id, reason: `finish waits for an approved take from ${ev.blockedBy}`, fix: `Run the drafts, look at them, approve the one to finish ({op:"approve", take:"${ev.blockedBy}/<take>"}), then run ${id}.` });
        continue;
      }
      if (!(ev.blockedBy && upstreamChanges)) {
        plan.skipped.push({ node: id, reason: ev.issues[0]?.message ?? `waiting for ${ev.blockedBy}`, fix: ev.issues[0]?.fix ?? `Run ${ev.blockedBy} first (scope "${ev.blockedBy}+").` });
        continue;
      }
      slots = toRun = Math.max(1, Number(node.settings.takes ?? 1));
      estimate = true;
      if (isApi) {
        // The slot list is not known yet; price one representative slot of this node.
        const { apiRender } = await import("./render.js");
        const r = apiRender(node.type, node.settings, studioProfile(dir), {});
        cost = r ? toRun * estimateSlot(r, { promptChars: 600, inputImages: node.type === "generate" ? 0 : 1 }) : 0;
        plan.api.lowerBound = true;
      }
    } else {
      const todo = upstreamChanges ? ev.slots : slotsToRun(ev, state.nodes[id], newTake, done);
      toRun = todo.length;
      cost = todo.reduce((a, sl) => a + slotEstimate(sl), 0);
    }
    if (toRun) changed.add(id);
    const renderer = work === "provider" ? (isApi ? renderLabel(ev.slots[0]?.render ?? { renderer: "api", model: String(node.settings.model ?? "sunburst") }) : "subscription") : undefined;
    plan.nodes.push({ node: id, type: node.type, work, slots, toRun, cached: Math.max(0, slots - toRun), estimate: estimate || undefined, ...(renderer ? { renderer } : {}), ...(isApi ? { cost: Math.round(cost * 1e6) / 1e6 } : {}) });
    if (isApi) { plan.api.slots += toRun; plan.api.cost = Math.round((plan.api.cost + cost) * 1e6) / 1e6; }
    plan.slots += toRun;
    if (work === "provider") plan.generations += toRun; else plan.localSteps += toRun;
    plan.estimate ||= estimate;
    if (estimate) { if (work === "provider") plan.generationsEstimate = true; else plan.localStepsEstimate = true; }
  }
  return plan;
}

// ---------------------------------------------------------------- run records + lock

const recordPath = (dir: string, job: string) => join(paths(dir).runs, `${job}.json`);
export const readRecord = (dir: string, job: string) => readJson<RunRecord>(recordPath(dir, job));
async function writeRecord(dir: string, rec: RunRecord) {
  await mkdir(paths(dir).runs, { recursive: true });
  await atomicWrite(recordPath(dir, rec.id), JSON.stringify(rec, null, 2) + "\n");
}

/** Job ids, oldest first. Ids carry the start second and a random suffix, so two runs started in
 *  the same second would sort at random; those are ordered by their record's created time (ms). */
export async function listRecords(dir: string): Promise<string[]> {
  let ids: string[];
  try { ids = (await readdir(paths(dir).runs)).filter(f => /^r\d{8}-\d{6}-[0-9a-f]{4}\.json$/.test(f)).map(f => f.slice(0, -5)).sort(); } catch { return []; }
  const second = (id: string) => id.slice(0, 16);
  const created = new Map<string, string>();
  for (let i = 0; i < ids.length; i++) {
    if (second(ids[i]!) !== second(ids[i - 1] ?? "") && second(ids[i]!) !== second(ids[i + 1] ?? "")) continue;
    created.set(ids[i]!, await readRecord(dir, ids[i]!).then(r => r.created, () => ""));
  }
  return created.size ? ids.sort((a, b) => second(a).localeCompare(second(b)) || (created.get(a) ?? "").localeCompare(created.get(b) ?? "") || a.localeCompare(b)) : ids;
}

interface RunLock { job: string; pid: number; host: string; actor: string; at: string }
async function readRunLock(dir: string): Promise<{ lock?: RunLock; mtimeMs: number } | null> {
  try {
    const st = await stat(paths(dir).runLock);
    let lock: RunLock | undefined;
    // The body is replaced by rename at start; a read can meet a sharing error or a torn body.
    // readJson waits those out; if it still cannot read it, lock stays undefined ("unknown").
    try { lock = await readJson<RunLock>(paths(dir).runLock); } catch { /* unknown, not absent */ }
    return { lock, mtimeMs: st.mtimeMs };
  } catch { return null; }
}

const lockLive = (l: { lock?: RunLock; mtimeMs: number }) => Date.now() - l.mtimeMs < RUN_STALE_MS && (!l.lock || l.lock.host !== hostname() || pidAlive(l.lock.pid));

/** The live job id, if a run is in progress. */
export async function liveJob(dir: string): Promise<string | undefined> {
  const l = await readRunLock(dir);
  return l && lockLive(l) ? l.lock?.job : undefined;
}

async function markInterrupted(dir: string, job: string) {
  try {
    const rec = await readRecord(dir, job);
    if (TERMINAL.includes(rec.status)) return;
    rec.status = "interrupted";
    rec.finished = now();
    rec.stopReason = "The worker stopped without finishing (killed, crashed, or the machine slept).";
    rec.stopFix = `Resume with ${cmd("run", { graph: rec.graph, resume: true })}; finished slots are kept.`;
    await writeRecord(dir, rec);
  } catch { /* no record */ }
  await mutate(dir, "studio", (_g, s) => {
    for (const ns of Object.values(s.nodes)) if (ns.activity?.job === job) delete ns.activity;
    return { result: null, events: [{ type: "run.interrupted", job }] };
  }).catch(() => {});
}

async function acquireRunLock(dir: string, job: string, actor: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const h = await open(paths(dir).runLock, "wx");
      try { await h.writeFile(JSON.stringify({ job, pid: process.pid, host: hostname(), actor, at: now() })); } finally { await h.close(); }
      return;
    } catch (e: any) {
      if (e?.code !== "EEXIST" && e?.code !== "EPERM") throw e;
      const cur = await readRunLock(dir);
      if (!cur) continue;
      if (lockLive(cur)) {
        throw new StudioError("RUN_ACTIVE", `A run is already in progress on this graph: ${cur.lock?.job ?? "(starting)"}.`,
          `Follow it with ${cmd("status", { graph: basename(dir), job: cur.lock?.job })}, or stop it with ${cmd("run", { graph: basename(dir), stop: true })}. One run per graph at a time.`);
      }
      if (cur.lock?.job) await markInterrupted(dir, cur.lock.job);
      const aside = `${paths(dir).runLock}.stale-${randomBytes(4).toString("hex")}`;
      await rename(paths(dir).runLock, aside).then(() => unlink(aside)).catch(() => {});
    }
  }
  throw new StudioError("LOCKED", "Could not take the run lock.", "Retry in a few seconds.");
}

async function releaseRunLock(dir: string, job: string) {
  const cur = await readRunLock(dir);
  if (cur?.lock?.job === job) await unlink(paths(dir).runLock).catch(() => {});
}

function newJobId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `r${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${randomBytes(2).toString("hex")}`;
}

/** Where the CLI that hosts the worker lives. From the dist/mcp.js bundle and dist/cli.js it is the
 *  sibling cli.js; from unbundled dist/studio/*.js it is ../cli.js. */
export function workerScript(): string {
  if (process.env.GPT_IMAGE_STUDIO_CLI) return process.env.GPT_IMAGE_STUDIO_CLI;
  for (const rel of ["./cli.js", "../cli.js"]) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(p)) return p;
  }
  throw new StudioError("NO_WORKER", "Cannot find the gpt-image CLI to host the run worker.", "Run `npm run build`, or set GPT_IMAGE_STUDIO_CLI to dist/cli.js.");
}

// ---------------------------------------------------------------- errors

export function classifyError(e: unknown, slug = "<graph>", api = false): { kind: "quota" | "auth" | "node"; message: string; fix: string } {
  const message = e instanceof Error ? e.message : String(e);
  if (api) {
    // The paid API: a missing or refused key, or an exhausted API balance, stops the run (every API
    // slot would fail the same way). Never retried on the subscription.
    if (/needs OPENAI_API_KEY and none was found/.test(message)) return { kind: "auth", message: message.split(" Fix: ")[0]!, fix: `${/Fix: (.*?) No request/.exec(message)?.[1] ?? "Provide OPENAI_API_KEY."} Then ${cmd("run", { graph: slug, resume: true })}. Nothing was rendered on the subscription instead.` };
    if (/\b401\b|invalid_api_key|incorrect api key/i.test(message)) return { kind: "auth", message, fix: `The API key was refused. Replace OPENAI_API_KEY in the source the run reported (never paste it into chat), then ${cmd("run", { graph: slug, resume: true })}.` };
    if (/insufficient_quota|billing|exceeded your current quota/i.test(message)) return { kind: "quota", message, fix: `The OpenAI API account is out of credit or over its billing limit. The owner adds credit at platform.openai.com, then ${cmd("run", { graph: slug, resume: true })}. The subscription was not used instead.` };
    if (/\b429\b|rate.?limit|too many requests/i.test(message)) return { kind: "quota", message, fix: `The API rate limit was hit after retries. Wait a minute, then ${cmd("run", { graph: slug, resume: true })}; finished slots are kept.` };
    if (/\b403\b|organization.*verif|must be verified/i.test(message)) return { kind: "auth", message, fix: "The API organisation may need verification for GPT Image models (developer console). The owner has to do that; nothing else will fix it." };
    return { kind: "node", message, fix: "Fix this node's settings or inputs and run it again. Other branches continued. Nothing was retried on the subscription." };
  }
  if (/\b429\b|rate.?limit|quota|usage limit|too many requests|throttl/i.test(message)) {
    const reset = /resets at (\S+) \(in ([^)]+)\)/.exec(message);
    return { kind: "quota", message, fix: reset
      ? `The subscription image cap was reached; it resets at ${reset[1]} (in ${reset[2]}). Resume after that with ${cmd("run", { graph: slug, resume: true })}; finished slots are kept.`
      : `The subscription quota or rate limit was reached. Wait, then resume with ${cmd("run", { graph: slug, resume: true })}; finished slots are kept.` };
  }
  if (/codex login|session (?:has )?ended|re-?log ?in|unauthori[sz]ed|\b401\b/i.test(message)) {
    return { kind: "auth", message, fix: `The ChatGPT session needs \`codex login\` (run it once), then ${cmd("run", { graph: slug, resume: true })}.` };
  }
  return { kind: "node", message, fix: "Fix this node's settings or inputs and run it again. Other branches continued." };
}

// ---------------------------------------------------------------- start / stop / resume

export interface RunRequest {
  scope?: string;
  nodes?: string[];
  newTake?: boolean;
  concurrency?: number;
  dryRun?: boolean;
  resume?: boolean;
  actor: string;
  /** false runs in this process (CLI --foreground, tests). */
  detach?: boolean;
  executors?: Executors;
  /** Lower this run's spend limits in dollars (never above the project's; raising needs a grant
   *  or the owner editing studio.limits). */
  limits?: { run?: number; day?: number };
}

/** The limits a run works under: the profile's, lowered (never raised) by the request. */
export function runLimits(prof: StudioProfile, req?: { run?: number; day?: number }): Limits {
  const L = { ...prof.limits };
  for (const k of ["run", "day"] as const) {
    const v = req?.[k];
    if (v === undefined) continue;
    if (!Number.isFinite(v) || v < 0) throw new StudioError("BAD_LIMIT", `The ${k} limit must be a dollar amount of 0 or more.`, `e.g. ${opt(k === "run" ? "max_run_cost" : "max_day_cost")} 0.5`);
    if (v > L[k] + 1e-9) throw new StudioError("LIMIT_RAISE", `A run can lower its ${k} limit but not raise it (asked ${dollars(v)}, the project's is ${dollars(L[k])}).`,
      `To spend more, ask the owner once with the amount the work needs; when they approve, record a grant with ${grantCmd()} and run again. Only the owner raises studio.limits in .gptimage.json.`);
    L[k] = v;
  }
  if (L.run > L.day) L.run = L.day;
  return L;
}

export interface StartResult { job?: string; status: string; plan: Plan; message: string; resumeOf?: string; prompts?: Array<{ node: string; slot: string; prompt: string }> }

function completedChain(dir: string, rec: RunRecord | undefined): Promise<Set<string>> {
  const out = new Set<string>();
  const walk = async (r: RunRecord | undefined, depth: number) => {
    if (!r || depth > 20) return;
    r.completed.forEach(k => out.add(k));
    if (r.resumeOf) await walk(await readRecord(dir, r.resumeOf).catch(() => undefined), depth + 1);
  };
  return walk(rec, 0).then(() => out);
}

/** Where the run was started from, if the starting process runs inside an ADE terminal. */
export function runOrigin(env: NodeJS.ProcessEnv = process.env): { origin?: { terminal?: string; workspace?: string } } {
  const clean = (v: string | undefined) => (v && v.trim() && v.length <= 200 ? v.trim() : undefined);
  const terminal = clean(env.HEPHAESTUS_TERMINAL_ID), workspace = clean(env.HEPHAESTUS_WORKSPACE);
  return terminal || workspace ? { origin: { ...(terminal ? { terminal } : {}), ...(workspace ? { workspace } : {}) } } : {};
}

export async function startRun(project: string, slug: string, req: RunRequest): Promise<StartResult> {
  const dir = graphDir(project, slug);
  const { graph, state } = await readBoth(dir);
  let scope: RunScope, newTake = Boolean(req.newTake), concurrency = Math.max(1, Math.min(3, req.concurrency ?? 1)), resumeOf: string | undefined;
  let done = new Set<string>();
  if (req.resume) {
    const jobs = await listRecords(dir);
    const last = jobs.length ? await readRecord(dir, jobs.at(-1)!) : undefined;
    if (!last) throw new StudioError("NO_RESUME", "There is no earlier run to resume.", `Start one with ${cmd("run", { graph: slug })}.`);
    const status = await derivedStatus(dir, last);
    if (!["interrupted", "stopped"].includes(status)) {
      throw new StudioError("NO_RESUME", `The last run ${last.id} is ${status}; only an interrupted or stopped run can be resumed.`, status === "running" || status === "starting" ? `Follow it with ${cmd("status", { graph: slug, job: last.id })}.` : "Start a new run; unchanged nodes are reused from cache anyway.");
    }
    if (status === "interrupted" && last.status !== "interrupted") await markInterrupted(dir, last.id);
    scope = last.scope; newTake = last.newTake; concurrency = last.concurrency; resumeOf = last.id;
    done = await completedChain(dir, last);
  } else scope = parseScope(graph, req.scope, req.nodes);

  const plan = await planRun(project, dir, graph, state, scope, newTake, done);
  const prof = studioProfile(dir);
  const limits = runLimits(prof, req.limits);
  const budgetLine = plan.api.slots ? await budgetPlanLine(project, slug, plan, limits, chainOf(resumeOf ? await readRecord(dir, resumeOf).catch(() => undefined) : undefined)) : "";
  if (req.dryRun) {
    const prompts = await dryRunPrompts(project, dir, graph, state, plan);
    return { status: blockedPlan(plan) ? "blocked" : "dry-run", plan, prompts, message: [planMessage(plan, true), ...(budgetLine ? [budgetLine] : []), ...prompts.map(p => `Prompt for ${p.node} (${p.slot}): ${p.prompt}`)].join("\n") };
  }
  if (blockedPlan(plan)) return { status: "blocked", plan, message: planMessage(plan, false) };
  if (!plan.slots) return { status: "nothing-to-do", plan, message: `Everything in scope "${plan.scope}" is current; nothing to run. Pass ${opt("new_take")}${isCli() ? "" : ":true"} for another take.` };
  if (plan.api.slots && prof.issue) throw new StudioError("BAD_PROFILE", `${prof.issue.path}: ${prof.issue.message}.`, prof.issue.fix);
  if (plan.api.slots && !req.resume) await refuseAfterBudgetStop(project, dir, slug);

  const job = newJobId();
  await acquireRunLock(dir, job, req.actor);
  const rec: RunRecord = {
    schema: RUN_SCHEMA, id: job, graph: slug, status: "starting", scope, newTake, concurrency, actor: req.actor, ...runOrigin(), created: now(), graphRevision: graph.revision, resumeOf,
    planned: { generations: plan.generations, slots: plan.slots, estimate: plan.estimate }, progress: { slotsDone: 0, slotsCached: 0, slotsFailed: 0, generations: 0 },
    completed: [], takes: [], skipped: [], errors: [],
    budget: { chain: resumeOf ? chainOf(await readRecord(dir, resumeOf).catch(() => undefined)) ?? resumeOf : job, limits, estimate: plan.api.cost, spent: 0 },
  };
  try {
    await writeRecord(dir, rec);
    await mutate(dir, req.actor, (_g, s) => {
      for (const n of plan.nodes) if (n.toRun) nodeState(s, n.node).activity = { job, status: "queued", at: now() };
      return { result: null, events: [{ type: "run.started", job, scope: plan.scope, newTake, planned: rec.planned, resumeOf }] };
    });
  } catch (e) {
    await releaseRunLock(dir, job);
    throw e;
  }

  if (req.detach === false) {
    await runJob(project, slug, job, req.executors);
    const fin = await readRecord(dir, job);
    return { job, status: fin.status, plan, resumeOf, message: `Run ${job} ${fin.status}.` };
  }
  try {
    const script = workerScript();
    await mkdir(paths(dir).runs, { recursive: true });
    const log = await open(join(paths(dir).runs, `${job}.log`), "a");
    const child = spawn(process.execPath, [script, "studio", "worker", slug, "--project", project, "--job", job], {
      detached: true, stdio: ["ignore", "ignore", log.fd], windowsHide: true, cwd: project, env: process.env,
    });
    child.unref();
    await log.close();
    if (child.pid) await atomicWrite(paths(dir).runLock, JSON.stringify({ job, pid: child.pid, host: hostname(), actor: req.actor, at: now() }));
  } catch (e) {
    rec.status = "failed"; rec.finished = now(); rec.errors.push({ node: "(worker)", message: e instanceof Error ? e.message : String(e) });
    await writeRecord(dir, rec);
    await releaseRunLock(dir, job);
    throw e;
  }
  return { job, status: "starting", plan, resumeOf, message: [planMessage(plan, false), ...(budgetLine ? [budgetLine] : [])].join("\n") };
}

const chainOf = (rec: RunRecord | undefined) => (rec ? rec.budget?.chain ?? rec.id : undefined);

/** "Estimated API cost $0.12 for 2 images; limits ...; spent today ...". */
async function budgetPlanLine(project: string, slug: string, plan: Plan, limits: Limits, chain?: string): Promise<string> {
  const { budgetView, chainSpent } = await import("./budget.js");
  const v = await budgetView(project, limits, slug);
  const spentChain = chain ? await chainSpent(project, chain) : 0;
  const grantLeft = v.grants.filter(g => g.active).reduce((a, g) => a + g.remaining, 0);
  const runLeft = Math.max(0, limits.run - spentChain);
  const fits = plan.api.cost <= Math.min(runLeft, v.normalLeft) + 1e-9;
  return `Estimated paid API cost: ${dollars(plan.api.cost)}${plan.api.lowerBound ? " or more" : ""} for ${plan.api.slots} image${plan.api.slots === 1 ? "" : "s"} (${plan.nodes.filter(n => n.cost !== undefined && n.toRun).map(n => `${n.node}: ${n.renderer}`).join("; ")}). ` +
    `Limits: ${dollars(limits.run)} per run${spentChain ? ` (this resume chain has spent ${dollars(spentChain)})` : ""}, ${dollars(limits.day)} per day (spent today ${dollars(v.spentToday)}), ceiling ${dollars(limits.ceiling)}${grantLeft ? `; active grants ${dollars(grantLeft)}` : ""}. ` +
    (fits ? "It fits inside the limits." : `It does not fit inside the limits${grantLeft ? " without the grant" : ""}: the run will stop cleanly, resumable, when the next image would pass one.`);
}

/** After a run stopped at a spend limit, a fresh run on the same graph and day would just get a new
 *  run limit: that is working around the limit. Resume it after the owner grants more instead. */
async function refuseAfterBudgetStop(project: string, dir: string, slug: string) {
  const jobs = await listRecords(dir);
  for (const id of jobs.slice(-5).reverse()) {
    const r = await readRecord(dir, id).catch(() => undefined);
    if (!r) continue;
    if (!r.stopCode?.startsWith("budget-")) { if (TERMINAL.includes(r.status)) return; continue; }
    const { localDay, grantSince } = await import("./budget.js");
    if (localDay(new Date(r.finished ?? r.created)) !== localDay()) return;
    if (await grantSince(project, slug, r.finished ?? r.created)) return;
    throw new StudioError("BUDGET_STOPPED", `Run ${r.id} stopped at a spend limit today (${r.stopReason ?? r.stopCode}). A new run would get a fresh run limit, which is working around it.`,
      `Ask the owner once, with the amount: the remaining work needs about ${dollars(r.budget?.needed ?? 0)}. When they approve in chat, record it with ${grantCmd(slug)}, then ${cmd("run", { graph: slug, resume: true })}. Otherwise wait until tomorrow, or make the work cheaper on the subscription.`);
  }
}

/** The compiled prompt of the first slot of each provider node a run would render, offline. */
async function dryRunPrompts(project: string, dir: string, graph: GraphFile, state: StateFile, plan: Plan) {
  const { previewPrompt } = await import("./execute.js");
  const evals = await evaluate(graph, state, { dir, project });
  const out: Array<{ node: string; slot: string; prompt: string }> = [];
  for (const n of plan.nodes) {
    if (n.work !== "provider" || n.estimate) continue;
    const ev = evals.get(n.node);
    const slot = ev?.slots[0];
    if (!ev || !slot) continue;
    let prompt: string;
    try { prompt = (await previewPrompt({ dir, node: ev.node, slot })) ?? ""; } catch (e) { prompt = `(could not compile: ${e instanceof Error ? e.message : String(e)})`; }
    if (!prompt) continue;
    out.push({ node: n.node, slot: slot.label && slot.label !== n.node ? slot.label : "slot 1", prompt: prompt.length > 1500 ? `${prompt.slice(0, 1500)}…` : prompt });
  }
  return out;
}

/** Nothing in scope can run, and the reason is nodes that need fixing (not that all is current). */
const blockedPlan = (plan: Plan) => !plan.slots && plan.skipped.length > 0;

function planMessage(plan: Plan, dry: boolean): string {
  if (blockedPlan(plan)) {
    return [`Nothing in scope "${plan.scope}" can run until the skipped nodes are fixed${dry ? "" : "; no run was started"}.`,
      ...plan.skipped.map(s => `Skipped ${s.node}: ${s.reason}.${s.fix ? ` Fix: ${s.fix}` : ""}`)].join("\n");
  }
  const gen = `${plan.generations}${plan.generationsEstimate ? "+" : ""} generation${plan.generations === 1 ? "" : "s"}`;
  const local = `${plan.localSteps}${plan.localStepsEstimate ? "+" : ""} local step${plan.localSteps === 1 ? "" : "s"}`;
  const lines = [`${dry ? "Would run" : "Running"} scope "${plan.scope}": ${gen} and ${local}; ${plan.nodes.reduce((a, n) => a + n.cached, 0)} slot(s) reused from cache.`];
  const est = plan.nodes.filter(n => n.estimate);
  if (est.length) lines.push(`"+" means at least: ${est.map(n => `${n.node} (${n.work === "provider" ? "generation" : "local step"})`).join(", ")} wait${est.length === 1 ? "s" : ""} on upstream images this run makes, so ${est.length === 1 ? "its" : "their"} count is known only then.`);
  for (const s of plan.skipped) lines.push(`Skipped ${s.node}: ${s.reason}.${s.fix ? ` Fix: ${s.fix}` : ""}`);
  return lines.join("\n");
}

export async function stopRun(project: string, slug: string, actor: string): Promise<{ job?: string; status: string; message: string }> {
  const dir = graphDir(project, slug);
  const job = await liveJob(dir);
  if (job) {
    await writeFile(join(paths(dir).runs, `${job}.stop`), JSON.stringify({ by: actor, at: now() }));
    return { job, status: "stopping", message: `Asked run ${job} to stop after its current image. Generations already in flight finish and are kept.` };
  }
  const jobs = await listRecords(dir);
  if (!jobs.length) return { status: "none", message: "No run to stop." };
  const rec = await readRecord(dir, jobs.at(-1)!);
  const st = await derivedStatus(dir, rec);
  if (st === "starting" || st === "running") {
    // Live, but its lock body could not be read just now: ask it to stop rather than declare it dead.
    await writeFile(join(paths(dir).runs, `${rec.id}.stop`), JSON.stringify({ by: actor, at: now() }));
    return { job: rec.id, status: "stopping", message: `Asked run ${rec.id} to stop after its current image. Generations already in flight finish and are kept.` };
  }
  if (st === "interrupted") await markInterrupted(dir, rec.id);
  return { job: rec.id, status: st, message: `No live run. Last run ${rec.id} is ${st}.` };
}

async function derivedStatus(dir: string, rec: RunRecord): Promise<RunStatus> {
  if (TERMINAL.includes(rec.status)) return rec.status;
  const l = await readRunLock(dir);
  if (l && l.lock?.job === rec.id && lockLive(l)) return rec.status;
  // A fresh lock whose body cannot be read is not proof the worker died: the heartbeat keeps its
  // mtime fresh while the worker lives, and a dead worker's lock goes stale after RUN_STALE_MS.
  if (l && !l.lock && lockLive(l)) return rec.status;
  // Starting runs get a grace period: the worker may still be loading.
  if (rec.status === "starting" && Date.now() - Date.parse(rec.created) < RUN_STALE_MS && l?.lock?.job === rec.id) return rec.status;
  return "interrupted";
}

// ---------------------------------------------------------------- the worker

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]!); }));
}

export async function runJob(project: string, slug: string, job: string, executors?: Executors): Promise<void> {
  const dir = graphDir(project, slug);
  const execs = executors ?? (await import("./execute.js")).realExecutors;
  const rec = await readRecord(dir, job);
  rec.status = "running"; rec.pid = process.pid; rec.host = hostname(); rec.started = now(); rec.heartbeat = now();
  let queue = Promise.resolve();
  const save = () => (queue = queue.then(() => { rec.heartbeat = now(); return writeRecord(dir, rec); }).catch(() => {}));
  await atomicWrite(paths(dir).runLock, JSON.stringify({ job, pid: process.pid, host: hostname(), actor: "worker", at: now() })).catch(() => {});
  await save();
  const stopFile = join(paths(dir).runs, `${job}.stop`);
  let stop: { reason: string; fix?: string; code?: string } | undefined;
  const beat = setInterval(() => {
    const t = new Date();
    utimes(paths(dir).runLock, t, t).catch(() => {});
    if (existsSync(stopFile)) stop ??= { reason: "Stopped on request.", fix: `Resume with ${cmd("run", { graph: slug, resume: true })}.` };
  }, HEARTBEAT_MS);
  const done = await completedChain(dir, rec);
  const actor = "worker";
  rec.budget ??= { chain: rec.id, limits: { ...DEFAULT_LIMITS }, estimate: 0, spent: 0 };
  const budget = rec.budget;
  const ledger = await import("./budget.js");
  const { costFromUsage, PRICING } = await import("../pricing.js");
  try {
    const initial = (await readBoth(dir)).graph;
    for (const id of topoOrder(initial)) {
      if (existsSync(stopFile)) stop ??= { reason: "Stopped on request.", fix: `Resume with ${cmd("run", { graph: slug, resume: true })}.` };
      if (stop) break;
      const { graph, state } = await readBoth(dir);
      if (!scopeSet(graph, rec.scope).has(id)) continue;
      const node = graph.nodes.find(n => n.id === id);
      if (!node) continue;
      if (node.type === "reference") { await refreshReference(project, dir, id, job); continue; }
      if (node.type === "canon") { await refreshCanon(project, dir, id, job); continue; }
      if (workOf(node.type, node.settings) === "none") continue;
      const evals = await evaluate(graph, state, { dir, project, liveJob: job });
      const ev = evals.get(id)!;
      if (ev.issues.length || ev.blockedBy) {
        rec.skipped.push({ node: id, reason: ev.issues[0] ? `${ev.issues[0].message}${ev.issues[0].fix ? `. ${ev.issues[0].fix}` : ""}` : `waiting for ${ev.blockedBy}, which has no output` });
        await clearActivity(dir, job, id, "skipped");
        await save();
        continue;
      }
      const todo = slotsToRun(ev, state.nodes[id], rec.newTake, done);
      rec.progress.slotsCached += ev.slots.length - todo.length;
      if (!todo.length) { await clearActivity(dir, job, id, "cached"); await save(); continue; }
      await mutate(dir, actor, (_g, s) => {
        nodeState(s, id).activity = { job, status: "running", at: now() };
        return { result: null, events: [{ type: "node.started", job, node: id, slots: todo.length }] };
      });
      const kind = node.type as ExecutorKind;
      await pool(todo, rec.concurrency, async slot => {
        if (stop) return;
        // Paid slots: check the limits and reserve the estimate before the request, atomically
        // across every run and process in this project.
        let held: { id: string; funding: string; estimate: number } | undefined;
        if (slot.render?.renderer === "api") {
          const estimate = slotEstimate(slot);
          let r: Awaited<ReturnType<typeof ledger.reserve>>;
          try {
            r = await ledger.reserve({ project, run: job, chain: budget.chain, graph: slug, node: id, slot: slotKey(id, slot), estimate, model: slot.render.model, limits: budget.limits, actor: `worker ${job}` });
          } catch (e) {
            // A ledger or user config that cannot be read fails closed: nothing is sent.
            stop ??= { reason: e instanceof Error ? e.message : String(e), fix: e instanceof StudioError && e.fix ? `${e.fix} Then ${cmd("run", { graph: slug, resume: true })}.` : undefined };
            return;
          }
          if (!r.ok) {
            stop ??= { reason: r.message, code: r.code };
            return;
          }
          held = { id: r.id, funding: r.funding, estimate };
        }
        const takeId = await reserveTake(dir);
        rec.progress.current = { node: id, slot: slot.index, variant: slot.variant };
        save();
        try {
          const work = () => execs[kind]({ project, dir, graph, state, evals, node, slot, takeId, outBase: join(paths(dir).assets, `${id}-${takeId}`) });
          // A reserved slot's request is already in the ledger; anything else paid inside it is not.
          const res = held ? await managedSpend(work) : await work();
          let cost: Take["cost"] | undefined;
          if (held) {
            const known = res.usage ? costFromUsage(slot.render!.model, res.usage) : undefined;
            cost = { dollars: known ?? held.estimate, estimate: held.estimate, rates: `pricing.ts ${PRICING.checked}`, funding: held.funding };
            await ledger.settle(project, `worker ${job}`, { id: held.id, cost: cost.dollars, take: `${id}/${takeId}`, ...(known === undefined ? { uncertain: true, note: "the API reported no usage; kept at the estimate" } : {}) });
            budget.spent = Math.round((budget.spent + cost.dollars) * 1e6) / 1e6;
            held = undefined;
          }
          const take = await saveTake(dir, graph.revision, id, slot, takeId, res, job, node.settings, cost, node.type);
          done.add(slotKey(id, slot));
          rec.completed.push(slotKey(id, slot));
          rec.takes.push({ node: id, take: take.id, asset: take.asset });
          rec.progress.slotsDone++;
          rec.progress.generations += res.generations;
        } catch (e) {
          if (held) {
            // An HTTP refusal is not billed; anything else (network loss mid-request) may have been.
            const refused = /HTTP [45]\d\d/.test(e instanceof Error ? e.message : String(e)) || /No request was sent/.test(String(e));
            await ledger.settle(project, `worker ${job}`, { id: held.id, cost: refused ? 0 : held.estimate, ...(refused ? { note: "request refused; not billed" } : { uncertain: true, note: "request failed; kept at the estimate in case it was billed" }) }).catch(() => {});
            if (!refused) budget.spent = Math.round((budget.spent + held.estimate) * 1e6) / 1e6;
          }
          const c = classifyError(e, slug, slot.render?.renderer === "api");
          if (c.kind !== "node") stop ??= { reason: c.message, fix: c.fix };
          else {
            rec.progress.slotsFailed++;
            rec.errors.push({ node: id, message: c.message, fix: c.fix });
            await mutate(dir, actor, (_g, s) => {
              nodeState(s, id).error = { message: c.message, fix: c.fix, at: now(), job };
              return { result: null, events: [{ type: "node.failed", job, node: id, slot: slot.index, error: c.message.slice(0, 500) }] };
            }).catch(() => {});
          }
        }
        delete rec.progress.current;
        save();
      });
      await clearActivity(dir, job, id, stop ? "stopped" : "finished");
    }
    await writeRunSheet(dir, rec).catch(e => rec.errors.push({ node: "(sheet)", message: `Review sheet failed: ${e instanceof Error ? e.message : e}`, fix: `Use ${cmd("view", { graph: slug })} instead.` }));
    rec.status = stop ? "stopped" : rec.errors.length ? "done_with_errors" : "done";
    if (stop?.code) {
      // A spend stop: say what the rest needs and that the owner decides, once.
      const fresh = await readBoth(dir);
      const left = await planRun(project, dir, fresh.graph, fresh.state, rec.scope, rec.newTake, done).catch(() => undefined);
      budget.needed = left?.api.cost ?? 0;
      stop.fix = `The remaining paid work needs about ${dollars(budget.needed)}${left?.api.lowerBound ? " or more" : ""}. Ask the owner once, with that amount; do not work around the limit (no new run, no other renderer). ` +
        (stop.code === "budget-ceiling" ? "The ceiling can only be raised by the owner editing studio.limits.ceiling in .gptimage.json." :
         stop.code === "budget-user-ceiling" ? "The user-level ceiling (all projects) can only be raised by the owner, in ~/.gptimage/config.json; no grant lifts it." : `When the owner approves in chat, record a grant with ${grantCmd(slug)}, then ${cmd("run", { graph: slug, resume: true })}; finished slots are kept.`);
      // A limit the run lowered for itself is the agent's own caution, not the owner's limit.
      const own = studioProfile(dir).limits;
      const self = stop.code === "budget-run" ? budget.limits.run < own.run - 1e-9 : stop.code === "budget-day" ? budget.limits.day < own.day - 1e-9 : false;
      if (self) stop.fix = `This run's ${stop.code === "budget-run" ? "run" : "day"} limit was lowered to ${dollars(stop.code === "budget-run" ? budget.limits.run : budget.limits.day)} for this run only. The remaining paid work needs about ${dollars(budget.needed)}. ` +
        `If that is fine, ${cmd("run", { graph: slug, resume: true })} continues under the project's limits (${dollars(own.run)} per run, counted across the resume chain; ${dollars(own.day)} per day); otherwise stop here.`;
      rec.stopCode = stop.code;
    }
    if (stop) { rec.stopReason = stop.reason; rec.stopFix = stop.fix; }
  } catch (e) {
    rec.status = "failed";
    rec.errors.push({ node: "(run)", message: e instanceof Error ? e.message : String(e), fix: "This is a Studio bug or a file problem; the run log is in runs/<job>.log." });
  } finally {
    clearInterval(beat);
    rec.finished = now();
    delete rec.progress.current;
    budget.chainSpent = await ledger.chainSpent(project, budget.chain).catch(() => budget.spent);
    await save();
    await queue;
    await mutate(dir, actor, (_g, s) => {
      for (const ns of Object.values(s.nodes)) if (ns.activity?.job === job) delete ns.activity;
      return { result: null, events: [{ type: "run.finished", job, status: rec.status, generations: rec.progress.generations, takes: rec.takes.length, errors: rec.errors.length, stopReason: rec.stopReason, ...(rec.stopCode ? { stopCode: rec.stopCode } : {}), ...(budget.spent || budget.estimate ? { cost: budget.spent } : {}) }] };
    }).catch(() => {});
    await unlink(stopFile).catch(() => {});
    await releaseRunLock(dir, job);
  }
}

/** One labelled review sheet of the run's new images, so the run result can point at a single file. */
async function writeRunSheet(dir: string, rec: RunRecord) {
  const { state } = await readBoth(dir);
  const takes = rec.takes.map(t => ({ ref: t, take: state.nodes[t.node]?.takes.find(x => x.id === t.take) })).filter(x => x.take?.kind === "image").slice(-30);
  if (!takes.length) return;
  const craft = await import("./craft.js");
  const diffs = craft.differingSettings(takes.map(x => x.take!));
  const out = join(paths(dir).views, `run-${rec.id}.png`);
  await craft.reviewSheet(takes.map((x, i) => ({
    path: resolve(dir, x.take!.asset), reading: x.take!.reading,
    title: `${x.ref.node}/${x.ref.take}${x.take!.deviations?.length ? "  ⚠ " + x.take!.deviations.map(d => d.measure).join(",") : ""}`,
    detail: diffs[i]!.join(" · ") || x.take!.text?.item || "",
  })), out, ["palette"], `Run ${rec.id}`);
  rec.sheet = assetRel(dir, out);
}

async function clearActivity(dir: string, job: string, node: string, outcome: string) {
  await mutate(dir, "worker", (_g, s) => {
    const ns = s.nodes[node];
    if (ns?.activity?.job === job) delete ns.activity;
    return { result: null, events: outcome === "finished" || outcome === "stopped" ? [{ type: "node.finished", job, node, outcome }] : [{ type: `node.${outcome}`, job, node }] };
  });
}

async function reserveTake(dir: string): Promise<string> {
  return (await mutate(dir, "worker", (_g, s) => ({ result: `t${s.nextTake++}` }))).result;
}

/** Re-import a canon node's entry when it was replaced (a quick copy of at most 8 files). */
async function refreshCanon(project: string, dir: string, id: string, job: string) {
  const { importCanon } = await import("./canon.js");
  await mutate(dir, "worker", async (g, s) => {
    const node = g.nodes.find(n => n.id === id);
    const events: EventInput[] = [];
    if (node) for (const t of await importCanon(g, s, project, dir, node, job).catch(() => [])) events.push({ type: "take.saved", job, node: id, take: t.id, asset: t.asset });
    return { result: null, events };
  });
}

/** Re-import a reference whose file changed. Hashing and reading happen before the lock; the
 *  common case (file unchanged, reading present) takes no lock at all. */
async function refreshReference(project: string, dir: string, id: string, job: string) {
  const before = await readBoth(dir);
  const node0 = before.graph.nodes.find(n => n.id === id);
  if (!node0 || typeof node0.settings.path !== "string") return;
  const src = resolve(project, node0.settings.path);
  if (!existsSync(src)) return;
  const { sha256 } = await fileSha(src);
  const known = before.state.nodes[id]?.takes.find(t => t.sha256 === sha256);
  if (known?.reading && before.state.nodes[id]?.selected?.[0] === known.id) return;
  const { readingOf } = await import("./craft.js");
  const reading = await readingOf(src);
  await mutate(dir, "worker", async (g, s) => {
    const node = g.nodes.find(n => n.id === id);
    const events: EventInput[] = [];
    if (node && node.settings.path === node0.settings.path && existsSync(src)) {
      const t = await importReference(g, s, project, dir, node, job);
      if (t) { t.reading = reading; events.push({ type: "take.saved", job, node: id, take: t.id, asset: t.asset }); }
      const same = s.nodes[id]?.takes.find(x => x.sha256 === sha256);
      if (same && !same.reading && reading) same.reading = reading;
    }
    return { result: null, events };
  });
}

async function saveTake(dir: string, graphRevision: number, nodeId: string, slot: Slot, takeId: string, res: ExecOutput, job: string, settings: Record<string, unknown>, cost?: Take["cost"], nodeType?: string): Promise<Take> {
  const buf = await readFile(res.path);
  const { createHash } = await import("node:crypto");
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const kind = res.kind ?? "image";
  let width: number | undefined, height: number | undefined;
  if (kind === "image") {
    const { imageSize } = await import("../imageinfo.js");
    const d = imageSize(buf);
    width = d?.width; height = d?.height;
  }
  const take: Take = {
    id: takeId, kind, slot: slot.index, variant: slot.variant, fingerprint: slot.fingerprint, asset: assetRel(dir, res.path), sha256, bytes: buf.length, width, height,
    created: now(), job, graphRevision, inputs: slot.inputs,
    text: slot.text || res.compiledPrompt ? { prompt: slot.text, item: slot.item, compiledPrompt: res.compiledPrompt, revisedPrompt: res.revisedPrompt } : undefined,
    settings: { ...settings, ...(slot.look ?? {}) },
    files: res.files?.map(f => assetRel(dir, resolve(f))), generations: res.generations, warnings: res.warnings?.length ? res.warnings : undefined,
    // Provider takes record their renderer; API takes also their usage and cost.
    render: slot.render ?? (res.generations > 0 ? SUBSCRIPTION_RENDER : undefined),
    usage: res.usage, cost,
  };
  if (slot.screenshot) take.source = slot.screenshot.rel;
  const craft = await import("./craft.js");
  if (kind === "image") {
    take.reading = await craft.readingOf(res.path);
    const kindOf = nodeType === "finish" ? "finish" : (settings as any).op ? "process" : slot.image ? "edit" : "generate";
    if (kindOf !== "process" && kindOf !== "finish") take.checklist = craft.briefChecklist(slot.text, slot.look, settings as Record<string, any>, kindOf === "edit" ? "edit" : "generate");
  }
  if (take.reading) {
    // Outside the graph lock: an anchor's reading never changes once saved.
    const anchorIn = take.inputs.find(i => i.take && (i.handle === "image" || i.handle === "references"));
    const anchor = anchorIn ? (await readBoth(dir)).state.nodes[anchorIn.node]?.takes.find(t => t.id === anchorIn.take) : undefined;
    const devs = [...craft.requestDeviations(take.reading, craft.requestText(take)), ...(anchorIn ? await craft.anchorDeviations(take.reading, anchor?.reading, `${anchorIn.node}/${anchorIn.take}`) : [])];
    if (devs.length) take.deviations = devs;
    // Optional perception pack. Never required; a failure is a warning on the take.
    const perception = await import("./perception.js");
    const jobs: Array<[string, () => Promise<Record<string, unknown> & { version: number; source: string }>]> = [];
    if (anchorIn && anchor?.kind === "image" && perception.perceptionInstalled("similarity")) jobs.push(["similarity", () => perception.similarityReading(res.path, resolve(dir, anchor.asset), `${anchorIn.node}/${anchorIn.take}`)]);
    if (perception.perceptionInstalled("mask")) jobs.push(["mask", () => perception.maskReading(res.path)]);
    for (const [cap, run] of jobs) {
      try { const reading = await run(); (take.perception ??= {})[cap] = reading; } catch (e) {
        take.warnings = [...(take.warnings ?? []), `Perception (${cap}) failed: ${e instanceof Error ? e.message : String(e)}`];
      }
    }
  }
  for (const k of Object.keys(take) as (keyof Take)[]) if (take[k] === undefined) delete take[k];
  await mutate(dir, "worker", (_g, s) => {
    const ns = nodeState(s, nodeId);
    ns.takes.push(take);
    // A new take supersedes explicit picks at the same slot position.
    const samePos = new Set(ns.takes.filter(t => t.slot === slot.index && t.variant === slot.variant).map(t => t.id));
    ns.selected = ns.selected.filter(x => !samePos.has(x));
    delete ns.error;
    return { result: null, events: [{ type: "take.saved", job, node: nodeId, take: take.id, asset: take.asset, slot: slot.index, variant: slot.variant, ...(cost ? { cost: cost.dollars, funding: cost.funding } : {}) }] };
  });
  return take;
}

// ---------------------------------------------------------------- status

export interface StatusResult {
  job?: string;
  status: RunStatus | "none";
  record?: RunRecord;
  waitedMs: number;
}

export async function runStatus(project: string, slug: string, job?: string, waitSeconds = 0): Promise<StatusResult> {
  const dir = graphDir(project, slug);
  const started = Date.now();
  const id = job ?? (await listRecords(dir)).at(-1);
  if (!id) return { status: "none", waitedMs: 0 };
  const deadline = started + Math.max(0, Math.min(30, waitSeconds)) * 1000;
  for (;;) {
    let rec: RunRecord;
    try { rec = await readRecord(dir, id); } catch { throw new StudioError("NO_JOB", `No run ${id} in graph ${slug}.`, "Omit job to see the latest run."); }
    const status = await derivedStatus(dir, rec);
    if (TERMINAL.includes(status) || Date.now() >= deadline) return { job: id, status, record: { ...rec, status }, waitedMs: Date.now() - started };
    await sleep(500);
  }
}

export { NODE_SPECS };
export type { NodeEval };
