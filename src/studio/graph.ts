// Graph operations: create and edit as all-or-nothing op lists, typed connection rules, cycle
// checks and automatic placement. Every refusal names its fix. Operations mutate the in-memory
// graph/state handed in by mutate(); nothing is written unless the whole list succeeds.

import { copyFile, mkdir, readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { NODE_SPECS, NODE_TYPES, ROLES, STAGES, closest, typeIssue, validateSettings, type HandleSpec } from "./nodes.js";
import { StudioError, assetRel, now, paths, toPosix, type EventInput } from "./store.js";
import type { GraphEdge, GraphFile, GraphNode, Issue, NodeState, NodeType, StateFile, Take } from "./types.js";

const ID_RE = /^[a-z][a-z0-9_-]{0,39}$/i;
export const NODE_W = 240;
export const COL_W = 340;
export const ROW_H = 220;
/** Nodes that show an image get a taller row, so the image can dominate the node. */
export const IMAGE_ROW_H = 420;
const IMAGE_TYPES = new Set(["reference", "generate", "edit", "process", "gallery", "implementation", "canon"]);
const rowH = (n: GraphNode) => (IMAGE_TYPES.has(n.type) ? IMAGE_ROW_H : ROW_H);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export interface OpContext {
  project: string;
  dir: string;
  actor: string;
  events: EventInput[];
  feedback: Record<string, unknown>[];
  notes: string[];
  /** A person acting (ADE, CLI --human). Agents must record a look before approving. */
  human?: boolean;
}

export function nodeState(state: StateFile, id: string): NodeState {
  return (state.nodes[id] ??= { takes: [], selected: [] });
}

export function findNode(graph: GraphFile, id: string, path = "node"): GraphNode {
  const n = graph.nodes.find(x => x.id === id);
  if (n) return n;
  const c = closest(id, graph.nodes.map(x => x.id));
  throw new StudioError("NO_NODE", `${path}: no node "${id}" in graph "${graph.slug}".`, c ? `Did you mean "${c}"? Node ids: ${graph.nodes.map(x => x.id).join(", ")}.` : `Node ids: ${graph.nodes.map(x => x.id).join(", ") || "(none)"}.`);
}

export function parseTakeRef(graph: GraphFile, state: StateFile, ref: unknown, path = "take"): { node: GraphNode; take: Take } {
  if (typeof ref !== "string" || !ref.includes("/")) throw new StudioError("BAD_TAKE", `${path}: expected "node/take", e.g. "gen/t3"; got ${JSON.stringify(ref)}.`, "Take refs are listed by studio_get.");
  const [nid, tid] = ref.split("/") as [string, string];
  const node = findNode(graph, nid, path);
  const takes = state.nodes[nid]?.takes ?? [];
  const take = takes.find(t => t.id === tid);
  if (!take) throw new StudioError("NO_TAKE", `${path}: node "${nid}" has no take "${tid}".`, takes.length ? `Takes of ${nid}: ${takes.map(t => t.id).join(", ")}.` : `${nid} has no takes yet; run it with studio_run.`);
  return { node, take };
}

// ---------------------------------------------------------------- topology

export function inputsOf(graph: GraphFile, id: string, handle?: string): GraphEdge[] {
  return graph.edges.filter(e => e.to === id && (handle === undefined || e.toHandle === handle));
}

export function topoOrder(graph: GraphFile): string[] {
  const indeg = new Map(graph.nodes.map(n => [n.id, 0]));
  for (const e of graph.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue = graph.nodes.filter(n => !indeg.get(n.id)).map(n => n.id);
  const out: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    out.push(id);
    for (const e of graph.edges) if (e.from === id) {
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }
  return out;
}

export function descendants(graph: GraphFile, id: string): Set<string> {
  const out = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of graph.edges) if (e.from === cur && !out.has(e.to)) { out.add(e.to); stack.push(e.to); }
  }
  return out;
}

export function ancestors(graph: GraphFile, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of graph.edges) if (e.to === cur && !out.has(e.from)) { out.add(e.from); stack.push(e.from); }
  }
  return out;
}

const handleList = (hs: HandleSpec[]) => hs.map(x => `${x.name} (${x.type}, ${x.multi ? "many" : "one"})`).join(", ") || "none";

