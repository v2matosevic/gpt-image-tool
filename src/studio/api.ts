// The Studio library surface. MCP tools and the CLI are thin wrappers over these functions, so every
// mutation and run is reachable from outside the MCP process (ADE calls the CLI).

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { applyOps, buildGraph, type OpContext } from "./graph.js";
import { nodeDetail, snapshot } from "./snapshot.js";
import { StudioError, createGraphFiles, emptyState, graphDir, listGraphSlugs, mutate, now, paths, readBoth, readGraph, readJson, resolveProject, slugify, checkSlug, toPosix } from "./store.js";
import { listRecords, readRecord, runStatus, startRun, stopRun, type RunRequest } from "./runner.js";
import { evaluate } from "./evaluate.js";
import { GRAPH_SCHEMA, type GraphFile, type RunRecord, type Take } from "./types.js";

export interface Who { project?: string; actor?: string; human?: boolean }
const actorOf = (w: Who) => w.actor?.trim() || process.env.GPT_IMAGE_STUDIO_ACTOR?.trim() || "agent";

export async function listGraphs(w: Who = {}) {
  const project = resolveProject(w.project);
  const graphs = [];
  for (const slug of await listGraphSlugs(project)) {
    const dir = graphDir(project, slug);
    try {
      const g = await readGraph(dir);
      const jobs = await listRecords(dir);
      const last = jobs.length ? await readRecord(dir, jobs.at(-1)!).catch(() => undefined) : undefined;
      graphs.push({ slug, name: g.name, revision: g.revision, nodes: g.nodes.length, updated: g.updated, lastRun: last ? { job: last.id, status: last.status, finished: last.finished } : undefined, path: dir });
    } catch (e) {
      graphs.push({ slug, error: e instanceof Error ? e.message : String(e), path: dir });
    }
  }
  return { project, graphs };
}

export interface CreateInput {
  name: string;
  slug?: string;
  nodes?: unknown[];
  connections?: unknown[];
  groups?: unknown[];
  /** Copy another graph's definition, possibly from another project. References are copied in. */
  copy_from?: { project?: string; graph: string };
}

async function copyOps(input: CreateInput["copy_from"]) {
  const srcProject = resolveProject(input!.project);
  const g = await readGraph(graphDir(srcProject, input!.graph));
  const nodes = g.nodes.map(n => {
    const settings = { ...n.settings };
    if (n.type === "reference" && typeof settings.path === "string") settings.path = resolve(srcProject, settings.path);
    if (n.type === "implementation" && typeof settings.screenshot === "string") settings.screenshot = resolve(srcProject, settings.screenshot);
    return { id: n.id, type: n.type, settings, label: n.label, group: n.group, position: n.position?.pinned ? n.position : undefined };
  });
  return { nodes, connections: g.edges.map(e => ({ from: e.from, to: e.to, to_handle: e.toHandle, from_handle: e.fromHandle })), groups: g.groups, source: `${srcProject} :: ${input!.graph}` };
}

export async function createGraph(input: CreateInput, w: Who = {}) {
  const project = resolveProject(w.project);
  const actor = actorOf(w);
  if (!input?.name?.trim()) throw new StudioError("BAD_INPUT", "A graph needs a name.", 'studio_create {name:"Landing hero", nodes:[...]}');
  const slug = checkSlug(input.slug?.trim() || slugify(input.name));
  const dir = graphDir(project, slug);
  if (existsSync(paths(dir).graph)) throw new StudioError("GRAPH_EXISTS", `Graph "${slug}" already exists in ${project}.`, `Change it with studio_edit {graph:"${slug}"}, or pass another slug.`);
  const ts = now();
  const graph: GraphFile = { schema: GRAPH_SCHEMA, name: input.name.trim().slice(0, 200), slug, revision: 1, created: ts, updated: ts, nodes: [], edges: [], groups: [] };
  const state = emptyState();
  const ctx: OpContext = { project, dir, actor, events: [], feedback: [], notes: [] };
  let source: string | undefined;
  const body = input.copy_from ? await copyOps(input.copy_from) : input;
  if (input.copy_from) source = (body as any).source;
  await buildGraph(graph, state, body, ctx);
  state.eventSeq = 1;
  state.revision = 1;
  await createGraphFiles(dir, graph, state, actor);
  await writeFile(paths(dir).events, JSON.stringify({ seq: 1, ts, type: "graph.created", actor, graphRevision: 1, nodes: graph.nodes.length, copiedFrom: source }) + "\n");
  const snap = await snapshot(project, dir, graph, state);
  return { project, slug, dir, revision: graph.revision, notes: ctx.notes, copiedFrom: source, snapshot: snap.text };
}

