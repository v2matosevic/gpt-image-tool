// Studio storage: project/graph paths, the cross-process graph lock, atomic writes, the revision
// counter and the event log. Every writer (MCP server, CLI, detached run worker, ADE through the
// CLI) goes through mutate(), so two processes never interleave a read-modify-write.

import { existsSync, statSync } from "node:fs";
import { appendFile, link, mkdir, open, readFile, readdir, rename, stat, unlink, utimes } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { GRAPH_SCHEMA, STATE_SCHEMA, type GraphFile, type GraphNode, type Issue, type StateFile, type StudioEvent } from "./types.js";
import { tool } from "./say.js";

export class StudioError extends Error {
  constructor(public code: string, message: string, public fix?: string, public issues?: Issue[]) {
    super(message);
  }
}

/** A refusal as text, the same for MCP and the CLI: the message, then every issue with its own
 *  fix (or the single fix when there are no issues). */
export function refusalText(e: StudioError): string {
  const issues = e.issues ?? [];
  if (!issues.length) return `${e.message}${e.fix ? `\nFix: ${e.fix}` : ""}`;
  return [e.message, ...issues.map(i => `- ${i.path ? `${i.path}: ` : ""}${i.message}.${i.fix ? ` Fix: ${i.fix}` : ""}`)].join("\n");
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export const now = () => new Date().toISOString();
export const toPosix = (p: string) => p.split(sep).join("/");

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function slugify(name: string): string {
  const s = name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return s || "graph";
}

export function checkSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) throw new StudioError("BAD_SLUG", `Invalid graph slug "${slug}".`, "Use lowercase letters, digits and hyphens, starting with a letter or digit (max 64), e.g. \"landing-hero\".");
  return slug;
}

/** The project a call works in: explicit, then GPT_IMAGE_PROJECT_DIR, CLAUDE_PROJECT_DIR, cwd. */
export function resolveProject(project?: string): string {
  const p = project?.trim() || process.env.GPT_IMAGE_PROJECT_DIR?.trim() || process.env.CLAUDE_PROJECT_DIR?.trim() || process.cwd();
  const abs = resolve(p);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new StudioError("PROJECT_NOT_FOUND", `Project folder not found: ${abs}`, "Pass `project` as the path of an existing project folder.");
  }
  return abs;
}

export const studioRoot = (project: string) => join(project, ".gptimage", "studio");
export const graphDir = (project: string, slug: string) => join(studioRoot(project), checkSlug(slug));

export const paths = (dir: string) => ({
  graph: join(dir, "graph.json"),
  state: join(dir, "state.json"),
  events: join(dir, "events.jsonl"),
  eventsPrev: join(dir, "events.1.jsonl"),
  feedback: join(dir, "feedback.jsonl"),
  lock: join(dir, ".lock"),
  runLock: join(dir, "run.lock"),
  assets: join(dir, "assets"),
  handoff: join(dir, "handoff"),
  runs: join(dir, "runs"),
  previews: join(dir, ".previews"),
  views: join(dir, "views"),
});

/** Resolve a graph-relative asset path, refusing anything that escapes the graph folder. */
export function assetAbs(dir: string, rel: string): string {
  const abs = resolve(dir, rel);
  const r = relative(dir, abs);
  if (!r || r.startsWith("..") || isAbsolute(r)) throw new StudioError("BAD_PATH", `Asset path escapes the graph folder: ${rel}`);
  return abs;
}

export const assetRel = (dir: string, abs: string) => toPosix(relative(dir, abs));

// ---------------------------------------------------------------- atomic IO

const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Write via temp file + fsync + rename. Readers never see a partial file. Windows rename can
 *  fail transiently while another process holds the target open, so it retries briefly. */
export async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const h = await open(tmp, "w");
  try {
    await h.writeFile(data);
    await h.sync();
  } finally {
    await h.close();
  }
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, path);
      return;
    } catch (e: any) {
      if (i < 25 && TRANSIENT.has(e?.code)) { await sleep(20 * (i + 1)); continue; }
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }
}