/** Connect with handles chosen by type. Refuses type mismatch, a full single input, and cycles. */
export function connect(graph: GraphFile, from: string, to: string, toHandle?: string, fromHandle?: string, path = "connect"): { edge: GraphEdge; added: boolean } {
  const a = findNode(graph, from, `${path}.from`), b = findNode(graph, to, `${path}.to`);
  if (a.type === "note" || b.type === "note") throw new StudioError("NOTE_EDGE", `${path}: notes are not wired with edges.`, `Attach a note with settings.on, e.g. {op:"note", on:"${a.type === "note" ? to : from}", text:"..."}.`);
  const outs = NODE_SPECS[a.type].outputs, ins = NODE_SPECS[b.type].inputs;
  const out = fromHandle ? outs.find(o => o.name === fromHandle) : outs[0];
  if (!out) throw new StudioError("NO_HANDLE", `${path}: ${a.type} "${from}" has no output${fromHandle ? ` "${fromHandle}"` : "s"}.`, `Outputs of ${a.type}: ${handleList(outs)}.`);
  let input: HandleSpec | undefined;
  if (toHandle) {
    input = ins.find(i => i.name === toHandle);
    if (!input) throw new StudioError("NO_HANDLE", `${path}: ${b.type} "${to}" has no input "${toHandle}".`, `Inputs of ${b.type}: ${handleList(ins)}.`);
    if (input.type !== out.type) throw new StudioError("TYPE_MISMATCH", `${path}: ${from}.${out.name} is ${out.type} but ${to}.${input.name} takes ${input.type}.`, `Inputs of ${b.type}: ${handleList(ins)}.`);
  } else {
    const candidates = ins.filter(i => i.type === out.type);
    if (!candidates.length) {
      throw new StudioError("TYPE_MISMATCH", `${path}: ${b.type} "${to}" has no ${out.type} input for ${a.type} "${from}".`, `Inputs of ${b.type}: ${handleList(ins)}.`);
    }
    input = candidates.find(i => i.multi || !inputsOf(graph, to, i.name).length) ?? candidates[0];
  }
  const existing = graph.edges.find(e => e.from === from && e.to === to && e.toHandle === input!.name);
  if (existing) return { edge: existing, added: false };
  const taken = inputsOf(graph, to, input.name);
  if (!input.multi && taken.length) {
    throw new StudioError("INPUT_FULL", `${path}: ${to}.${input.name} takes one connection and already has "${taken[0]!.from}".`,
      `Disconnect it first: {op:"disconnect", from:"${taken[0]!.from}", to:"${to}"}.`);
  }
  if (from === to || descendants(graph, to).has(from)) throw new StudioError("CYCLE", `${path}: connecting ${from} -> ${to} would create a loop.`, "Studio graphs flow one way. Feed a result back in through a new node instead.");
  const edge = { from, fromHandle: out.name, to, toHandle: input.name };
  graph.edges.push(edge);
  return { edge, added: true };
}

// ---------------------------------------------------------------- layout

/** Place nodes that have no position: column by depth, below the existing nodes of that column.
 *  Positions a person or agent set are never moved. */
export function placeNodes(graph: GraphFile, ids?: Set<string>, all = false): void {
  const depth = new Map<string, number>();
  for (const id of topoOrder(graph)) {
    const parents = inputsOf(graph, id).map(e => depth.get(e.from) ?? 0);
    depth.set(id, parents.length ? Math.max(...parents) + 1 : 0);
  }
  // Next free y per column: below the bottom of every node already placed there.
  const colNext = new Map<number, number>();
  for (const n of graph.nodes) {
    if (!n.position || n.type === "note") continue;
    if (all && !n.position.pinned) continue;
    const col = Math.round(n.position.x / COL_W);
    colNext.set(col, Math.max(colNext.get(col) ?? 0, n.position.y + rowH(n)));
  }
  for (const n of graph.nodes) {
    if (n.type === "note") continue;
    const want = all ? !n.position?.pinned : !n.position && (!ids || ids.has(n.id));
    if (!want) continue;
    const col = depth.get(n.id) ?? 0;
    const y = colNext.get(col) ?? 0;
    colNext.set(col, y + rowH(n));
    n.position = { x: col * COL_W, y };
  }
  for (const n of graph.nodes) {
    if (n.type !== "note" || (n.position && !(all && !n.position.pinned))) continue;
    const target = graph.nodes.find(x => x.id === n.settings.on);
    const siblings = graph.nodes.filter(x => x.type === "note" && x.settings.on === n.settings.on && x.position && x !== n).length;
    n.position = target?.position ? { x: target.position.x + 40 + siblings * 24, y: target.position.y - 120 - siblings * 24 } : { x: -COL_W, y: siblings * 140 };
  }
}

// ---------------------------------------------------------------- file inputs

/** Turn a user path into a project-relative one. Files outside the project are copied into the
 *  graph's assets so no absolute path is ever stored. */
export async function importPath(ctx: OpContext, raw: string, what: string): Promise<{ rel: string; copied: boolean }> {
  const abs = isAbsolute(raw) ? raw : resolve(ctx.project, raw);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new StudioError("NO_FILE", `${what}: file not found: ${abs}`, "Pass a path to an existing image file, project-relative or absolute.");
  const ext = extname(abs).toLowerCase();
  if (!IMAGE_EXT.has(ext)) throw new StudioError("NOT_IMAGE", `${what}: ${abs} is not a png, jpg or webp file.`, "Convert it to PNG first.");
  const r = relative(ctx.project, abs);
  if (r && !r.startsWith("..") && !isAbsolute(r)) return { rel: toPosix(r), copied: false };
  const sha = createHash("sha256").update(await readFile(abs)).digest("hex");
  const dest = join(paths(ctx.dir).assets, `import-${sha.slice(0, 16)}${ext}`);
  await mkdir(paths(ctx.dir).assets, { recursive: true });
  if (!existsSync(dest)) await copyFile(abs, dest);
  ctx.notes.push(`${what}: copied ${abs} into the graph (it is outside the project).`);
  return { rel: toPosix(relative(ctx.project, dest)), copied: true };
}

// ---------------------------------------------------------------- ops

export const OP_NAMES = ["add", "remove", "set", "prompt_edit", "connect", "disconnect", "group", "ungroup", "move", "layout", "rename",
  "select", "pick", "approve", "reject", "clear_verdict", "predict", "note", "answer", "critique", "judge_pair", "canon_save"] as const;

type Op = Record<string, unknown> & { op: string };

function str(op: Op, key: string, path: string, required = true): string | undefined {
  const v = op[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new StudioError("BAD_OP", `${path}: "${op.op}" needs "${key}".`, OP_HELP[op.op] ?? "");
    return undefined;
  }
  if (typeof v !== "string") throw new StudioError("BAD_OP", `${path}.${key}: expected a string.`, OP_HELP[op.op] ?? "");
  return v;
}