export async function editGraph(slug: string, ops: unknown[], opts: Who & { expectRevision?: number } = {}) {
  const project = resolveProject(opts.project);
  const dir = graphDir(project, slug);
  const actor = actorOf(opts);
  const ctx: OpContext = { project, dir, actor, events: [], feedback: [], notes: [], human: opts.human };
  const res = await mutate(dir, actor, async (graph, state) => {
    if (opts.expectRevision !== undefined && graph.revision !== opts.expectRevision) {
      throw new StudioError("STALE_REVISION", `Graph "${slug}" is at revision ${graph.revision}, not ${opts.expectRevision}; someone else changed it.`,
        "Re-read it with studio_get and resend your ops, or omit expect_revision to apply them to the latest version.");
    }
    const applied = await applyOps(graph, state, ops, ctx);
    ctx.events.push({ type: "ops.applied", count: applied.length, summary: applied.slice(0, 20) });
    return { result: applied, events: ctx.events, feedback: ctx.feedback };
  });
  const { graph, state } = await readBoth(dir);
  const snap = await snapshot(project, dir, graph, state);
  return { project, slug, revision: res.revision, stateRevision: res.stateRevision, applied: res.result, notes: ctx.notes, snapshot: snap.text };
}

export async function getGraph(slug: string, opts: Who & { node?: string; raw?: boolean } = {}) {
  const project = resolveProject(opts.project);
  const dir = graphDir(project, slug);
  const { graph, state } = await readBoth(dir);
  if (opts.raw) return { project, slug, dir, graph, state };
  if (opts.node) {
    if (!graph.nodes.some(n => n.id === opts.node)) {
      const { findNode } = await import("./graph.js");
      findNode(graph, opts.node);
    }
    return { project, slug, revision: graph.revision, node: await nodeDetail(project, dir, graph, state, opts.node) };
  }
  const snap = await snapshot(project, dir, graph, state);
  return { project, slug, revision: graph.revision, snapshot: snap.text };
}

export interface RunInput extends Omit<RunRequest, "actor"> { stop?: boolean; waitSeconds?: number }

export async function runGraph(slug: string, input: RunInput, w: Who = {}) {
  const project = resolveProject(w.project);
  const actor = actorOf(w);
  if (input.stop) return { project, slug, ...(await stopRun(project, slug, actor)) };
  const started = await startRun(project, slug, { ...input, actor });
  if (!started.job || !input.waitSeconds || input.detach === false) return { project, slug, ...started };
  const st = await statusReport(slug, { ...w, job: started.job, waitSeconds: input.waitSeconds });
  return { project, slug, ...started, status: st.status, report: st };
}

export async function statusReport(slug: string, opts: Who & { job?: string; waitSeconds?: number } = {}) {
  const project = resolveProject(opts.project);
  const dir = graphDir(project, slug);
  const st = await runStatus(project, slug, opts.job, opts.waitSeconds ?? 0);
  if (!st.record) return { project, slug, status: st.status, text: "No runs yet. Start one with studio_run." };
  return { project, slug, job: st.job, status: st.status, waitedMs: st.waitedMs, ...(await summarize(dir, st.record)) };
}