/** Read JSON, retrying briefly on transient Windows sharing errors or a torn read. */
export async function readJson<T>(path: string): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (e: any) {
      if (e?.code === "ENOENT") throw e;
      if (i < 10 && (TRANSIENT.has(e?.code) || e instanceof SyntaxError)) { await sleep(30); continue; }
      throw e;
    }
  }
}

// ---------------------------------------------------------------- the lock

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

interface LockBody { token: string; pid: number; host: string; actor: string; at: string }
const LOCK_STALE_MS = Number(process.env.GPT_IMAGE_STUDIO_LOCK_STALE_MS) || 30_000; // env override for tests only
const LOCK_WAIT_MS = 20_000;
/** A same-host holder whose process is alive is never taken over on age alone, except after this
 *  long, which only a lock leaked by a long-lived process (an MCP server) can reach. */
const LOCK_LEAK_MS = 10 * 60_000;
const LOCK_REFRESH_MS = 5_000;

async function readLock(path: string): Promise<{ body?: LockBody; mtimeMs: number } | null> {
  try {
    const st = await stat(path);
    let body: LockBody | undefined;
    try { body = JSON.parse(await readFile(path, "utf8")); } catch { /* being written */ }
    return { body, mtimeMs: st.mtimeMs };
  } catch { return null; }
}

/** Steal a lock whose holder crashed. Renames first so two stealers cannot both delete a fresh lock. */
async function stealIfStale(path: string, staleMs: number): Promise<boolean> {
  const cur = await readLock(path);
  if (!cur) return true; // vanished: retry the create
  const age = Date.now() - cur.mtimeMs;
  const sameHost = cur.body?.host === hostname();
  const alive = sameHost && pidAlive(cur.body!.pid);
  // A live holder on this host keeps its lock even when slow (the B: drive has stalled past 30 s).
  // Age decides only for other hosts, unreadable bodies, and leaks older than LOCK_LEAK_MS.
  if (alive ? age < LOCK_LEAK_MS : sameHost ? false : age < staleMs) return false;
  const aside = `${path}.stale-${randomBytes(4).toString("hex")}`;
  try { await rename(path, aside); } catch { return true; }
  let moved: LockBody | undefined;
  try { moved = JSON.parse(await readFile(aside, "utf8")); } catch { /* empty */ }
  if (moved && cur.body && moved.token !== cur.body.token) {
    // We moved a lock that a peer took between our check and rename: put it back.
    await link(aside, path).catch(() => {});
  }
  await unlink(aside).catch(() => {});
  return true;
}

export async function withLock<T>(path: string, actor: string, fn: () => Promise<T>): Promise<T> {
  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const h = await open(path, "wx");
      try { await h.writeFile(JSON.stringify({ token, pid: process.pid, host: hostname(), actor, at: now() })); } finally { await h.close(); }
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST" && e?.code !== "EPERM") throw e;
      if (await stealIfStale(path, LOCK_STALE_MS)) continue;
      if (Date.now() > deadline) {
        const cur = await readLock(path);
        throw new StudioError("LOCKED", `Graph is locked by ${cur?.body ? `${cur.body.actor} (pid ${cur.body.pid} on ${cur.body.host})` : "another process"}.`,
          "Retry in a few seconds. A lock left by a crashed process frees itself after 30 seconds.");
      }
      await sleep(15 + Math.random() * 40);
    }
  }
  // Refresh the lock's mtime while held, so a holder on another host is not taken for stale.
  const refresh = setInterval(() => { const t = new Date(); utimes(path, t, t).catch(() => {}); }, LOCK_REFRESH_MS);
  refresh.unref();
  try {
    return await fn();
  } finally {
    clearInterval(refresh);
    await releaseLock(path, token);
  }
}

/** Delete the lock only when it is provably ours. An unreadable body is usually a peer writing a
 *  lock it has just taken, so it is retried and then left alone, never deleted. */