export const OP_HELP: Record<string, string> = {
  add: '{op:"add", id:"gen", type:"generate", settings:{...}, label?, group?, connect_from?:["prompt1"]}',
  remove: '{op:"remove", node:"gen"} (also removes its edges and notes)',
  set: '{op:"set", node:"gen", settings:{quality:"high"}, label?, group?} (a null value removes a setting)',
  prompt_edit: '{op:"prompt_edit", node:"p1", find:"red", replace:"blue"} or {append:"..."} or {prepend:"..."}; field? defaults to the node\'s text field',
  connect: '{op:"connect", from:"p1", to:"gen", to_handle?:"prompt"}',
  disconnect: '{op:"disconnect", from:"p1", to:"gen", to_handle?}',
  group: '{op:"group", id:"concept", stage:"concept", label?, nodes:["p1","gen"]}',
  ungroup: '{op:"ungroup", id:"concept"}',
  move: '{op:"move", node:"gen", x:640, y:0}',
  layout: '{op:"layout"} (re-places every node a person has not moved)',
  rename: '{op:"rename", name:"Landing hero v2"}',
  select: '{op:"select", take:"gen/t4"} (use this take as the output of its slot)',
  pick: '{op:"pick", node:"gallery", takes:["gen/t4","gen/t6"]} ([] clears)',
  approve: '{op:"approve", take:"gen/t4", note?}',
  reject: '{op:"reject", take:"gen/t4", note?}',
  clear_verdict: '{op:"clear_verdict", take:"gen/t4"}',
  predict: '{op:"predict", take:"gen/t4", decision:"approved"|"rejected"|"picked", reason:"..."} (an agent\'s call before the human decides)',
  note: '{op:"note", on:"gen", text:"warmer light", author?, take?:"gen/t4"}',
  answer: '{op:"answer", take:"gen/t4", answers:{c1:"yes", c2:"no", c3:{answer:"unsure", note:"hand hidden"}}} (the checklist of the take, from studio_get node)',
  critique: '{op:"critique", take:"gen/t4", summary:"...", criteria?:{composition:"...", lighting:"...", artefacts:"..."}, against?:"gen/t2", preferred?:"gen/t4", judge?}',
  judge_pair: '{op:"judge_pair", pair:"p...", preferred:"A"|"B", reason:"...", criteria?} (a blind pair from studio_view pair)',
  canon_save: '{op:"canon_save", name:"teapot", takes:["variant/t5"], description:"a small round ceramic teapot, deep cobalt glaze, ...", kind?:"character"|"place"|"product"|"look", role?:"subject", replace?:true} (approved takes only)',
};

const KNOWN: Record<string, string[]> = {
  add: ["op", "id", "type", "settings", "label", "group", "position", "connect_from"], remove: ["op", "node"], set: ["op", "node", "settings", "label", "group"],
  prompt_edit: ["op", "node", "field", "find", "replace", "append", "prepend", "all"], connect: ["op", "from", "to", "to_handle", "from_handle"],
  disconnect: ["op", "from", "to", "to_handle"], group: ["op", "id", "label", "stage", "nodes"], ungroup: ["op", "id"], move: ["op", "node", "x", "y"],
  layout: ["op"], rename: ["op", "name"], select: ["op", "take"], pick: ["op", "node", "takes"], approve: ["op", "take", "note"], reject: ["op", "take", "note"],
  clear_verdict: ["op", "take"], predict: ["op", "take", "decision", "reason"], note: ["op", "on", "text", "author", "id", "take"],
  answer: ["op", "take", "answers"], critique: ["op", "take", "summary", "criteria", "against", "preferred", "judge"], judge_pair: ["op", "pair", "preferred", "reason", "criteria"], canon_save: ["op", "name", "takes", "description", "kind", "role", "replace"],
};

function freshId(graph: GraphFile, base: string): string {
  for (let i = 1; ; i++) if (!graph.nodes.some(n => n.id === `${base}${i}`)) return `${base}${i}`;
}

let humanAct = false;
function takeFeedback(graph: GraphFile, node: GraphNode, take: Take, action: string, extra: Record<string, unknown> = {}) {
  return { action, human: humanAct, node: node.id, type: node.type, take: take.id, settings: take.settings, text: take.text?.prompt, reading: take.reading, deviations: take.deviations, graphRevision: graph.revision, ...extra };
}

const LOOK_FIX = (ref: string) => `First record a look: answer its checklist ({op:"answer", take:"${ref}", answers:{c1:"yes", ...}}; studio_get node shows the questions) or add a critique ({op:"critique", take:"${ref}", summary:"what you saw"}). Both can go in the same studio_edit call, before the approve. People approve freely.`;