async function summarize(dir: string, rec: RunRecord) {
  const lines: string[] = [];
  const p = rec.progress;
  lines.push(`Run ${rec.id} (${rec.scope.kind === "all" ? "all" : rec.scope.nodes.join(",") + (rec.scope.kind === "downstream" ? "+" : "")}): ${rec.status}. ${p.slotsDone}/${rec.planned.slots}${rec.planned.estimate ? "+" : ""} slots done, ${p.slotsCached} reused, ${p.slotsFailed} failed, ${p.generations} generation(s).`);
  if (p.current) lines.push(`Working on ${p.current.node} slot ${p.current.slot + 1}.`);
  if (rec.stopReason) lines.push(`Stopped: ${rec.stopReason}${rec.stopFix ? ` Fix: ${rec.stopFix}` : ""}`);
  for (const e of rec.errors.slice(0, 5)) lines.push(`Error in ${e.node}: ${e.message.slice(0, 300)}${e.fix ? ` Fix: ${e.fix}` : ""}`);
  for (const s of rec.skipped.slice(0, 5)) lines.push(`Skipped ${s.node}: ${s.reason}`);
  if (rec.takes.length) {
    const { state } = await readBoth(dir);
    const { summaryOf } = await import("./craft.js");
    const shown = rec.takes.slice(-24).map(t => ({ ref: `${t.node}/${t.take}`, path: resolve(dir, t.asset), take: state.nodes[t.node]?.takes.find(x => x.id === t.take) }));
    if (rec.sheet) lines.push(`Review sheet (open this first; labels show what differs): ${resolve(dir, rec.sheet)}`);
    const devs = shown.filter(x => x.take?.deviations?.length);
    if (devs.length) {
      lines.push("Deviations (measured; confirm them when you look):");
      for (const x of devs) lines.push(`  ${x.ref}: ${x.take!.deviations!.map(d => `${d.note}, expected ${d.expected}, measured ${d.measured}`).join("; ")}`);
    }
    lines.push("New takes:");
    for (const x of shown) {
      lines.push(`  ${x.ref}  ${x.path}`);
      if (x.take?.reading) lines.push(`    reads: ${await summaryOf(x.take.reading)}`);
    }
    const byNode = new Map<string, string>();
    for (const x of shown) if (x.take?.checklist?.length) byNode.set(x.ref.split("/")[0]!, x.take.checklist.map(c => `${c.id} ${c.question}`).join(" | "));
    for (const [node, list] of byNode) lines.push(`Checklist for each ${node} take (answer with {op:"answer", take, answers:{c1:"yes", ...}} before approving): ${list}`);
  }
  if (["starting", "running"].includes(rec.status)) lines.push(`Still running. Call studio_status {graph:"${rec.graph}", job:"${rec.id}"} again; it waits up to 30s.`);
  else if (rec.status === "interrupted" || rec.status === "stopped") lines.push(`Resume with studio_run {graph:"${rec.graph}", resume:true}; finished slots are kept.`);
  return { text: lines.join("\n"), record: rec, takes: rec.takes.map(t => ({ ref: `${t.node}/${t.take}`, path: resolve(dir, t.asset) })) };
}

// ---------------------------------------------------------------- view

export async function ensurePreview(dir: string, rel: string, size = 384): Promise<string | null> {
  const src = resolve(dir, rel);
  const out = join(paths(dir).previews, `${toPosix(rel).replace(/[^a-z0-9.-]+/gi, "_")}-${size}.png`);
  if (existsSync(out)) return out;
  try {
    const { decodeRGBA, resizeRGBA } = await import("../imageops.js");
    const { encodePng } = await import("../bgremove.js");
    const img = await decodeRGBA(await readFile(src));
    const scale = Math.min(1, size / Math.max(img.width, img.height));
    const small = scale < 1 ? resizeRGBA(img, Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale))) : img;
    await mkdir(paths(dir).previews, { recursive: true });
    await writeFile(out, encodePng(small));
    return out;
  } catch { return null; }
}

