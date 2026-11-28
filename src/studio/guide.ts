// The Studio guide: everything an agent needs to drive Studio, rendered from the node registry so the
// documented settings are exactly the validated ones.

import { NODE_SPECS, NODE_TYPES, SHOT_DIMENSIONS } from "./nodes.js";
import { OP_HELP } from "./graph.js";
import { recipesGuide } from "./recipes.js";
import { cmd, isCli, opt, tool, withDialect, type Dialect } from "./say.js";

/** A boolean option as the caller writes it: new_take:true or --new-take. */
const flag = (name: string) => (isCli() ? opt(name) : `${name}:true`);

export const GUIDE_TOPICS = ["overview", "renderer", "nodes", "ops", "run", "review", "handoff", "shot", "recipes", "example"] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number] | "all";

const overview = () => `# Studio: image work as a graph

A graph lives in <project>/.gptimage/studio/<slug>/. Nodes are prompts, looks, lists, references,
generators, edits, post-processing, galleries, handoffs and notes. Data flows along typed edges:
text -> text, style -> style, image -> image, package -> package. Text, style and package inputs take
one connection; image inputs take many.

How to work:
1. ${tool("create")} with nodes (your own short ids) and connections. Handles are picked by type.
2. ${tool("run")} starts a background job and returns its id (it waits up to ${opt("wait_seconds")}, default 20).
   ${tool("status")} follows it (waits up to 30s per call). Runs survive client timeouts.
3. Look: the run result names a review sheet, measured deviations and a checklist per take; open the
   sheet. ${tool("view")} makes more sheets, zooms and blind pairs. Never judge an image you have not
   opened. Topic review explains what "better" means here.
4. Revise with ${tool("edit")} ops (set, prompt_edit, connect...). Rerun: only slots whose inputs or
   settings changed are regenerated; everything else is reused. ${flag("new_take")} adds another take.
5. Record what you saw (op answer or critique), approve the image you want (op approve), then run the
   handoff node to write a build package for the coding agent. When the build exists, attach its
   screenshot with an implementation node.

Rules that save quota, money and mistakes:
- Every node renders on the ChatGPT subscription unless it says renderer:"api", or is a finish node.
  The subscription is free, uses gpt-image-2, and ignores quality and size: it reports "low" for every
  value and saves about 1254 px (tested 2026-11-28), so do not expect high to look better there.
  Drafts default to quality low on either renderer.
- The paid API (GPT-Image-2.6) is for quality work only. Read topic renderer before choosing it.
- Images have their own cap of roughly 24 hours, shared with ChatGPT Images and separate from the
  Codex usage meter (reported around 97 images on Plus). When it is hit the run stops and its fix
  says when the cap resets; resume after that.
- A list node fans out: one slot per item. takes:N gives N images per slot.
- Images are never inlined: every take is a file in assets/ with a fingerprint and lineage.
- Every refusal names its fix. Unknown settings are rejected with the valid names.
- ${opt("expect_revision")} on ${tool("edit")} refuses an edit if someone changed the graph meanwhile.
- Other projects: pass ${opt("project")} to list, read or copy (copy_from). Writes go only to the project
  you pass (default: this one).
- One run per graph at a time; a second is refused with the running job id.
- Quota or rate limit stops the run cleanly; ${cmd("run", { graph: "<graph>", resume: true })} continues where it stopped.`;