export async function releaseLock(path: string, token: string) {
  for (let i = 0; i < 10; i++) {
    const cur = await readLock(path);
    if (!cur) return;
    if (cur.body) {
      if (cur.body.token === token) await unlink(path).catch(() => {});
      return;
    }
    await sleep(20);
  }
}

// ---------------------------------------------------------------- graph + state files

function ordered<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]])) as T;
}

/** Stable key order and formatting so git diffs of graph.json stay readable. */
export function serializeGraph(g: GraphFile): string {
  const node = (n: GraphNode) => {
    const out: Record<string, unknown> = { id: n.id, type: n.type };
    if (n.label !== undefined) out.label = n.label;
    if (n.group !== undefined) out.group = n.group;
    if (n.position) out.position = n.position.pinned ? { x: n.position.x, y: n.position.y, pinned: true } : { x: n.position.x, y: n.position.y };
    out.settings = ordered(n.settings ?? {});
    return out;
  };
  const edges = [...g.edges].sort((a, b) => (a.to + "\0" + a.toHandle + "\0" + a.from).localeCompare(b.to + "\0" + b.toHandle + "\0" + b.from))
    .map(e => ({ from: e.from, fromHandle: e.fromHandle, to: e.to, toHandle: e.toHandle }));
  const doc = {
    schema: g.schema, name: g.name, slug: g.slug, revision: g.revision, created: g.created, updated: g.updated,
    nodes: g.nodes.map(node), edges, groups: g.groups.map(x => (x.label !== undefined ? { id: x.id, label: x.label, stage: x.stage } : { id: x.id, stage: x.stage })),
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

export function emptyState(): StateFile {
  return { schema: STATE_SCHEMA, revision: 0, eventSeq: 0, nextTake: 1, nodes: {} };
}

export async function readGraph(dir: string): Promise<GraphFile> {
  try {
    const g = await readJson<GraphFile>(paths(dir).graph);
    if (g.schema !== GRAPH_SCHEMA) throw new StudioError("SCHEMA", `Unsupported graph schema ${g.schema} in ${dir}.`, "Upgrade gpt-image-tool.");
    return g;
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new StudioError("GRAPH_NOT_FOUND", `No graph at ${dir}.`, `List graphs with ${tool("list")}, or create one with ${tool("create")}.`);
    throw e;
  }
}

export async function readState(dir: string): Promise<StateFile> {
  try {
    const s = await readJson<StateFile>(paths(dir).state);
    if (s.schema !== STATE_SCHEMA) throw new StudioError("SCHEMA", `Unsupported state schema ${s.schema} in ${dir}.`, "Upgrade gpt-image-tool.");
    return s;
  } catch (e: any) {
    if (e?.code === "ENOENT") return emptyState();
    throw e;
  }
}

export async function readBoth(dir: string) {
  return { graph: await readGraph(dir), state: await readState(dir) };
}

// Our own transient files only. Assets and handoffs are the user's work and stay tracked unless
// they choose otherwise; we never edit the project's .gitignore.
const GRAPH_GITIGNORE = "# gpt-image studio: transient files only. Assets and handoffs stay tracked.\n.lock\n.lock.stale-*\nrun.lock\n*.tmp-*\n.previews/\nviews/\nruns/*.log\nruns/*.stop\n";

/** Create a new graph folder. Refuses if graph.json exists (creation is exclusive). */
export async function createGraphFiles(dir: string, graph: GraphFile, state: StateFile, actor: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  try {
    const h = await open(paths(dir).graph, "wx");
    await h.close();
  } catch (e: any) {
    if (e?.code === "EEXIST") throw new StudioError("GRAPH_EXISTS", `Graph "${graph.slug}" already exists.`, `Choose another slug, or change the existing graph with ${tool("edit")}.`);
    throw e;
  }
  await mkdir(paths(dir).assets, { recursive: true });
  if (!existsSync(join(dir, ".gitignore"))) await atomicWrite(join(dir, ".gitignore"), GRAPH_GITIGNORE);
  await withLock(paths(dir).lock, actor, async () => {
    await atomicWrite(paths(dir).graph, serializeGraph(graph));
    await atomicWrite(paths(dir).state, JSON.stringify(state, null, 2) + "\n");
  });
}

// ---------------------------------------------------------------- events

const EVENTS_MAX_BYTES = 1_000_000;
export type EventInput = { type: string; [key: string]: unknown };

async function appendEvents(dir: string, events: StudioEvent[]): Promise<void> {
  if (!events.length) return;
  const p = paths(dir);
  try {
    const st = await stat(p.events);
    if (st.size > EVENTS_MAX_BYTES) await rename(p.events, p.eventsPrev).catch(() => {});
  } catch { /* first event */ }
  await appendFile(p.events, events.map(e => JSON.stringify(e)).join("\n") + "\n");
}

export async function readEvents(dir: string, after = 0, limit = 200): Promise<StudioEvent[]> {
  const p = paths(dir);
  const parse = async (file: string) => {
    let text = "";
    try { text = await readFile(file, "utf8"); } catch { return []; }
    const out: StudioEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a line being appended */ }
    }
    return out;
  };
  const current = await parse(p.events);
  const all = current.length && current[0]!.seq > after + 1 ? [...(await parse(p.eventsPrev)), ...current] : current;
  return all.filter(e => e.seq > after).slice(-limit);
}