export async function viewGraph(slug: string, opts: Who & { nodes?: string[]; allTakes?: boolean; overlays?: Array<"grid" | "palette" | "histogram"> } = {}) {
  const project = resolveProject(opts.project);
  const dir = graphDir(project, slug);
  const { graph, state } = await readBoth(dir);
  const evals = await evaluate(graph, state, { dir, project });
  const wanted = opts.nodes?.length ? opts.nodes : graph.nodes.filter(n => !["prompt", "style", "list", "note", "handoff"].includes(n.type)).map(n => n.id);
  const items: Array<{ ref: string; path: string; label: string; preview?: string; verdict?: string; status: string; take: Take }> = [];
  for (const id of wanted) {
    const ev = evals.get(id);
    if (!ev) { const { findNode } = await import("./graph.js"); findNode(graph, id, "nodes"); continue; }
    if (ev.node.type === "gallery") continue;
    const ns = state.nodes[id];
    const takes = opts.allTakes ? (ns?.takes ?? []).map(t => ({ take: t, label: `${id}/${t.id}`, status: "take" }))
      : ev.views.filter(v => v.take).map(v => ({ take: v.take!, label: `${id}/${v.take!.id} ${v.slot.label !== id ? v.slot.label : ""}`.trim(), status: v.status }));
    for (const { take, label, status } of takes) {
      if (take.kind !== "image") continue;
      const path = resolve(dir, take.asset);
      if (!existsSync(path)) continue;
      items.push({ ref: `${id}/${take.id}`, path, label: `${label}${take.verdict ? ` ${take.verdict.decision}` : ""}`, verdict: take.verdict?.decision, status, take, preview: (await ensurePreview(dir, take.asset)) ?? undefined });
    }
  }
  if (!items.length) return { project, slug, sheet: undefined, images: [], text: "No images yet. Run the graph first (studio_run)." };
  let sheet: string | undefined;
  const shown = items.slice(-30);
  const notes: string[] = [];
  try {
    const craft = await import("./craft.js");
    await mkdir(paths(dir).views, { recursive: true });
    const diffs = craft.differingSettings(shown.map(i => i.take));
    sheet = await craft.reviewSheet(shown.map((i, k) => ({
      path: i.path, reading: i.take.reading,
      title: `${i.ref}${i.verdict ? ` ${i.verdict}` : ""}${i.status === "stale" ? " (stale)" : ""}${i.take.deviations?.length ? `  ⚠ ${i.take.deviations.map(d => d.measure).join(",")}` : ""}`,
      detail: diffs[k]!.join(" · ") || i.take.text?.item || "",
    })), join(paths(dir).views, `sheet-${now().replace(/[:.]/g, "-")}.png`), opts.overlays ?? ["palette"], `${graph.name ?? slug}`);
  } catch (e) {
    notes.push(`No contact sheet (${e instanceof Error ? e.message : e}); open the preview paths instead.`);
  }
  if (items.length > 30) notes.push(`Showing the last 30 of ${items.length} images; pass nodes to narrow it.`);
  const text = [sheet ? `Review sheet (open this first): ${sheet}` : "", "Images (ref, label, preview path, full path):",
    ...items.map(i => `  ${i.ref}  ${i.label}${i.status === "stale" ? " (stale)" : ""}\n    preview ${i.preview ?? "(none)"}\n    full    ${i.path}`), ...notes].filter(Boolean).join("\n");
  return { project, slug, sheet, images: items, text };
}

