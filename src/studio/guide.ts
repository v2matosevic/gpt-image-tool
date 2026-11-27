// studio_guide: everything an agent needs to drive Studio, rendered from the node registry so the
// documented settings are exactly the validated ones.

import { NODE_SPECS, NODE_TYPES, SHOT_DIMENSIONS } from "./nodes.js";
import { OP_HELP } from "./graph.js";

export const GUIDE_TOPICS = ["overview", "nodes", "ops", "run", "handoff", "shot", "example"] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number] | "all";

const OVERVIEW = `# Studio: image work as a graph

A graph lives in <project>/.gptimage/studio/<slug>/. Nodes are prompts, looks, lists, references,
generators, edits, post-processing, galleries, handoffs and notes. Data flows along typed edges:
text -> text, style -> style, image -> image, package -> package. Text, style and package inputs take
one connection; image inputs take many.

How to work:
1. studio_create with nodes (your own short ids) and connections. Handles are picked by type.
2. studio_run starts a background job and returns its id (it waits up to wait_seconds, default 20).
   studio_status follows it (waits up to 30s per call). Runs survive client timeouts.
3. Look: studio_view writes one labelled contact sheet and preview paths. Open them. Never judge an
   image you have not opened.
4. Revise with studio_edit ops (set, prompt_edit, connect...). Rerun: only slots whose inputs or
   settings changed are regenerated; everything else is reused. new_take:true adds another take.
5. Approve the image you want (op approve), then run the handoff node to write a build package for
   the coding agent. When the build exists, attach its screenshot with an implementation node.

Rules that save quota and mistakes:
- Studio uses the ChatGPT subscription only, never the paid API. The renderer is whatever OpenAI
  routes; you choose quality. Draft at quality low (the default), finish at high.
- A list node fans out: one slot per item. takes:N gives N images per slot.
- Images are never inlined: every take is a file in assets/ with a fingerprint and lineage.
- Every refusal names its fix. Unknown settings are rejected with the valid names.
- expect_revision on studio_edit refuses an edit if someone changed the graph meanwhile.
- Other projects: pass project to list, read or copy (copy_from). Writes go only to the project you
  pass (default: this one).
- One run per graph at a time; a second is refused with the running job id.
- Quota or rate limit stops the run cleanly; studio_run {resume:true} continues where it stopped.`;

function nodesSection(): string {
  const lines = ["# Node types", ""];
  for (const t of NODE_TYPES) {
    const s = NODE_SPECS[t];
    const ins = s.inputs.map(h => `${h.name}:${h.type}${h.multi ? " (many)" : ""}`).join(", ") || "none";
    const outs = s.outputs.map(h => `${h.name}:${h.type}`).join(", ") || "none";
    lines.push(`## ${t}`, s.summary, `in: ${ins} · out: ${outs}`);
    const docs = Object.entries(s.docs);
    if (docs.length) lines.push(...docs.map(([k, v]) => `- ${k}: ${v}`));
    lines.push("");
  }
  return lines.join("\n");
}

function opsSection(): string {
  return ["# studio_edit ops", "", "All ops in one call apply together or not at all.", "", ...Object.values(OP_HELP).map(v => `- ${v}`), "",
    "Take refs look like \"gen/t4\" (node/take). studio_get {node} lists them with file paths.",
    "Verdicts and picks are recorded with the take's settings in feedback.jsonl (the owner's taste record)."].join("\n");
}