async function addNode(graph: GraphFile, state: StateFile, ctx: OpContext, spec: Record<string, unknown>, path: string, placed: Set<string>): Promise<GraphNode> {
  const id = spec.id ?? spec.ref;
  const type = spec.type;
  if (typeof type !== "string") throw new StudioError("BAD_OP", `${path}: "type" is required.`, `Types: ${NODE_TYPES.join(", ")}.`);
  const ti = typeIssue(type, `${path}.type`);
  if (ti) throw new StudioError("BAD_TYPE", ti.message, ti.fix);
  if (typeof id !== "string" || !ID_RE.test(id)) throw new StudioError("BAD_ID", `${path}: node id ${JSON.stringify(id)} is invalid.`, 'Use a short id starting with a letter: letters, digits, "-" or "_" (max 40), e.g. "hero-gen".');
  if (graph.nodes.some(n => n.id === id)) throw new StudioError("DUPLICATE_ID", `${path}: node "${id}" already exists.`, `Pick another id, e.g. "${freshId(graph, id.replace(/\d+$/, ""))}".`);
  const settings = (spec.settings ?? {}) as Record<string, unknown>;
  if (typeof settings !== "object" || Array.isArray(settings)) throw new StudioError("BAD_OP", `${path}.settings must be an object.`);
  const issues = validateSettings(type as NodeType, settings, `${path}.settings`);
  if (issues.length) throw new StudioError("BAD_SETTINGS", `${path}: invalid settings for ${type} "${id}".`, issues[0]!.fix, issues);
  const node: GraphNode = { id, type: type as NodeType, settings: { ...settings } };
  if (typeof spec.label === "string") node.label = spec.label;
  if (typeof spec.group === "string") { requireGroup(graph, spec.group, `${path}.group`); node.group = spec.group; }
  const pos = spec.position as { x?: unknown; y?: unknown } | undefined;
  if (pos && typeof pos.x === "number" && typeof pos.y === "number") node.position = { x: pos.x, y: pos.y, pinned: true };
  if (node.type === "note") {
    if (typeof settings.on === "string") findNode(graph, settings.on, `${path}.settings.on`);
    node.settings.author ??= ctx.actor;
  }
  graph.nodes.push(node);
  placed.add(id);
  await afterSettings(graph, state, ctx, node, path);
  return node;
}

function requireGroup(graph: GraphFile, id: string, path: string) {
  if (!graph.groups.some(g => g.id === id)) throw new StudioError("NO_GROUP", `${path}: no group "${id}".`, `Create it first: {op:"group", id:"${id}", stage:"concept"}. Groups: ${graph.groups.map(g => g.id).join(", ") || "(none)"}.`);
}

/** Side effects of settings: normalize file paths, import reference images as takes. */
async function afterSettings(graph: GraphFile, state: StateFile, ctx: OpContext, node: GraphNode, path: string) {
  if (node.type === "reference" && typeof node.settings.path === "string") {
    const { rel } = await importPath(ctx, node.settings.path, `${path}.settings.path`);
    node.settings.path = rel;
    await importReference(graph, state, ctx.project, ctx.dir, node);
  }
  if (node.type === "canon" && typeof node.settings.name === "string") {
    const { importCanon, relativeProject } = await import("./canon.js");
    if (typeof node.settings.project === "string") node.settings.project = relativeProject(ctx.project, node.settings.project);
    await importCanon(graph, state, ctx.project, ctx.dir, node);
  }
  if (node.type === "implementation" && typeof node.settings.screenshot === "string") {
    node.settings.screenshot = (await importPath(ctx, node.settings.screenshot, `${path}.settings.screenshot`)).rel;
  }
}

export async function fileSha(path: string): Promise<{ sha256: string; bytes: number }> {
  const buf = await readFile(path);
  return { sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
}

/** Copy a reference's source into assets as a take, unless the newest take already has that content. */
export async function importReference(graph: GraphFile, state: StateFile, project: string, dir: string, node: GraphNode, job?: string): Promise<Take | null> {
  const src = resolve(project, String(node.settings.path));
  const { sha256, bytes } = await fileSha(src);
  const ns = nodeState(state, node.id);
  if (ns.takes.some(t => t.sha256 === sha256)) {
    const existing = ns.takes.find(t => t.sha256 === sha256)!;
    ns.selected = [existing.id];
    return null;
  }
  const ext = extname(src).toLowerCase();
  const takeId = `t${state.nextTake++}`;
  const dest = join(paths(dir).assets, `${node.id}-${takeId}${ext}`);
  await mkdir(paths(dir).assets, { recursive: true });
  await copyFile(src, dest);
  const { imageSize } = await import("../imageinfo.js");
  const dim = imageSize(await readFile(dest));
  const take: Take = {
    id: takeId, kind: "image", slot: 0, variant: 0, fingerprint: sha256, asset: assetRel(dir, dest), sha256, bytes,
    width: dim?.width, height: dim?.height, created: now(), job, graphRevision: graph.revision, inputs: [], settings: { ...node.settings },
    generations: 0, source: String(node.settings.path),
  };
  ns.takes.push(take);
  ns.selected = [take.id];
  return take;
}

/** Apply ops in order. Throws on the first failure; the caller discards everything (all-or-nothing). */
export async function applyOps(graph: GraphFile, state: StateFile, ops: unknown[], ctx: OpContext): Promise<string[]> {
  if (!Array.isArray(ops) || !ops.length) throw new StudioError("BAD_OP", "ops must be a non-empty array.", `Example: [${OP_HELP.set}].`);
  const placed = new Set<string>();
  const applied: string[] = [];
  humanAct = Boolean(ctx.human);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as Op;
    const path = `ops[${i}]`;
    if (!op || typeof op !== "object" || typeof op.op !== "string") throw new StudioError("BAD_OP", `${path}: each op needs an "op" field.`, `Ops: ${OP_NAMES.join(", ")}.`);
    if (!(OP_NAMES as readonly string[]).includes(op.op)) {
      const c = closest(op.op, OP_NAMES);
      throw new StudioError("BAD_OP", `${path}: unknown op "${op.op}".`, `${c ? `Did you mean "${c}"? ` : ""}Ops: ${OP_NAMES.join(", ")}.`);
    }
    const extra = Object.keys(op).filter(k => !KNOWN[op.op]!.includes(k));
    if (extra.length) throw new StudioError("BAD_OP", `${path}: unknown field${extra.length > 1 ? "s" : ""} ${extra.join(", ")} for "${op.op}".`, `Shape: ${OP_HELP[op.op]}`);
    applied.push(await applyOne(graph, state, op, path, ctx, placed));
  }
  placeNodes(graph, placed);
  return applied;
}