/** Look closer: a full-resolution region of one take, or a blind A/B pair of two takes. */
export async function lookCloser(slug: string, opts: Who & { zoom?: { take: string; region: string | [number, number, number, number] }; pair?: [string, string] }) {
  const project = resolveProject(opts.project);
  const dir = graphDir(project, slug);
  const { graph, state } = await readBoth(dir);
  const { parseTakeRef } = await import("./graph.js");
  const craft = await import("./craft.js");
  const lines: string[] = [];
  if (opts.zoom) {
    const { node, take } = parseTakeRef(graph, state, opts.zoom.take, "zoom.take");
    if (take.kind !== "image") throw new StudioError("NOT_IMAGE", `${node.id}/${take.id} is a package, not an image.`, "Zoom into an image take.");
    const name = typeof opts.zoom.region === "string" ? opts.zoom.region : opts.zoom.region.join("_");
    try {
      const z = await craft.zoomRegion(resolve(dir, take.asset), opts.zoom.region, join(paths(dir).views, `zoom-${node.id}-${take.id}-${name.replace(/[^a-z0-9_.-]/gi, "")}.png`));
      lines.push(`Zoom of ${node.id}/${take.id} ${name} at full resolution (box ${z.box.join(",")}): ${z.path}`);
    } catch (e) {
      throw new StudioError("BAD_REGION", e instanceof Error ? e.message : String(e), 'Example: {zoom:{take:"gen/t3", region:"bottom-right"}} or region:[0.4,0.5,0.2,0.2].');
    }
  }
  if (opts.pair) {
    if (opts.pair.length !== 2) throw new StudioError("BAD_PAIR", "pair needs exactly two takes.", 'Example: {pair:["gen/t3","gen/t5"]}.');
    const [a, b] = opts.pair.map((r, i) => { const x = parseTakeRef(graph, state, r, `pair[${i}]`); return { ref: `${x.node.id}/${x.take.id}`, path: resolve(dir, x.take.asset), kind: x.take.kind }; });
    if (a!.kind !== "image" || b!.kind !== "image" || a!.ref === b!.ref) throw new StudioError("BAD_PAIR", "pair needs two different image takes.", 'Example: {pair:["gen/t3","gen/t5"]}.');
    const p = await craft.blindPair(dir, a!, b!);
    lines.push(`Blind pair ${p.id}: ${p.sheet}`, "A and B are in random order and the sheet does not say which is which. Look, decide for the stated intent, then record it:",
      `  studio_edit {graph:"${slug}", ops:[{op:"judge_pair", pair:"${p.id}", preferred:"A", reason:"..."}]}`);
  }
  if (!lines.length) throw new StudioError("BAD_VIEW", "Nothing to look at.", "Pass zoom or pair.");
  return lines.join("\n");
}

/** Start the read-only viewer as a detached process and return its URL. It exits by itself after
 *  idleMinutes without requests, so an agent never leaves a server running indefinitely. */
export async function serveDetached(slug: string | undefined, w: Who & { idleMinutes?: number } = {}): Promise<{ url: string; pid?: number; idleMinutes: number }> {
  const project = resolveProject(w.project);
  const { spawn } = await import("node:child_process");
  const { workerScript } = await import("./runner.js");
  const idle = w.idleMinutes ?? 30;
  const child = spawn(process.execPath, [workerScript(), "studio", "view", ...(slug ? [slug] : []), "--project", project, "--idle-exit", String(idle)], {
    detached: true, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, cwd: project,
  });
  const url = await new Promise<string>((res, rej) => {
    let buf = "";
    const t = setTimeout(() => rej(new StudioError("VIEWER", "The viewer did not start within 20 seconds.", `Run it yourself: gpt-image studio view --project "${project}"`)), 20_000);
    child.stdout!.on("data", d => { buf += d; const m = /http:\/\/127\.0\.0\.1:\d+\/\S*/.exec(buf); if (m) { clearTimeout(t); res(m[0]); } });
    child.on("exit", code => { clearTimeout(t); rej(new StudioError("VIEWER", `The viewer exited (${code}).`, `Run it yourself: gpt-image studio view --project "${project}"`)); });
  });
  child.stdout!.destroy();
  child.unref();
  return { url, pid: child.pid, idleMinutes: idle };
}

export async function readRunRecord(slug: string, job: string, w: Who = {}) {
  const project = resolveProject(w.project);
  return readJson<RunRecord>(join(paths(graphDir(project, slug)).runs, `${job}.json`));
}
