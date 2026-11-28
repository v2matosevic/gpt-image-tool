// studio_guide: everything an agent needs to drive Studio, rendered from the node registry so the
// documented settings are exactly the validated ones.

import { NODE_SPECS, NODE_TYPES, SHOT_DIMENSIONS } from "./nodes.js";
import { OP_HELP } from "./graph.js";
import { recipesGuide } from "./recipes.js";

export const GUIDE_TOPICS = ["overview", "nodes", "ops", "run", "review", "handoff", "shot", "recipes", "example"] as const;
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
3. Look: the run result names a review sheet, measured deviations and a checklist per take; open the
   sheet. studio_view makes more sheets, zooms and blind pairs. Never judge an image you have not
   opened. Topic review explains what "better" means here.
4. Revise with studio_edit ops (set, prompt_edit, connect...). Rerun: only slots whose inputs or
   settings changed are regenerated; everything else is reused. new_take:true adds another take.
5. Record what you saw (op answer or critique), approve the image you want (op approve), then run the handoff node to write a build package for
   the coding agent. When the build exists, attach its screenshot with an implementation node.

Rules that save quota and mistakes:
- Studio uses the ChatGPT subscription only, never the paid API. The renderer is whatever OpenAI
  routes. The default is quality low; medium and high are sent, but the subscription reports "low" for
  every value it is given (tested 2026-11-28), so do not expect high to look better.
- Images have their own cap of roughly 24 hours, shared with ChatGPT Images and separate from the
  Codex usage meter (reported around 97 images on Plus). When it is hit the run stops and its fix
  says when the cap resets; resume after that.
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

const REVIEW = `# Looking and judging

There is no absolute better, only better for the stated intent. Evidence, most reliable first:
1. Checkable defects: warped hands or objects, garbled text, smears, extra limbs. Zoom in to see them.
2. The request against the measured reading: asked for low key, measured high key.
3. Measured drift from the anchor (palette, lightness, contrast, temperature, saturation).
4. Blind pairwise critique. This is opinion, and model judges lean toward a generic polished look.
5. Above all of these: the human's choice.

What a run already gives you (studio_status): one review sheet labelled with the setting that differs,
measured deviations first, a one-line reading per take, and each take's checklist.
- Reading: palette with shares, lightness key, contrast, warm/cool, saturation, visual weight by
  thirds, quiet space, where it is sharpest, edge density. Measurements, not a score.
- Deviations: where the reading contradicts the request or drifts from the anchor image. Confirm them
  by looking; a measurement can be wrong about intent.
- Checklist: yes/no questions from the prompt and shot settings. Answer them after looking:
  {op:"answer", take:"gen/t4", answers:{c1:"yes", c2:"no", c3:{answer:"unsure", note:"hand hidden"}}}

Looking closer (studio_view):
- overlays:["grid","palette","histogram"]: thirds grid with the visual-weight centre, colour shares, lightness.
- zoom:{take:"gen/t4", region:"bottom-right"} (a thirds cell, or [x,y,w,h] fractions): full resolution.
- pair:["gen/t3","gen/t5"]: a blind A/B sheet in random order; record it with
  {op:"judge_pair", pair:"p...", preferred:"A", reason:"..."}.

Keeping things the same across images:
- Anchor: approve one image and make variations as edits of it (edit node, image handle), not
  fresh generations. Deviations then report drift from the anchor.
- Canon: save approved takes as a named entry with a locked description:
  {op:"canon_save", name:"mira", kind:"character", takes:["gen/t4"], description:"..."}.
  Any graph (another project too, settings.project) adds {type:"canon", settings:{name:"mira"}} and
  connects it to a generator's references. Its images go in with their role and its description is
  added to the prompt word for word. Write the description once, carefully: rewording is drift.
  studio_list shows the project's canon.
- Identity of a face, character or product is not measured; check it with a blind pair.

Learning from an image someone admires: studio_view {study:"images/admired.png"} (or a take ref with
graph) returns its measurements plus the look in shot language from one vision request, as a ready
{op:"add", type:"style", ...}. It names the dimensions of a look to learn from; it is not a copy
function, and the vision part is an opinion to check against the image.

Recording a judgement:
- {op:"critique", take, summary, criteria?, against?, preferred?}: what you saw, in words.
- An agent cannot approve a take without a recorded look (a critique or checklist answers). Put the
  look and the approve in the same studio_edit call. People approve freely.
- The gate checks that a look was recorded, not that it is true. A test agent described a cream
  teapot as cobalt, was accepted, and saved a canon description that contradicted the image. Open
  the image before you write about it. One cheap guard: a critique or canon description naming a
  colour family the image has no pixels of gets a warning in the result notes (never a refusal).
- Lessons: when a sweep or several takes settle something, record it so later sessions start from
  it: {op:"lesson", claim, dimension, takes:[2+ takes], scope?:"project"|"user", supersedes?}. One
  take is never a lesson. Lessons are superseded, never edited; old ones weigh less because the
  routed renderer can change. studio_create and studio_guide list the active ones, with the owner's
  taste in counts (what people kept and dropped) and the prediction agreement rate.
- Calibration: before the human decides, record your own call with {op:"predict", take,
  decision:"approved"|"rejected"|"picked", reason}. It is compared with the human's decision later;
  a prediction made after the human decided does not count.`;