async function applyOne(graph: GraphFile, state: StateFile, op: Op, path: string, ctx: OpContext, placed: Set<string>): Promise<string> {
  switch (op.op) {
    case "add": {
      const node = await addNode(graph, state, ctx, op, path, placed);
      const from = op.connect_from;
      if (from !== undefined) {
        if (!Array.isArray(from)) throw new StudioError("BAD_OP", `${path}.connect_from must be an array of node ids.`);
        for (const f of from) connect(graph, String(f), node.id, undefined, undefined, `${path}.connect_from`);
      }
      ctx.events.push({ type: "node.added", node: node.id, nodeType: node.type });
      return `added ${node.type} ${node.id}`;
    }
    case "remove": {
      const node = findNode(graph, str(op, "node", path)!, path);
      const gone = new Set([node.id, ...graph.nodes.filter(n => n.type === "note" && n.settings.on === node.id).map(n => n.id)]);
      graph.nodes = graph.nodes.filter(n => !gone.has(n.id));
      graph.edges = graph.edges.filter(e => !gone.has(e.from) && !gone.has(e.to));
      for (const id of gone) delete state.nodes[id];
      for (const ns of Object.values(state.nodes)) if (ns.picks) ns.picks = ns.picks.filter(p => !gone.has(p.split("/")[0]!));
      ctx.events.push({ type: "node.removed", node: node.id, also: [...gone].filter(x => x !== node.id) });
      return `removed ${node.id}${gone.size > 1 ? ` and ${gone.size - 1} note(s)` : ""}`;
    }
    case "set": {
      const node = findNode(graph, str(op, "node", path)!, path);
      const patch = op.settings as Record<string, unknown> | undefined;
      if (patch !== undefined && (typeof patch !== "object" || patch === null || Array.isArray(patch))) throw new StudioError("BAD_OP", `${path}.settings must be an object.`, OP_HELP.set);
      const next = { ...node.settings };
      for (const [k, v] of Object.entries(patch ?? {})) { if (v === null) delete next[k]; else next[k] = v; }
      const issues = validateSettings(node.type, next, `${path}.settings`);
      if (issues.length) throw new StudioError("BAD_SETTINGS", `${path}: invalid settings for ${node.type} "${node.id}".`, issues[0]!.fix, issues);
      if (node.type === "note" && typeof next.on === "string") findNode(graph, next.on, `${path}.settings.on`);
      const pathChanged = (node.type === "reference" && next.path !== node.settings.path) || (node.type === "implementation" && next.screenshot !== node.settings.screenshot);
      node.settings = next;
      if (op.label !== undefined) { if (op.label === null) delete node.label; else node.label = String(op.label); }
      if (op.group !== undefined) { if (op.group === null) delete node.group; else { requireGroup(graph, String(op.group), `${path}.group`); node.group = String(op.group); } }
      if (pathChanged) await afterSettings(graph, state, ctx, node, path);
      ctx.events.push({ type: "node.changed", node: node.id, keys: Object.keys(patch ?? {}) });
      return `set ${node.id} ${Object.keys(patch ?? {}).join(", ") || "(label/group)"}`;
    }
    case "prompt_edit": {
      const node = findNode(graph, str(op, "node", path)!, path);
      const field = str(op, "field", path, false) ?? NODE_SPECS[node.type].textField;
      if (!field) throw new StudioError("BAD_OP", `${path}: ${node.type} has no text field.`, "prompt_edit works on prompt, generate, edit, handoff and note nodes.");
      let cur = node.settings[field];
      if (cur === undefined) cur = "";
      if (typeof cur !== "string") throw new StudioError("BAD_OP", `${path}: ${node.id}.${field} is not text.`);
      let next = cur;
      const find = str(op, "find", path, false);
      if (find !== undefined) {
        if (typeof op.replace !== "string") throw new StudioError("BAD_OP", `${path}: find needs replace.`, OP_HELP.prompt_edit);
        if (!cur.includes(find)) throw new StudioError("NOT_FOUND", `${path}: "${find}" does not occur in ${node.id}.${field}.`, `Current text: ${JSON.stringify(cur.slice(0, 300))}${cur.length > 300 ? "…" : ""}`);
        next = op.all ? cur.split(find).join(op.replace) : cur.replace(find, op.replace);
      }
      if (typeof op.prepend === "string") next = op.prepend + next;
      if (typeof op.append === "string") next = next + op.append;
      if (next === cur && find === undefined) throw new StudioError("BAD_OP", `${path}: nothing to change.`, OP_HELP.prompt_edit);
      const issues = validateSettings(node.type, { ...node.settings, [field]: next }, `${path}.settings`);
      if (issues.length) throw new StudioError("BAD_SETTINGS", `${path}: ${issues[0]!.message}`, issues[0]!.fix, issues);
      node.settings[field] = next;
      ctx.events.push({ type: "node.changed", node: node.id, keys: [field] });
      return `edited ${node.id}.${field}`;
    }
    case "connect": {
      const { edge, added } = connect(graph, str(op, "from", path)!, str(op, "to", path)!, str(op, "to_handle", path, false), str(op, "from_handle", path, false), path);
      if (added) ctx.events.push({ type: "edge.added", edge });
      return `${added ? "connected" : "already connected"} ${edge.from}.${edge.fromHandle} -> ${edge.to}.${edge.toHandle}`;
    }
    case "disconnect": {
      const from = str(op, "from", path)!, to = str(op, "to", path)!, th = str(op, "to_handle", path, false);
      findNode(graph, from, `${path}.from`); findNode(graph, to, `${path}.to`);
      const before = graph.edges.length;
      graph.edges = graph.edges.filter(e => !(e.from === from && e.to === to && (!th || e.toHandle === th)));
      if (graph.edges.length === before) throw new StudioError("NO_EDGE", `${path}: ${from} is not connected to ${to}${th ? `.${th}` : ""}.`, `Inputs of ${to}: ${inputsOf(graph, to).map(e => `${e.from} -> ${e.toHandle}`).join(", ") || "(none)"}.`);
      ctx.events.push({ type: "edge.removed", from, to, toHandle: th });
      return `disconnected ${from} -> ${to}`;
    }
    case "group": {
      const id = str(op, "id", path)!;
      if (!ID_RE.test(id)) throw new StudioError("BAD_ID", `${path}: group id "${id}" is invalid.`, 'Use letters, digits, "-" or "_", starting with a letter.');
      let g = graph.groups.find(x => x.id === id);
      const stage = str(op, "stage", path, !g);
      if (!g) { g = { id, stage: stage! }; graph.groups.push(g); }
      if (stage) g.stage = stage;
      if (typeof op.label === "string") g.label = op.label;
      if (op.nodes !== undefined) {
        if (!Array.isArray(op.nodes)) throw new StudioError("BAD_OP", `${path}.nodes must be an array.`, OP_HELP.group);
        for (const nid of op.nodes) findNode(graph, String(nid), `${path}.nodes`).group = id;
      }
      ctx.events.push({ type: "group.changed", group: id });
      return `group ${id} (${g.stage}${(STAGES as readonly string[]).includes(g.stage) ? "" : ", free text"})`;
    }
    case "ungroup": {
      const id = str(op, "id", path)!;
      requireGroup(graph, id, path);
      graph.groups = graph.groups.filter(g => g.id !== id);
      for (const n of graph.nodes) if (n.group === id) delete n.group;
      ctx.events.push({ type: "group.removed", group: id });
      return `ungrouped ${id}`;
    }
    case "move": {
      const node = findNode(graph, str(op, "node", path)!, path);
      if (typeof op.x !== "number" || typeof op.y !== "number" || !Number.isFinite(op.x) || !Number.isFinite(op.y)) throw new StudioError("BAD_OP", `${path}: x and y must be numbers.`, OP_HELP.move);
      node.position = { x: Math.round(op.x), y: Math.round(op.y), pinned: true };
      ctx.events.push({ type: "node.moved", node: node.id, x: node.position.x, y: node.position.y });
      return `moved ${node.id}`;
    }
    case "layout": {
      placeNodes(graph, undefined, true);
      ctx.events.push({ type: "graph.layout" });
      return "re-laid out unpinned nodes";
    }
    case "rename": {
      const name = str(op, "name", path)!;
      graph.name = name.slice(0, 200);
      ctx.events.push({ type: "graph.renamed", name: graph.name });
      return `renamed to "${graph.name}"`;
    }
    case "select": {
      const { node, take } = parseTakeRef(graph, state, op.take, `${path}.take`);
      const ns = nodeState(state, node.id);
      const same = new Set(ns.takes.filter(t => t.slot === take.slot && t.variant === take.variant).map(t => t.id));
      ns.selected = [...ns.selected.filter(id => !same.has(id)), take.id];
      ctx.events.push({ type: "take.selected", node: node.id, take: take.id });
      ctx.feedback.push(takeFeedback(graph, node, take, "select"));
      return `selected ${node.id}/${take.id}`;
    }
    case "pick": {
      const node = findNode(graph, str(op, "node", path)!, path);
      if (node.type !== "gallery") throw new StudioError("BAD_OP", `${path}: pick works on gallery nodes; ${node.id} is ${node.type}.`, `For other nodes use ${OP_HELP.select}.`);
      if (!Array.isArray(op.takes)) throw new StudioError("BAD_OP", `${path}.takes must be an array of "node/take".`, OP_HELP.pick);
      const refs = op.takes.map((r, j) => { const x = parseTakeRef(graph, state, r, `${path}.takes[${j}]`); return { ref: `${x.node.id}/${x.take.id}`, ...x }; });
      const feeding = ancestors(graph, node.id);
      for (const r of refs) if (!feeding.has(r.node.id)) throw new StudioError("NOT_UPSTREAM", `${path}: ${r.ref} does not feed gallery ${node.id}.`, `Connect ${r.node.id} to ${node.id} first.`);
      nodeState(state, node.id).picks = refs.map(r => r.ref);
      ctx.events.push({ type: "gallery.picked", node: node.id, picks: refs.map(r => r.ref) });
      for (const r of refs) ctx.feedback.push(takeFeedback(graph, r.node, r.take, "pick", { gallery: node.id }));
      return refs.length ? `picked ${refs.map(r => r.ref).join(", ")} in ${node.id}` : `cleared picks in ${node.id}`;
    }
    case "approve":
    case "reject": {
      const { node, take } = parseTakeRef(graph, state, op.take, `${path}.take`);
      if (op.op === "approve" && !ctx.human && !take.critiques?.length && !take.checklist?.some(c => c.answer)) {
        throw new StudioError("NO_LOOK", `${path}: an agent cannot approve ${node.id}/${take.id} without a recorded look.`, LOOK_FIX(`${node.id}/${take.id}`));
      }
      const decision = op.op === "approve" ? "approved" : "rejected";
      take.verdict = { decision, by: ctx.actor, at: now(), ...(typeof op.note === "string" ? { note: op.note } : {}) };
      ctx.events.push({ type: `take.${decision}`, node: node.id, take: take.id, note: op.note });
      ctx.feedback.push(takeFeedback(graph, node, take, op.op, { note: op.note }));
      return `${decision} ${node.id}/${take.id}`;
    }
    case "clear_verdict": {
      const { node, take } = parseTakeRef(graph, state, op.take, `${path}.take`);
      delete take.verdict;
      ctx.events.push({ type: "take.verdict_cleared", node: node.id, take: take.id });
      ctx.feedback.push(takeFeedback(graph, node, take, "clear_verdict"));
      return `cleared verdict on ${node.id}/${take.id}`;
    }
    case "predict": {
      const { node, take } = parseTakeRef(graph, state, op.take, `${path}.take`);
      const decision = str(op, "decision", path)!;
      if (!["approved", "rejected", "picked"].includes(decision)) throw new StudioError("BAD_OP", `${path}.decision must be approved, rejected or picked.`, OP_HELP.predict);
      const reason = str(op, "reason", path)!;
      (take.predictions ??= []).push({ by: ctx.actor, at: now(), decision: decision as "approved", reason });
      ctx.events.push({ type: "take.predicted", node: node.id, take: take.id, decision });
      ctx.feedback.push(takeFeedback(graph, node, take, "predict", { decision, reason }));
      return `recorded prediction ${decision} on ${node.id}/${take.id}`;
    }
    case "note": {
      const on = str(op, "on", path)!;
      const target = findNode(graph, on, `${path}.on`);
      const text = str(op, "text", path)!;
      const id = typeof op.id === "string" ? op.id : freshId(graph, "note");
      const settings: Record<string, unknown> = { text, on, author: typeof op.author === "string" ? op.author : ctx.actor };
      const node = await addNode(graph, state, ctx, { id, type: "note", settings }, path, placed);
      let takeRef: string | undefined;
      if (op.take !== undefined) {
        const x = parseTakeRef(graph, state, op.take, `${path}.take`);
        takeRef = `${x.node.id}/${x.take.id}`;
        ctx.feedback.push(takeFeedback(graph, x.node, x.take, "comment", { note: text, author: settings.author }));
      }
      ctx.events.push({ type: "note.added", node: node.id, on: target.id, author: settings.author, text: text.slice(0, 500), take: takeRef });
      return `noted on ${target.id} (${node.id})`;
    }
    case "answer": {
      const { node, take } = parseTakeRef(graph, state, op.take, `${path}.take`);
      const list = take.checklist ?? [];
      if (!list.length) throw new StudioError("NO_CHECKLIST", `${path}: ${node.id}/${take.id} has no checklist.`, `Record a critique instead: ${OP_HELP.critique}`);
      const answers = op.answers as Record<string, unknown>;
      if (!answers || typeof answers !== "object" || Array.isArray(answers) || !Object.keys(answers).length) throw new StudioError("BAD_OP", `${path}.answers must be an object of checklist ids.`, OP_HELP.answer);
      for (const [id, raw] of Object.entries(answers)) {
        const item = list.find(c => c.id === id);
        if (!item) throw new StudioError("BAD_OP", `${path}.answers: no checklist item "${id}".`, `Items: ${list.map(c => `${c.id} ${c.question}`).join(" | ")}`);
        const a = typeof raw === "string" ? raw : (raw as any)?.answer;
        if (!["yes", "no", "unsure"].includes(a)) throw new StudioError("BAD_OP", `${path}.answers.${id} must be yes, no or unsure.`, OP_HELP.answer);
        Object.assign(item, { answer: a, by: ctx.actor, at: now(), ...(typeof (raw as any)?.note === "string" ? { note: (raw as any).note } : {}) });
      }
      const no = list.filter(c => c.answer === "no").map(c => c.id);
      ctx.events.push({ type: "take.checked", node: node.id, take: take.id, answered: Object.keys(answers).length, no });
      ctx.feedback.push(takeFeedback(graph, node, take, "checklist", { answers: list.filter(c => c.answer).map(c => ({ question: c.question, answer: c.answer })) }));
      return `answered ${Object.keys(answers).length} checklist item(s) on ${node.id}/${take.id}${no.length ? ` (no: ${no.join(", ")})` : ""}`;
    }
    case "critique": {
      const { node, take } = parseTakeRef(graph, state, op.take, `${path}.take`);
      const summary = str(op, "summary", path)!;
      let against: string | undefined, preferred: string | undefined;
      if (op.against !== undefined) { const o = parseTakeRef(graph, state, op.against, `${path}.against`); against = `${o.node.id}/${o.take.id}`; }
      if (op.preferred !== undefined) {
        const p = parseTakeRef(graph, state, op.preferred, `${path}.preferred`);
        preferred = `${p.node.id}/${p.take.id}`;
        if (preferred !== `${node.id}/${take.id}` && preferred !== against) throw new StudioError("BAD_OP", `${path}.preferred must be the take or the one it is compared against.`, OP_HELP.critique);
      }
      if (op.criteria !== undefined && (typeof op.criteria !== "object" || Array.isArray(op.criteria))) throw new StudioError("BAD_OP", `${path}.criteria must be an object of short remarks.`, OP_HELP.critique);
      const c = { id: `k${(take.critiques?.length ?? 0) + 1}`, judge: typeof op.judge === "string" ? op.judge : ctx.actor, at: now(), summary, ...(against ? { against } : {}), ...(preferred ? { preferred } : {}), ...(op.criteria ? { criteria: op.criteria as Record<string, string> } : {}) };
      (take.critiques ??= []).push(c);
      ctx.events.push({ type: "take.critiqued", node: node.id, take: take.id, judge: c.judge });
      ctx.feedback.push(takeFeedback(graph, node, take, "critique", { judge: c.judge, summary, against, preferred }));
      return `critique ${c.id} on ${node.id}/${take.id} by ${c.judge}`;
    }
    case "canon_save": {
      const name = str(op, "name", path)!;
      const description = str(op, "description", path)!;
      if (!Array.isArray(op.takes) || !op.takes.length) throw new StudioError("BAD_OP", `${path}.takes must list 1-8 takes.`, OP_HELP.canon_save);
      const role = typeof op.role === "string" ? op.role : "subject";
      if (!(ROLES as readonly string[]).includes(role)) throw new StudioError("BAD_OP", `${path}.role "${role}" is not valid.`, `Roles: ${ROLES.join(", ")}.`);
      const takes = (op.takes as unknown[]).map((r, i) => {
        const x = parseTakeRef(graph, state, r, `${path}.takes[${i}]`);
        if (x.take.verdict?.decision !== "approved") throw new StudioError("NOT_APPROVED", `${path}.takes[${i}]: ${x.node.id}/${x.take.id} is not approved.`, `Canon is for settled images. Approve it first (after a recorded look): {op:"approve", take:"${x.node.id}/${x.take.id}"}.`);
        return { ref: `${x.node.id}/${x.take.id}`, take: x.take, role };
      });
      const { saveCanon } = await import("./canon.js");
      const entry = await saveCanon(ctx.project, ctx.dir, { name, kind: typeof op.kind === "string" ? op.kind : undefined, description, takes, by: ctx.actor, replace: op.replace === true });
      ctx.events.push({ type: "canon.saved", name, takes: takes.map(t => t.ref) });
      return `saved canon "${entry.name}" (${entry.kind}, ${entry.references.length} image(s)); use it with {op:"add", id:"${entry.name}", type:"canon", settings:{name:"${entry.name}"}} and connect it to a generator's references`;
    }
    case "judge_pair": {
      const id = str(op, "pair", path)!;
      const { readPair } = await import("./craft.js");
      const pair = await readPair(ctx.dir, id);
      if (!pair) throw new StudioError("NO_PAIR", `${path}: no blind pair "${id}".`, 'Make one with studio_view {pair:["a/t1","b/t2"]}.');
      const choice = str(op, "preferred", path)!;
      if (choice !== "A" && choice !== "B") throw new StudioError("BAD_OP", `${path}.preferred must be "A" or "B".`, OP_HELP.judge_pair);
      const win = parseTakeRef(graph, state, choice === "A" ? pair.A : pair.B, `${path}`), lose = choice === "A" ? pair.B : pair.A;
      const c = { id: `k${(win.take.critiques?.length ?? 0) + 1}`, judge: ctx.actor, at: now(), summary: str(op, "reason", path)!, against: lose, preferred: `${win.node.id}/${win.take.id}`, blind: true, ...(op.criteria ? { criteria: op.criteria as Record<string, string> } : {}) };
      (win.take.critiques ??= []).push(c);
      ctx.events.push({ type: "pair.judged", pair: id, preferred: c.preferred, against: lose, judge: ctx.actor });
      ctx.feedback.push(takeFeedback(graph, win.node, win.take, "pair", { against: lose, reason: c.summary, blind: true }));
      return `blind pair ${id}: preferred ${c.preferred} over ${lose}`;
    }
  }
  throw new StudioError("BAD_OP", `${path}: unhandled op ${op.op}`);
}