const renderer = () => `# Renderer: subscription by default, the paid API only for quality work

The owner's rule (2026-11-28): "for simple day-to-day images always use the subscription";
the API is "for things that really need refinement and massive quality". So the subscription is the
default everywhere, including the owner's own projects, and no project is ever defaulted to the API.

Before choosing the API, ask: will anyone look at this image at full size, print it, ship it as a hero
or brand asset, or does it need a size or precision the subscription cannot give (above about 1254 px,
a custom aspect, xhigh/max quality, complexity control)? If not, stay on the subscription.

The ladder, when it is a yes:
1. Draft cheaply: renderer:"api" with model:"flare" (GPT-Image-2.6 Flare) and quality:"low", or simply
   draft on the subscription. Several takes or a list are fine: a low 1024x1024 draft is about 2.5 cents.
2. Look, record an answer or critique, approve the one to finish ({op:"approve", take:"draft/t3"}).
3. Finish it: a finish node connected to the drafts re-renders each approved take from its image
   through the API's edit endpoint, at a larger size (default the draft's aspect at 2048 px on the long
   edge) and quality high, with an instruction that keeps composition, subject, colour and lighting.
   Never regenerate a final from the prompt: on 2026-11-28 a final made from the prompt alone gave a
   different teapot; one made from the draft image kept it. The finish take reports its similarity to
   the draft when the perception pack is installed, and its measured drift from the draft always.

  {op:"add", id:"final", type:"finish", settings:{size:"2048x2048"}}, {op:"connect", from:"draft", to:"final"}

API settings on generate, edit and process (upscale, remove-background with use_model):
renderer:"api", model (flare | sunburst | flare-2.5 | sunburst-2.5 | full id; default sunburst),
quality (low, medium, high, xhigh, max), size (the menu or WIDTHxHEIGHT: multiples of 16, aspect 1:3 to
3:1, edges up to 3840, 655,360 to 8,294,400 pixels), complexity (low | medium | high planning effort;
the API uses high when it is not set). Defaults for API nodes may come from the project profile
(.gptimage.json "studio": {"api": {"model", "quality", "size", "complexity"}}); the renderer itself
never does. The renderer and model are part of each slot's fingerprint and recorded on every take.

What it costs (OpenAI's calculator for GPT-Image-2.6, output tokens only, checked 2026-11-28):
low 1024x1024 about 2.5 cents, medium 4.3, high 5.3, xhigh 9.4, max 21; high 2048x2048 about 11 cents;
high 3840x2160 about 10 cents. Text and image inputs add a little (seven images measured 42 cents,
about 9 percent above the output-only figures). Every API take records the usage the API reported and
its cost; a dry run shows the estimate; the run result shows what was actually spent.

Spend limits (the owner's defaults, 2026-11-28): 2 dollars per run (a resumed run keeps counting against
the same limit) and 10 dollars per day per project, checked before every API request across every run
and process; and a hard daily ceiling (default 50 dollars) that no grant lifts, only the owner editing the profile. Inside
the limits you may run without asking. ${opt("max_run_cost")} and ${opt("max_day_cost")} lower them for one run;
nothing you pass raises them.
When a limit stops a run, the result says how much the remaining work needs. Then:
- Ask the owner once, with that amount. Do not work around the limit: no fresh run (it is refused
  anyway after a spend stop the same day), no switching renderer to sneak past it, no retry loop.
- Only after the owner approves in chat, record the grant with their words:
  ${isCli() ? "gpt-image studio budget --grant 5 --approved-by <owner> --words 'approve, 5 dollars for the hero finals'" : 'studio_budget {grant:{amount:5, approved_by:"<owner>", words:"approve, 5 dollars for the hero finals"}}'}
  A grant ends with the local day and never carries over. Then resume the run.
- ${tool("budget")} shows limits, today's spend by graph, grants and what is left. It is a guard against
  runaway mistakes, not a security boundary: an agent with a shell could record a grant nobody gave,
  and the ledger (.gptimage/studio/_budget/ledger.jsonl) is what shows the owner it happened.

The key: OPENAI_API_KEY from the environment, else the project's git-ignored .secrets file
(OPENAI_API_KEY=sk-... or OPENAI_API_KEY: sk-...), else ~/.gptimage/secrets. Results say which source
was used, never the value. Never print, paste or log the key. A missing key is a refusal that names
the fix; nothing ever falls back from the API to the subscription or the other way round.

Lessons carry the renderer they were learned on. A lesson from subscription images (gpt-image-2) is not
known to hold on Sunburst; ${tool("guide")} lists the lessons for the renderer you name first.`;

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
  return [`# Ops (${isCli() ? "gpt-image studio edit <graph> --ops '[...]'" : "studio_edit {graph, ops:[...]}"})`, "", "All ops in one call apply together or not at all.", "", ...Object.values(OP_HELP).map(v => `- ${v}`), "",
    `Take refs look like "gen/t4" (node/take). ${cmd("get", { graph: "<graph>", node: "<id>" })} lists them with file paths.`,
    "Verdicts and picks are recorded with the take's settings in feedback.jsonl (the owner's taste record)."].join("\n");
}

const run = () => `# Running

${isCli()
  ? "gpt-image studio run <graph> [--scope all|id|id+] [--nodes a,b] [--new-take] [--concurrency 1-3] [--dry-run] [--resume] [--stop] [--wait s]"
  : "studio_run {graph, scope?, nodes?, new_take?, concurrency?, dry_run?, resume?, stop?, wait_seconds?}"}
- scope: "all" (default), "<id>" for one node, "<id>+" for a node and everything downstream.
  nodes: a list of ids runs a selection.
- ${flag("dry_run")} returns the plan (generations, cached slots, skipped nodes, the compiled prompt of
  one slot per node) and spends nothing.
- Unchanged slots are never regenerated. A slot is unchanged when its fingerprint (resolved text,
  look, settings, input image hashes, project profile) matches an existing take.
- ${flag("new_take")} renders one more take for each slot in scope; history is kept.
- concurrency 1-3 (default 1, sequential; quota and token refresh favour sequential).
- Running one node uses its upstream outputs as they are. If upstream is out of date the snapshot
  says so; run "<upstream>+" to refresh the chain.
- ${flag("stop")} asks the live run to stop after its current image. ${flag("resume")} continues the last
  interrupted or stopped run.
- Each run records how many generations it made (runs/<job>.json).`;