/** Append-only record of verdicts, picks and notes, kept with the settings they judged. */
export async function appendFeedback(dir: string, records: Record<string, unknown>[]): Promise<void> {
  if (records.length) await appendFile(paths(dir).feedback, records.map(r => JSON.stringify(r)).join("\n") + "\n");
}

// ---------------------------------------------------------------- mutate

export interface Mutation<T> {
  result: T;
  events?: EventInput[];
  feedback?: Record<string, unknown>[];
}

/**
 * The single write path. Under the graph lock: read graph + state, let fn change them in place,
 * bump graph.revision only if the definition changed, bump state.revision, then append events.
 * State is written before events, so a crash leaves a gap in seq, never a duplicate.
 */
export async function mutate<T>(dir: string, actor: string, fn: (graph: GraphFile, state: StateFile) => Promise<Mutation<T>> | Mutation<T>) {
  // Without this, a missing graph surfaces as a raw ENOENT on the lock file.
  if (!existsSync(dir)) await readGraph(dir);
  return withLock(paths(dir).lock, actor, async () => {
    const { graph, state } = await readBoth(dir);
    const before = serializeGraph(graph);
    const out = await fn(graph, state);
    const ts = now();
    const graphChanged = serializeGraph(graph) !== before;
    if (graphChanged) {
      graph.revision += 1;
      graph.updated = ts;
      await atomicWrite(paths(dir).graph, serializeGraph(graph));
    }
    const events: StudioEvent[] = (out.events ?? []).map((e, i) => ({ seq: state.eventSeq + i + 1, ts, actor, graphRevision: graph.revision, ...e }));
    state.eventSeq += events.length;
    state.revision += 1;
    await atomicWrite(paths(dir).state, JSON.stringify(state, null, 2) + "\n");
    await appendEvents(dir, events);
    await appendFeedback(dir, (out.feedback ?? []).map(f => ({ ts, by: actor, graph: graph.slug, ...f })));
    return { result: out.result, revision: graph.revision, stateRevision: state.revision, graphChanged, events };
  });
}

export async function listGraphSlugs(project: string): Promise<string[]> {
  try {
    const entries = await readdir(studioRoot(project), { withFileTypes: true });
    return entries.filter(e => e.isDirectory() && SLUG_RE.test(e.name) && existsSync(join(studioRoot(project), e.name, "graph.json"))).map(e => e.name).sort();
  } catch { return []; }
}