const HANDOFF = `# Handoff to a coding agent, and back

1. Approve the image(s) to build from, after looking: {op:"critique", take:"gen/t4", summary:"..."},
   then {op:"approve", take:"gen/t4", note:"this one"} (same call is fine).
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
    "Settle the subject first, then sweep. A prompt alone does not hold the subject: in a live key-light sweep",
    "from a prompt the bottle changed shape between takes, so the difference could not be pinned on the light.",
    "So: render, pick one take, then sweep as edits of it. On an edit node (its image is the anchor), or on a",
    "generate node with a subject reference or canon image, every sweep slot is an edit of that anchor that",
    "changes only the swept dimension. Set",
    'sweep:{dim:"shot.key_light", values:["from camera left","backlight","top light"]}. One slot per value,',
    "labelled by value on the run sheet. A sweep with no anchor still runs, and its result says the subject",
    "may vary. Use takes:2 to separate the dimension from chance. dim can be preset, style.<dimension> or",
    "shot.<dimension>; changing one value re-renders only that slot.", "",
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
studio_view {graph:"mug-lookbook"}                 -> open the review sheet
studio_edit {graph:"mug-lookbook", ops:[{op:"prompt_edit", node:"subject", find:"matte sage", replace:"glossy sage"}]}
studio_run {graph:"mug-lookbook"}                  -> all three rerender (the shared text changed)
studio_edit {graph:"mug-lookbook", ops:[{op:"answer", take:"draft/t5", answers:{c1:"yes", c2:"yes", c3:"yes"}},
  {op:"approve", take:"draft/t5"}, {op:"pick", node:"pick", takes:["draft/t5"]}]}
studio_run {graph:"mug-lookbook", scope:"hand"}    -> writes handoff/hand/handoff.md

Variations of an approved anchor: connect the approved generator to an edit node (to_handle "image")
with a list of instructions, so each variation is an edit of the anchor, not a fresh generation.`;

const CLI_EXAMPLE = `# Worked example (CLI)

Write the spec to a file and pass it with @ (or - for stdin); JSON on the command line works too.

mug.json: {"name":"Mug lookbook","nodes":[
  {"ref":"subject","type":"prompt","settings":{"text":"a matte sage ceramic mug on a {{item}} tabletop"}},
  {"ref":"surfaces","type":"list","settings":{"items":["white marble","oiled oak","raw linen"]}},
  {"ref":"look","type":"style","settings":{"preset":"product-studio","shot":{"lens":"85mm","key_light":"soft window light from camera left"}}},
  {"ref":"draft","type":"generate","settings":{"quality":"low","size":"1024x1024"}},
  {"ref":"pick","type":"gallery"},
  {"ref":"hand","type":"handoff","settings":{"intent":"Product hero for the shop landing page","target":"Next.js hero, 1440px"}}],
 "connections":[{"from":"subject","to":"surfaces"},{"from":"surfaces","to":"draft"},{"from":"look","to":"draft"},
  {"from":"draft","to":"pick"},{"from":"pick","to":"hand"}]}

gpt-image studio create --spec @mug.json
gpt-image studio run mug-lookbook --dry-run          -> plan plus the compiled prompt of one slot
gpt-image studio run mug-lookbook --wait 120         -> 3 low-quality drafts (one per surface)
gpt-image studio sheet mug-lookbook                  -> open the review sheet it prints
gpt-image studio sheet mug-lookbook --zoom draft/t2@centre
gpt-image studio edit mug-lookbook --ops '[{"op":"prompt_edit","node":"subject","find":"matte sage","replace":"glossy sage"}]'
gpt-image studio run mug-lookbook --wait 120         -> all three rerender (the shared text changed)
gpt-image studio edit mug-lookbook --ops @verdict.json   (answer, approve and pick in one call)
gpt-image studio run mug-lookbook --scope hand       -> writes handoff/hand/handoff.md

On Windows PowerShell, prefer @file for ops: inline JSON quoting differs between shells.

Variations of an approved anchor: connect the approved generator to an edit node (to_handle "image")
with a list of instructions, so each variation is an edit of the anchor, not a fresh generation.`;

