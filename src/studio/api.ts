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
import { GRAPH_SCHEMA, type GraphFile, type RunRecord } from "./types.js";

export interface Who { project?: string; actor?: string }
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
  const ctx: OpContext = { project, dir, actor, events: [], feedback: [], notes: [] };
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
  return { project, slug, job: st.job, status: st.status, waitedMs: st.waitedMs, ...summarize(dir, st.record) };
}

function summarize(dir: string, rec: RunRecord) {
  const lines: string[] = [];
  const p = rec.progress;
  lines.push(`Run ${rec.id} (${rec.scope.kind === "all" ? "all" : rec.scope.nodes.join(",") + (rec.scope.kind === "downstream" ? "+" : "")}): ${rec.status}. ${p.slotsDone}/${rec.planned.slots}${rec.planned.estimate ? "+" : ""} slots done, ${p.slotsCached} reused, ${p.slotsFailed} failed, ${p.generations} generation(s).`);
  if (p.current) lines.push(`Working on ${p.current.node} slot ${p.current.slot + 1}.`);
  if (rec.stopReason) lines.push(`Stopped: ${rec.stopReason}${rec.stopFix ? ` Fix: ${rec.stopFix}` : ""}`);
  for (const e of rec.errors.slice(0, 5)) lines.push(`Error in ${e.node}: ${e.message.slice(0, 300)}${e.fix ? ` Fix: ${e.fix}` : ""}`);
  for (const s of rec.skipped.slice(0, 5)) lines.push(`Skipped ${s.node}: ${s.reason}`);
  if (rec.takes.length) {
    lines.push("New takes (open these to look):");
    for (const t of rec.takes.slice(-24)) lines.push(`  ${t.node}/${t.take}  ${resolve(dir, t.asset)}`);
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

export async function viewGraph(slug: string, opts: Who & { nodes?: string[]; allTakes?: boolean } = {}) {
  const project = resolveProject(opts.project);
  const dir = graphDir(project, slug);
  const { graph, state } = await readBoth(dir);
  const evals = await evaluate(graph, state, { dir, project });
  const wanted = opts.nodes?.length ? opts.nodes : graph.nodes.filter(n => !["prompt", "style", "list", "note", "handoff"].includes(n.type)).map(n => n.id);
  const items: Array<{ ref: string; path: string; label: string; preview?: string; verdict?: string; status: string }> = [];
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
      items.push({ ref: `${id}/${take.id}`, path, label: `${label}${take.verdict ? ` ${take.verdict.decision}` : ""}`, verdict: take.verdict?.decision, status, preview: (await ensurePreview(dir, take.asset)) ?? undefined });
    }
  }
  if (!items.length) return { project, slug, sheet: undefined, images: [], text: "No images yet. Run the graph first (studio_run)." };
  let sheet: string | undefined;
  const shown = items.slice(-30);
  const notes: string[] = [];
  try {
    const { createContactSheet } = await import("../contactsheet.js");
    await mkdir(paths(dir).views, { recursive: true });
    sheet = await createContactSheet(shown.map(i => i.path), join(paths(dir).views, `sheet-${now().replace(/[:.]/g, "-")}.png`), shown.map(i => i.label));
  } catch (e) {
    notes.push(`No contact sheet (${e instanceof Error ? e.message : e}); open the preview paths instead.`);
  }
  if (items.length > 30) notes.push(`Showing the last 30 of ${items.length} images; pass nodes to narrow it.`);
  const text = [sheet ? `Contact sheet (open this first): ${sheet}` : "", "Images (ref, label, preview path, full path):",
    ...items.map(i => `  ${i.ref}  ${i.label}${i.status === "stale" ? " (stale)" : ""}\n    preview ${i.preview ?? "(none)"}\n    full    ${i.path}`), ...notes].filter(Boolean).join("\n");
  return { project, slug, sheet, images: items, text };
}

export async function readRunRecord(slug: string, job: string, w: Who = {}) {
  const project = resolveProject(w.project);
  return readJson<RunRecord>(join(paths(graphDir(project, slug)).runs, `${job}.json`));
}