const review = () => `# Looking and judging

There is no absolute better, only better for the stated intent. Evidence, most reliable first:
1. Checkable defects: warped hands or objects, garbled text, smears, extra limbs. Zoom in to see them.
2. The request against the measured reading: asked for low key, measured high key.
3. Measured drift from the anchor (palette, lightness, contrast, temperature, saturation).
4. Blind pairwise critique. This is opinion, and model judges lean toward a generic polished look.
5. Above all of these: the human's choice.

What a run already gives you (${tool("status")}): one review sheet labelled with the setting that differs,
measured deviations first, a one-line reading per take, and each take's checklist.
- Reading: palette with shares, lightness key, contrast, warm/cool, saturation, visual weight by
  thirds, quiet space, where it is sharpest, edge density. Measurements, not a score.
- Deviations: where the reading contradicts the request or drifts from the anchor image. Confirm them
  by looking; a measurement can be wrong about intent.
- Checklist: yes/no questions from the prompt and shot settings. Answer them after looking:
  {op:"answer", take:"gen/t4", answers:{c1:"yes", c2:"no", c3:{answer:"unsure", note:"hand hidden"}}}

Looking closer:
- ${cmd("view", { graph: "<graph>", overlays: ["grid", "palette", "histogram"] })}: thirds grid with the
  visual-weight centre, colour shares, lightness.
- ${cmd("view", { graph: "<graph>", zoom: { take: "gen/t4", region: "bottom-right" } })} (a thirds cell, or
  x,y,w,h fractions): full resolution.
- ${cmd("view", { graph: "<graph>", pair: ["gen/t3", "gen/t5"] })}: a blind A/B sheet in random order;
  record it with {op:"judge_pair", pair:"p...", preferred:"A", reason:"..."}.

Keeping things the same across images:
- Anchor: approve one image and make variations as edits of it (edit node, image handle), not
  fresh generations. Deviations then report drift from the anchor.
- Canon: save approved takes as a named entry with a locked description:
  {op:"canon_save", name:"mira", kind:"character", takes:["gen/t4"], description:"..."}.
  Any graph (another project too, settings.project) adds {type:"canon", settings:{name:"mira"}} and
  connects it to a generator's references. Its images go in with their role and its description is
  added to the prompt word for word. Write the description once, carefully: rewording is drift.
  ${tool("list")} shows the project's canon.
- Identity of a face, character or product is not measured by the local reading; check it with a
  blind pair. With the optional perception pack (${isCli() ? "gpt-image studio perception" : "installed from the command line, see docs/STUDIO.md"}), takes with an anchor
  also carry a DINOv2 similarity to it (subject and shape, not colour; no threshold calibrated yet), and
  every take a U-2-Netp foreground reading (coverage, position, edges touched; "unclear" on layouts).

Learning from an image someone admires: ${cmd("view", { study: "images/admired.png" })} (or a take ref
with its graph) returns its measurements plus the look in shot language from one vision request, as a ready
{op:"add", type:"style", ...}. It names the dimensions of a look to learn from; it is not a copy
function, and the vision part is an opinion to check against the image.

Recording a judgement:
- {op:"critique", take, summary, criteria?, against?, preferred?}: what you saw, in words.
- An agent cannot approve a take without a recorded look (a critique or checklist answers). Put the
  look and the approve in the same ${tool("edit")} call. People approve freely.
- The gate checks that a look was recorded, not that it is true. A test agent described a cream
  teapot as cobalt, was accepted, and saved a canon description that contradicted the image. Open
  the image before you write about it. One cheap guard: a critique or canon description naming a
  colour family the image has no pixels of gets a warning in the result notes (never a refusal).
- Lessons: when a sweep or several takes settle something, record it so later sessions start from
  it: {op:"lesson", claim, dimension, takes:[2+ takes], scope?:"project"|"user", supersedes?}. One
  take is never a lesson. Lessons are superseded, never edited; old ones weigh less because the
  routed renderer can change. ${tool("create")} and ${tool("guide")} list the active ones, with the owner's
  taste in counts (what people kept and dropped) and the prediction agreement rate.
- Calibration: before the human decides, record your own call with {op:"predict", take,
  decision:"approved"|"rejected"|"picked", reason}. It is compared with the human's decision later;
  a prediction made after the human decided does not count.`;

const handoff = () => `# Handoff to a coding agent, and back

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

const mcpExample = `# Worked example

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

const CLI_PREFACE = `You are using the CLI (gpt-image studio). Other agents reach the same operations as MCP
tools; this copy of the guide is written for the CLI. create --spec, edit --ops and run take JSON
inline, @file or - (stdin), and ops JSON is the same everywhere. Flags: --new-take, --dry-run,
--wait <s>, --expect-revision <n>, --project <dir>, --json. Topics: gpt-image studio guide <topic>.`;

export type GuideDialect = Dialect;

/** The guide in the caller's dialect (or the one given): MCP tool calls, or CLI commands and flags. */
export function guide(topic: GuideTopic = "all", d?: GuideDialect): string {
  return withDialect(d, () => {
    const parts: Record<string, () => string> = { overview, renderer, nodes: nodesSection, ops: opsSection, run, review, handoff, shot: shotSection, recipes: recipesGuide, example: () => (isCli() ? CLI_EXAMPLE : mcpExample) };
    const text = topic !== "all" ? parts[topic]!() : GUIDE_TOPICS.map(t => parts[t]!()).join("\n\n");
    return isCli() ? `${CLI_PREFACE}\n\n${text}` : text;
  });
}