const CLI_PREFACE = `You are using the CLI (gpt-image studio). Other agents reach the same operations as MCP tools
(studio_*); this copy of the guide is written for the CLI. create --spec, edit --ops and run take JSON
inline, @file or - (stdin), and ops JSON is the same everywhere. Flags: --new-take, --dry-run,
--wait <s>, --expect-revision <n>, --project <dir>, --json. Topics: gpt-image studio guide <topic>.`;

/** MCP wording to CLI wording. Specific forms first, then the general names. */
const CLI_TERMS: Array<[RegExp | string, string]> = [
  ["studio_run {graph, scope?, nodes?, new_take?, concurrency?, dry_run?, resume?, stop?, wait_seconds?}",
    "gpt-image studio run <graph> [--scope all|id|id+] [--nodes a,b] [--new-take] [--concurrency 1-3] [--dry-run] [--resume] [--stop] [--wait s]"],
  ["studio_create {name, recipe, subject, path?}", `gpt-image studio create --spec '{"name":"...","recipe":"lookbook","subject":"..."}' (path for product-set)`],
  ['studio_view {study:"images/admired.png"} (or a take ref with\ngraph)', "gpt-image studio study images/admired.png (or a take ref with\n--graph)"],
  ["Looking closer (studio_view):", "Looking closer (gpt-image studio sheet <graph>):"],
  ['- overlays:["grid","palette","histogram"]:', "- --overlays grid,palette,histogram:"],
  ['- zoom:{take:"gen/t4", region:"bottom-right"} (a thirds cell, or [x,y,w,h] fractions)', "- --zoom gen/t4@bottom-right (a thirds cell, or @x,y,w,h fractions)"],
  ['- pair:["gen/t3","gen/t5"]:', "- --pair gen/t3,gen/t5:"],
  ["studio_view pair", "gpt-image studio sheet --pair"],
  ["studio_get node", "gpt-image studio get <graph> --node <id>"],
  ["studio_run {resume:true}", "gpt-image studio run <graph> --resume"],
  [/studio_status \{graph:"([^"]+)", job:"([^"]+)"\} again; it waits up to 30s/g, "gpt-image studio status $1 --job $2 --wait 30 again"],
  [/studio_status \{job:"([^"]+)"\}/g, "gpt-image studio status <graph> --job $1"],
  [/studio_run \{stop:true\}/g, "gpt-image studio run <graph> --stop"],
  [/studio_view \{pair:\["([^"]+)","([^"]+)"\]\}/g, "gpt-image studio sheet <graph> --pair $1,$2"],
  ["studio_get {node}", "gpt-image studio get <graph> --node <id>"],
  ["# studio_edit ops", "# Ops (gpt-image studio edit <graph> --ops)"],
  [/studio_(create|run|status|edit|get|list|guide)\b/g, "gpt-image studio $1"],
  [/studio_view\b/g, "gpt-image studio sheet"],
  [/new_take:true/g, "--new-take"],
  [/\bwait_seconds\b/g, "--wait"],
  [/\bexpect_revision\b/g, "--expect-revision"],
  [/\bdry_run\b/g, "--dry-run"],
  [/\ball_takes\b/g, "--all-takes"],
];

export type GuideDialect = "mcp" | "cli";

/** The guide, worded for MCP tools (default) or for the CLI. */
export function guide(topic: GuideTopic = "all", dialect: GuideDialect = "mcp"): string {
  const example = dialect === "cli" ? () => CLI_EXAMPLE : () => EXAMPLE;
  const parts: Record<string, () => string> = { overview: () => OVERVIEW, nodes: nodesSection, ops: opsSection, run: () => RUN, review: () => REVIEW, handoff: () => HANDOFF, shot: shotSection, recipes: recipesGuide, example };
  let text = topic !== "all" ? parts[topic]!() : GUIDE_TOPICS.map(t => parts[t]!()).join("\n\n");
  return dialect === "cli" ? `${CLI_PREFACE}\n\n${cliWording(text)}` : text;
}

/** Rewrite MCP tool wording (studio_view {zoom}, new_take:true) into CLI commands and flags. The CLI
 *  passes everything it prints through this, so results and refusals read in its own terms. */
export function cliWording(text: string): string {
  for (const [from, to] of CLI_TERMS) text = typeof from === "string" ? text.split(from).join(to) : text.replace(from, to);
  return text;
}