/** Final structural check, a backstop after ops: every edge valid, groups and note targets exist. */
export function structuralIssues(graph: GraphFile): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set(graph.nodes.map(n => n.id));
  for (const e of graph.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) issues.push({ message: `edge ${e.from} -> ${e.to} points at a missing node` });
  }
  if (topoOrder(graph).length !== graph.nodes.length) issues.push({ message: "graph has a cycle", fix: "Remove one of the edges in the loop." });
  for (const n of graph.nodes) {
    if (n.group && !graph.groups.some(g => g.id === n.group)) issues.push({ message: `${n.id} is in missing group ${n.group}` });
  }
  return issues;
}

/** Build the initial graph from a create request: nodes with caller refs, connections, groups. */
export async function buildGraph(graph: GraphFile, state: StateFile, input: { nodes?: unknown[]; connections?: unknown[]; groups?: unknown[] }, ctx: OpContext): Promise<void> {
  const ops: Op[] = [];
  for (const g of (input.groups ?? []) as Record<string, unknown>[]) ops.push({ op: "group", id: g.id, stage: g.stage ?? "concept", label: g.label } as Op);
  for (const n of (input.nodes ?? []) as Record<string, unknown>[]) {
    if (n?.type === "note") {
      const s = (n.settings ?? {}) as Record<string, unknown>;
      ops.push({ op: "note", id: n.id ?? n.ref, on: s.on, text: s.text, author: s.author } as Op);
      continue;
    }
    const { ref, ...rest } = n ?? {};
    ops.push({ op: "add", ...rest, id: n?.id ?? ref } as Op);
  }
  for (const c of (input.connections ?? []) as Record<string, unknown>[]) ops.push({ op: "connect", from: c.from, to: c.to, to_handle: c.to_handle, from_handle: c.from_handle } as Op);
  const notes = ops.filter(o => o.op === "note");
  const rest = ops.filter(o => o.op !== "note");
  const cleaned = [...rest, ...notes].map(o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Op);
  if (!cleaned.length) return;
  await applyOps(graph, state, cleaned, ctx);
}
