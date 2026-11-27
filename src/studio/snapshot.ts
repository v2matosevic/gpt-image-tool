// The agent's view of a graph: a bounded, media-free text snapshot, and one node in full.

import { resolve } from "node:path";
import { evaluate, type NodeEval } from "./evaluate.js";
import { inputsOf, topoOrder } from "./graph.js";
import { NODE_SPECS, workOf } from "./nodes.js";
import { readEvents } from "./store.js";
import { listRecords, liveJob, readRecord } from "./runner.js";
import type { GraphFile, StateFile, Take } from "./types.js";

const MAX = 7000;
const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n)}…(+${s.length - n} chars)` : s);
const q = (s: unknown) => JSON.stringify(clip(String(s ?? "")));

function details(ev: NodeEval, state: StateFile): string {
  const s = ev.node.settings;
  const ns = state.nodes[ev.node.id];
  switch (ev.node.type) {
    case "prompt": return q(s.text);
    case "note": return "";
    case "style": {
      const bits = [ev.look?.preset && `preset ${ev.look.preset}`, ev.look?.modifiers?.length && `modifiers ${ev.look.modifiers.join(",")}`,
        ev.look?.shot && `shot ${clip(JSON.stringify(ev.look.shot), 120)}`, ev.look?.style && `style ${clip(JSON.stringify(ev.look.style), 100)}`].filter(Boolean);
      return bits.join(" · ") || "(empty)";
    }
    case "list": return ev.text ? `${ev.text.length} items: ${clip(ev.text.map(t => t.item ?? t.text).join(" | "), 160)}` : "";
    case "canon": return `canon "${s.name}"${s.project ? ` from ${s.project}` : ""}${ev.canon ? `: "${ev.canon.description.slice(0, 90)}${ev.canon.description.length > 90 ? "…" : ""}"` : ""}${ev.images?.length ? ` · ${ev.images.length} image(s)` : ""}`;
    case "reference": return `${s.path ?? "?"} as ${s.role ?? "style"}${ev.images?.[0] ? ` · ${ev.images[0].node}/${ev.images[0].take}` : ""}`;
    case "gallery": return `${ev.images?.length ?? 0} image(s)${ns?.picks?.length ? `, picks ${ns.picks.join(" ")}` : ", no picks (passes all)"}`;
    default: {
      const bits: string[] = [];
      if (ev.slots.length) bits.push(`${ev.views.filter(v => v.status === "current" || v.status === "pinned").length}/${ev.slots.length} slots current`);
      if (ev.node.type === "generate" || ev.node.type === "edit") {
        bits.push(`quality ${s.quality ?? "low"}`);
        if (s.size) bits.push(String(s.size));
        if (s.takes && s.takes !== 1) bits.push(`takes ${s.takes}`);
        const own = s.prompt ?? s.instruction;
        if (own) bits.push(q(own));
      }
      if (ev.node.type === "process") bits.push(`op ${s.op}`);
      if (ev.node.type === "handoff") bits.push(`package ${s.name ?? ev.node.id}`);
      const shown = ev.views.filter(v => v.take).map(v => `${v.take!.id}${v.status === "stale" ? "(stale)" : v.status === "pinned" ? "(pinned)" : ""}${mark(v.take!)}`);
      if (shown.length) bits.push(`out ${clip(shown.join(" "), 120)}`);
      const others = (ns?.takes.length ?? 0) - shown.length;
      if (others > 0) bits.push(`+${others} older take(s)`);
      return bits.join(" · ");
    }
  }
}

const mark = (t: Take) => (t.verdict?.decision === "approved" ? "✓" : t.verdict?.decision === "rejected" ? "✗" : "");

export async function snapshot(project: string, dir: string, graph: GraphFile, state: StateFile): Promise<{ text: string; evals: Map<string, NodeEval> }> {
  const live = await liveJob(dir);
  const evals = await evaluate(graph, state, { dir, project, liveJob: live });
  const lines: string[] = [];
  lines.push(`Graph "${graph.name}" (${graph.slug}) · revision ${graph.revision} · ${graph.nodes.length} nodes · project ${project}`);
  const jobs = await listRecords(dir);
  if (live) {
    const r = await readRecord(dir, live).catch(() => undefined);
    lines.push(`Run ${live} ${r?.status ?? "running"}: ${r?.progress.slotsDone ?? 0}/${r?.planned.slots ?? "?"} slots${r?.progress.current ? `, now ${r.progress.current.node}` : ""}. Follow with studio_status.`);
  } else if (jobs.length) {
    const r = await readRecord(dir, jobs.at(-1)!).catch(() => undefined);
    if (r) lines.push(`Last run ${r.id}: ${r.status}, ${r.takes.length} take(s), ${r.progress.generations} generation(s)${r.errors.length ? `, ${r.errors.length} error(s)` : ""}.`);
  }
  if (graph.groups.length) lines.push(`Groups: ${graph.groups.map(g => `${g.id}${g.label ? ` "${g.label}"` : ""} [${g.stage}]: ${graph.nodes.filter(n => n.group === g.id).map(n => n.id).join(", ") || "(empty)"}`).join(" · ")}`);
  lines.push("Nodes (id, type, status, details, inputs):");
  const issues: string[] = [];
  for (const id of topoOrder(graph)) {
    const ev = evals.get(id)!;
    if (ev.node.type === "note") continue;
    const ins = inputsOf(graph, id).map(e => `${e.from}${NODE_SPECS[ev.node.type].inputs.length > 1 ? `(${e.toHandle})` : ""}`);
    const label = ev.node.label ? ` "${clip(ev.node.label, 40)}"` : "";
    lines.push(`  ${id}${label}  ${ev.node.type}  ${ev.status}${ev.upstreamStale.length ? ` (upstream ${ev.upstreamStale.join(",")} out of date)` : ""}  ${details(ev, state)}${ins.length ? `  <- ${ins.join(", ")}` : ""}`);
    for (const i of ev.issues) issues.push(`${id}: ${i.message}.${i.fix ? ` Fix: ${i.fix}` : ""}`);
    const err = state.nodes[id]?.error;
    if (err && ev.status === "failed") issues.push(`${id} failed: ${clip(err.message, 200)}${err.fix ? ` Fix: ${err.fix}` : ""}`);
  }
  const notes = graph.nodes.filter(n => n.type === "note" && !n.settings.resolved);
  if (notes.length) {
    lines.push("Open notes:");
    for (const n of notes) lines.push(`  [${n.settings.author ?? "?"} on ${n.settings.on ?? "graph"}] ${q(n.settings.text)} (${n.id})`);
  }
  if (issues.length) { lines.push("Needs attention:"); for (const i of issues) lines.push(`  ${i}`); }
  const next = nextSteps(graph, evals);
  if (next.length) { lines.push("Next:"); for (const n of next) lines.push(`  ${n}`); }
  let text = lines.join("\n");
  if (text.length > MAX) text = `${text.slice(0, MAX)}\n…(snapshot truncated; studio_get with node for full detail)`;
  return { text, evals };
}

function nextSteps(graph: GraphFile, evals: Map<string, NodeEval>): string[] {
  const out: string[] = [];
  const broken = [...evals.values()].filter(e => e.issues.length);
  if (broken.length) out.push(`Fix ${broken.map(e => e.node.id).join(", ")} first (see Needs attention); a run skips them and everything that depends on them.`);
  const brokenIds = new Set(broken.map(e => e.node.id));
  const pending = [...evals.values()].filter(e => workOf(e.node.type, e.node.settings) !== "none" && e.node.type !== "reference" && !e.issues.length
    && (e.status === "empty" || e.status === "stale" || (e.status === "blocked" && !brokenIds.has(e.blockedBy!))));
  if (pending.length) out.push(`studio_run {graph:"${graph.slug}"} renders what is empty or stale (${pending.map(e => e.node.id).join(", ")}); unchanged slots are reused.`);
  const handoffs = [...evals.values()].filter(e => e.node.type === "handoff" && e.issues.some(i => /approved/.test(i.message)));
  if (handoffs.length) out.push(`Look at the results (studio_view), then approve one with studio_edit {op:"approve", take:"node/take"} so ${handoffs.map(h => h.node.id).join(", ")} can package it.`);
  return out.slice(0, 3);
}

/** One node in full: settings, inputs, every take with absolute paths, notes, issues. */
export async function nodeDetail(project: string, dir: string, graph: GraphFile, state: StateFile, id: string, evals?: Map<string, NodeEval>) {
  const ev = (evals ?? (await evaluate(graph, state, { dir, project, liveJob: await liveJob(dir) }))).get(id)!;
  const ns = state.nodes[id];
  const spec = NODE_SPECS[ev.node.type];
  return {
    id, type: ev.node.type, label: ev.node.label, group: ev.node.group, status: ev.status,
    settings: ev.node.settings,
    inputs: inputsOf(graph, id).map(e => ({ from: e.from, handle: e.toHandle })),
    outputs: graph.edges.filter(e => e.from === id).map(e => ({ to: e.to, handle: e.toHandle })),
    handles: { in: spec.inputs.map(h => `${h.name}:${h.type}${h.multi ? "*" : ""}`), out: spec.outputs.map(h => `${h.name}:${h.type}`) },
    issues: ev.issues, blockedBy: ev.blockedBy, upstreamStale: ev.upstreamStale,
    slots: ev.views.map(v => ({ slot: v.slot.index, variant: v.slot.variant, label: v.slot.label, status: v.status, take: v.take?.id, fingerprint: v.slot.fingerprint.slice(0, 12), text: v.slot.text ? clip(v.slot.text, 400) : undefined })),
    output: ev.images?.map(i => ({ ref: `${i.node}/${i.take}`, path: resolve(dir, i.asset), current: i.current, verdict: i.verdict })),
    takes: (ns?.takes ?? []).map(t => ({
      ref: `${id}/${t.id}`, path: resolve(dir, t.asset), slot: t.slot, variant: t.variant, created: t.created, size: t.width ? `${t.width}x${t.height}` : undefined,
      selected: ns!.selected.includes(t.id) || undefined, verdict: t.verdict, predictions: t.predictions, critiques: t.critiques, checklist: t.checklist,
      prompt: t.text?.prompt, compiledPrompt: t.text?.compiledPrompt ? clip(t.text.compiledPrompt, 600) : undefined, files: t.files?.map(f => resolve(dir, f)),
      generations: t.generations, warnings: t.warnings, reading: t.reading, fingerprint: t.fingerprint.slice(0, 12),
    })),
    picks: ns?.picks, error: ns?.error,
    notes: graph.nodes.filter(n => n.type === "note" && n.settings.on === id).map(n => ({ id: n.id, author: n.settings.author, text: n.settings.text, resolved: n.settings.resolved })),
  };
}

export async function recentEvents(dir: string, n = 8) {
  return (await readEvents(dir, 0, n)).map(e => `${e.seq} ${e.ts.slice(11, 19)} ${e.type}${e.node ? ` ${e.node}` : ""}${e.take ? `/${e.take}` : ""}`);
}