const RUN = `# Running

studio_run {graph, scope?, nodes?, new_take?, concurrency?, dry_run?, resume?, stop?, wait_seconds?}
- scope: "all" (default), "<id>" for one node, "<id>+" for a node and everything downstream.
  nodes: [ids] runs a selection.
- dry_run:true returns the plan (generations, cached slots, skipped nodes) and spends nothing.
- Unchanged slots are never regenerated. A slot is unchanged when its fingerprint (resolved text,
  look, settings, input image hashes, project profile) matches an existing take.
- new_take:true renders one more take for each slot in scope; history is kept.
- concurrency 1-3 (default 1, sequential; quota and token refresh favour sequential).
- Running one node uses its upstream outputs as they are. If upstream is out of date the snapshot
  says so; run "<upstream>+" to refresh the chain.
- stop:true asks the live run to stop after its current image. resume:true continues the last
  interrupted or stopped run.
- Each run records how many generations it made (runs/<job>.json).`;

const HANDOFF = `# Handoff to a coding agent, and back

1. Approve the image(s) to build from: {op:"approve", take:"gen/t4", note:"this one"}.
2. A handoff node (connected from the generator or a gallery) packages only approved images:
   handoff/<name>/handoff.md (intent, must match, flexible, measured colours, lineage, review notes),
   mock-N.png, cut-outs from upstream remove-background nodes, manifest.json.
3. The coding agent reads handoff.md and builds.
4. Screenshot the build, then add an implementation node connected from the handoff, with
   settings.screenshot, and run it. It writes a side-by-side sheet (mock | build). Look at it
   yourself; nothing scores it automatically.
Measured colours are pixel observations, not intended design tokens.`;

function shotSection(): string {
  return ["# Shot language", "", "Set shot:{...} on a style node or a generate/edit node. Each dimension maps onto the prompt compiler",
    "(composition, camera, lighting, color, mood, setting, medium, detail). An explicit style.<dimension> wins.", "",
    ...Object.entries(SHOT_DIMENSIONS).map(([k, v]) => `- ${k}: ${v}`)].join("\n");
}

const EXAMPLE = `# Worked example

studio_create {
  name: "Mug lookbook",
  nodes: [
    {ref:"subject", type:"prompt", settings:{text:"a matte sage ceramic mug on a {{item}} tabletop"}},
    {ref:"surfaces", type:"list", settings:{items:["white marble","oiled oak","raw linen"]}},
    {ref:"look", type:"style", settings:{preset:"product-studio", shot:{lens:"85mm", key_light:"soft window light from camera left"}}},
    {ref:"draft", type:"generate", settings:{quality:"low", size:"1024x1024"}},
    {ref:"pick", type:"gallery"},
    {ref:"hand", type:"handoff", settings:{intent:"Product hero for the shop landing page", target:"Next.js hero, 1440px"}}
  ],
  connections: [
    {from:"subject", to:"surfaces"}, {from:"surfaces", to:"draft"}, {from:"look", to:"draft"},
    {from:"draft", to:"pick"}, {from:"pick", to:"hand"}
  ]
}
studio_run {graph:"mug-lookbook"}                  -> 3 low-quality drafts (one per surface)
studio_view {graph:"mug-lookbook"}                 -> open the contact sheet
studio_edit {graph:"mug-lookbook", ops:[{op:"prompt_edit", node:"subject", find:"matte sage", replace:"glossy sage"}]}
studio_run {graph:"mug-lookbook"}                  -> all three rerender (the shared text changed)
studio_edit {graph:"mug-lookbook", ops:[{op:"approve", take:"draft/t5"}, {op:"pick", node:"pick", takes:["draft/t5"]}]}
studio_run {graph:"mug-lookbook", scope:"hand"}    -> writes handoff/hand/handoff.md

Variations of an approved anchor: connect the approved generator to an edit node (to_handle "image")
with a list of instructions, so each variation is an edit of the anchor, not a fresh generation.`;

export function guide(topic: GuideTopic = "all"): string {
  const parts: Record<string, () => string> = { overview: () => OVERVIEW, nodes: nodesSection, ops: opsSection, run: () => RUN, handoff: () => HANDOFF, shot: shotSection, example: () => EXAMPLE };
  if (topic !== "all") return parts[topic]!();
  return GUIDE_TOPICS.map(t => parts[t]!()).join("\n\n");
}
