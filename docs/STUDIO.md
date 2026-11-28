# Studio: image work as a node graph

Studio lets an agent build visual work as a graph instead of a pile of one-off
generations: prompts, looks and references feed generators, a list fans one prompt
out into several images, an approved anchor feeds edits, and every image records
what made it. An approved image becomes a build package for a coding agent, and
a screenshot of the build comes back onto the graph for comparison.

Studio drives the existing generation, edit and upscale paths. It does not make
images better by itself and it has no taste; it keeps the work organised, avoids
paying twice for the same image, and makes each result traceable.

- Agents: nine `studio_*` MCP tools. Start with `studio_guide` (topic `renderer` before any paid work).
- People and programs: `gpt-image studio ...` (add `--json` for machine output).
- Looking: `gpt-image studio view` serves a read-only page on 127.0.0.1.

## Account and quota

The ChatGPT subscription is the default renderer for every node, in every project.
A node renders on the paid OpenAI Images API only when it says so: `renderer: "api"`
on a generate, edit or process node, or a `finish` node, which is the API by
definition. Every provider call passes its backend explicitly (`subscription` with
`image_model: "auto"`, or `apikey` with the resolved model), so neither a project
profile nor `GPT_IMAGE_BACKEND` can move a node between them, and nothing falls back
from one to the other. The owner's rule and its test are in "The paid API" below.

On the subscription the renderer is gpt-image-2, chosen by OpenAI. Studio accepts
quality `low` (the default, for drafts), `medium` and `high`, and sends it. A negative control on
2026-11-28 sent `high`, `max` and a nonsense value (`banana-quality-probe`): all
three returned HTTP 200 and a comparable 1254-square image in 17 to 20 seconds,
and the output item reported `quality: "low"` for every one of them. The field is
not validated, and the only signal the endpoint gives says low. Confidence: high
that the value is not validated; unknown whether it changes the render. So `xhigh`
and `max` stay refused (no evidence they do anything), and `high` should not be
described as producing a better image on the subscription.

Image generation has its own cap of roughly 24 hours, shared with ChatGPT Images
and separate from the Codex usage meter (a community report, openai/codex #49214:
a Plus account stopped after 97 images). Its 429 carries `resets_at` and
`resets_in_seconds`; the provider error and a stopped run's fix state the reset
time.

Runs spend the account's usage. Agents may run any graph without asking; each run
records how many generations it made, and a quota or rate-limit error stops the run
cleanly so it can be resumed.

## The paid API (phase 1d, 2026-11-28)

The owner's rule: "for simple day-to-day images always use the subscription"; the API
is "for things that really need refinement and massive quality". No project is ever
defaulted to the API: the profile's `studio` block may hold API defaults and spend
limits, never the renderer, and a `studio.renderer` key is refused. The test an agent
applies before choosing the API: will anyone look at this image at full size, print
it, ship it as a hero or brand asset, or does it need a size or precision the
subscription cannot give (above about 1254 px, a custom aspect, `xhigh`/`max`,
complexity)? If not, stay on the subscription.

API settings on generate, edit and process (upscale, remove-background with
`use_model`): `renderer: "api"`, `model` (`flare`, `sunburst`, `flare-2.5`,
`sunburst-2.5` or a full id; default the profile's `studio.api.model`, else
`sunburst`), `quality` (`low` to `max`), `size` (the menu, or `WIDTHxHEIGHT`: multiples
of 16, aspect 1:3 to 3:1, edges up to 3840, 655,360 to 8,294,400 pixels) and
`complexity` (`low`, `medium`, `high`; the API uses high when it is omitted). These
are refused on subscription nodes with a fix, never silently dropped. The resolved
renderer, model, quality, size and complexity are part of an API slot's fingerprint;
subscription fingerprints are unchanged by this phase.

Profile block (all optional):

```json
{ "studio": { "api": { "model": "sunburst", "quality": "low", "size": "1536x1024", "complexity": "medium" },
              "limits": { "run": 2, "day": 10, "ceiling": 50 } } }
```

The ladder: draft cheaply (Flare at `low`, about 2.5 cents at 1024 px, or the
subscription), look and approve one, then finish it. A `finish` node takes the drafts
on its `image` input and re-renders each approved take from its image through the
edit endpoint (default: the draft's aspect at 2048 px on the long edge, quality
`high`, complexity `low`, Sunburst), with an instruction that keeps composition,
subject, colour and lighting; `instruction` adds direction but cannot loosen that.
It never regenerates from the prompt: on 2026-11-28 a final from the prompt alone gave
a different teapot, one from the draft image kept it (local evidence in the git-ignored `bench/api-2.6-test/`). A
finish is never planned or priced in the same run as its drafts, since an approval
has to come between. Its take reports measured drift from the draft always, and
similarity when the perception pack is installed.

Money. Every paid API request in the tool, Studio's and direct tool calls alike, is
first reserved at its estimated cost and then settled at the cost its reported usage
implies, in two append-only ledgers with one file per local day: the project's
(`.gptimage/studio/_budget/<day>.jsonl`) and the user's across all projects
(`~/.gptimage/budget/<day>.jsonl`). Both are written under their own cross-process
locks, taken user first, then project. The limits are checked before each request,
against everything reserved that day (other graphs, projects and processes included)
and against the resume chain or tool call the request belongs to:

| Limit | Default | Counts | Raised by |
| --- | --- | --- | --- |
| Per run | $2 | the run and its resumes | a grant, or the owner editing `studio.limits.run` |
| Per direct call | the run limit | one MCP tool call or one CLI process (`count`, series and all) | as above |
| Per day | $10 | every API request in the project that local day | a grant, or the owner editing `studio.limits.day` |
| Ceiling | $50 | the same day total | only the owner editing `studio.limits.ceiling`; no grant lifts it |
| User per day | $25 | every API request in every project that local day | a grant (up to the user ceiling), or the owner editing `~/.gptimage/config.json` |
| User ceiling | $100 | the same | only the owner editing `~/.gptimage/config.json` |

The user limits live only in `~/.gptimage/config.json` (`{"limits": {"day": 25,
"ceiling": 100}}`; `$GPT_IMAGE_SECRETS_HOME/.gptimage/` when that is set), never in a
project profile, so no project can raise them. Someone with no profile and no user
config gets all the defaults above and can raise them in their own files. The run and
day defaults were accepted by the owner on 2026-11-28; both ceilings and the user day
limit are the orchestrating agent's defaults.

Direct calls: `generate_image`, `edit_image`, `upscale_image` and every other tool on
`backend: "apikey"` reserve each request under the graph name `_direct` in the project
the key is looked up in. A refusal is an error before anything is sent: "Spend limit:
...", with the fix (ask the owner once; record a grant; call again).

Fail closed: a ledger line that does not parse, or has an impossible number (a negative
cost, a missing estimate), refuses every paid request with the file and line named; it
is never skipped, so a torn write or a hand edit cannot lower a tally. An unreadable
`config.json` refuses the same way. Clock: days follow the local clock. If the clock is
set back, spend recorded under a later date still counts against today, and grants
recorded under a later date do not apply. A clock set forward starts a new day early;
the files cannot show that, which is one more reason this is a guard and not a boundary. `max_run_cost` / `max_day_cost` (CLI `--max-run-cost`,
`--max-day-cost`) lower a limit for one run and are refused if they would raise it.
A request whose cost would pass a limit is not sent: the run stops cleanly (status
`stopped`, `stopCode` `budget-run`, `budget-day` or `budget-ceiling`), and its fix
says how much the remaining work is estimated to need and tells the agent to ask the
owner once, not to work around it. A fresh run on the same graph that day is refused
(`BUDGET_STOPPED`) because it would get a new run limit; resume instead. A limit the
run lowered for itself is the agent's own caution: its fix says resuming under the
project's limits is allowed.

Grants. When the owner approves more in chat, the agent records it:
`studio_budget {grant:{amount, words, approved_by, graph?}}` (CLI
`gpt-image studio budget --grant <dollars> --approved-by <name> --words '<their words>'`).
A grant funds requests past the normal limits, up to the ceiling, for the whole
project or one graph, and ends with the local day (unused budget does not carry over).
ADE records a grant from a person's click with `--from-app` (`source: "app"`); MCP
grants are always `source: "agent"`. This is a guard against runaway mistakes by a
cooperating agent, not a security boundary: anything with shell access can edit the
profile or append a grant nobody gave. The ledger, the `budget.grant` event and
`studio_budget` are what make that visible.

Costs. Dry runs show the estimate (OpenAI's own calculator for output tokens, plus
text and image input; `auto` quality is priced as high, `auto` size as 1024x1024);
run results show what was spent from the reported usage, per take and per run. Rates
and their date live in one table, `src/pricing.ts`. Measured on 2026-11-28 (live,
local, git-ignored `bench/live-1d-2026-11-28/`): a 2.6 Flare or Sunburst low 1024x1024 draft reported
824 output tokens ($0.025); a Sunburst high 2048x2048 finish from a 1024 px draft
reported 113 text and 1,024 image input tokens and 3,568 output tokens ($0.116).

The key: `OPENAI_API_KEY` from the environment, else the project's git-ignored
`.secrets` (`OPENAI_API_KEY=sk-...` or `OPENAI_API_KEY: sk-...`), else
`~/.gptimage/secrets`. Studio looks only in the project it runs in, never in the
current directory of the MCP server. Results name the source, never the value; errors
are scrubbed of the key and of masked echoes of it before they reach a record. A
missing or refused key stops the run with the fix; nothing is rendered on the
subscription instead. See [SETUP.md](SETUP.md#paid-api-key) for ToolHub and Codex.

## Concepts

- Node types: `prompt`, `style`, `list`, `reference`, `generate`, `edit`,
  `process`, `gallery`, `handoff`, `implementation`, `note`. `studio_guide` lists
  every setting; it is rendered from the same registry that validates them.
- Edges are typed: text, style, image, package. Text, style and package inputs take
  one connection; image inputs take many. Notes attach with `settings.on`, not edges.
- Slots: a generator renders one slot per incoming list item (or per incoming image,
  for edit and process), times `takes`.
- Takes: every rendered image is a take (`node/tN`) in `assets/`, never overwritten.
  A slot is served by an explicitly selected take, else the newest take made with
  the current settings, else the newest older take (shown as stale).
- Fingerprints: a slot's fingerprint hashes its resolved text, look, settings, input
  image hashes, the project profile and the engine version. A run renders only slots
  without a take of the same fingerprint. Labels, positions, groups and notes do not
  affect it. Reordering a list reuses takes.
- Verdicts: `approve` and `reject` record who decided and why. Only approved images
  reach a handoff package.

A sweep varies one look dimension: `sweep: {dim: "shot.key_light", values: [...]}`
on a generate or edit node gives one slot per value, labelled by value on the run
sheet. With an anchor (an edit node's image, or a generator's subject reference or
canon image) each slot is an edit of the anchor that changes only the swept
dimension. Without one only the prompt wording is held: in a live key-light sweep
from a prompt (2026-11-28) the lighting followed each value and the bottle's shape
also changed, so the run result says the subject may vary and to pick a take and
sweep again as edits of it.

Canon keeps a named character, place, product or look the same across graphs and
projects. `{op:"canon_save", name, kind, takes, description}` (approved takes only)
writes `_canon/<name>/` next to the graphs: `canon.json` (the locked description,
reference files with roles and source takes, the merged measured palette, who and
when) and `ref-N.png`. Replacing an entry needs `replace: true` and moves the old
one to `history/<time>/`. A `canon` node (`settings.name`, optional
`settings.project`, stored relative) imports the references as its takes; connected
to a generator's references it adds them with their roles and appends the
description to the prompt word for word. A replaced entry re-renders its users on
the next run.

Recipes build a ready graph from a subject: `studio_create {name, recipe, subject,
path?}` with `lookbook`, `character-sheet`, `product-set` (needs `path`, the
product photo), `storyboard` or `page-mock`. Each follows the working order in
`studio_guide {topic:"recipes"}`: cheap thumbnails for composition, then lighting
and value, then colour, then one final; variations are edits of an anchor.

An example spec to start from is
[examples/studio/product-lookbook.json](../examples/studio/product-lookbook.json):
`gpt-image studio create --spec @examples/studio/product-lookbook.json`, or pass its
contents to `studio_create`. Run `draft`, pick one image in `anchor`
(`{op:"pick", node:"anchor", takes:["draft/t2"]}`), then run the rest; without a
pick every draft is edited.

## Looking and judging

`studio_guide {topic:"review"}` is the full text. In short: there is no absolute
better, only better for the stated intent. Evidence from most to least reliable:
checkable defects, the request against the measured reading, drift from the
anchor, blind pairwise critique (opinion), and above all the human's choice.

Every saved image gets a local reading and, where the request or the anchor
implies something measurable, deviations. The reading includes letterbox or
pillarbox bars (uniform dark bars on two opposite edges, with their size); bars
the request did not ask for are a deviation. Warm and cool asked together (blue
hour with lamplight, a teal and amber grade) is one mixed-temperature request,
met when the palette holds both. Generate and edit takes also get a checklist of
yes/no questions an agent can answer by looking: the subject, counted objects,
stated positions, labelled layers, literal quoted text, exclusions, the shot
settings that were set and the brief. Clauses that are none of these are left
out rather than turned into half-questions. A run writes one review sheet of its new images, labelled with the setting
that differs, and `studio_status` lists sheet, deviations, readings and checklists.
`studio_view` adds overlays (thirds grid with the visual-weight centre, palette,
histogram), full-resolution zooms and blind A/B pairs.

For a person, `gpt-image studio page <graph>` (or `studio_view {page: {...}}`)
writes a self-contained static folder: `index.html` plus copies of the images
named `NN-<case>-<node>.png`. Takes are grouped by the list item they came from,
with its text; nodes that share the items sit side by side, and a finish sits
under the case of the take it finished. Each image opens at full size and shows
what made it, its cost, its reading and its deviations, re-measured from the
pixels when the page is built. `--zoom "[N:]x,y,w,h[=label]"` (repeatable) adds
crops of the same fractions from every image of a case (case N only with `N:`).
The page holds no verdicts, critiques or approvals. Default folder:
`views/page-<time>/`; it never overwrites an `index.html` it did not write. A
finish whose size has a different aspect from its draft is noted in the plan with
the nearest size that keeps the draft's aspect.

An agent cannot approve a take until it has recorded a look (checklist answers or
a critique); the refusal names the op to send. People approve freely: ADE and the
CLI pass `--human`. Readings measure; they do not prove an image is better.

Known limit: the gate checks that a look was recorded, not that it is true. In the
2026-11-28 fresh-agent test an agent described a cream teapot as cobalt, was
allowed to approve it, and saved a canon description contradicting the image.
One cheap guard exists: when a critique (not a comparison) or a canon description
names a colour family that the image has no pixels of, the edit result carries a
warning in its notes (text and `--json` alike). Each named colour is checked on its
own hue range plus 10 degrees each side: readings carry `hues` (share of saturated
pixels per family) and `hueHistogram` (72 bins of 5 degrees). Readings stored
before the histogram fall back to the family plus both neighbouring families. It
never blocks, it ignores negations such as "no blue", and it checks only colour
presence: a wrong shape, count or identity passes.

Messages name the next command in the caller's terms: MCP calls such as
`studio_run {graph:"x", resume:true}`, or CLI commands such as
`gpt-image studio run x --resume`. Every such reference is built in
`src/studio/say.ts`. The CLI sets its dialect at startup (`--json` output included),
and a run's worker keeps the dialect of whoever started it, so the fixes stored in
a run record read the same way as the command that started it.

Study an image someone admires with `studio_view {study: "path"}` (or a take ref
plus `graph`; CLI `gpt-image studio study`): the local reading, plus shot language
from one subscription vision request, returned as a ready style node. If the
vision request fails, the reading still comes back.

## Memory: lessons, taste and calibration

Lessons are claims settled by at least two takes, written with the `lesson` op:
`{claim, dimension, evidence: [{graph, takes}], support, date, by, renderer,
scope, supersedes?}`, one file each in `_lessons/` (project) or
`~/.gptimage/studio/_lessons/` (user; `GPT_IMAGE_STUDIO_HOME` moves it). This
tool had no user-level config before, so the user store mirrors the project
layout under the home folder. A lesson is never edited: a newer one names it in
`supersedes`, and only lessons nobody superseded are active. Ranking is support,
halved every 90 days, because OpenAI can change the routed renderer.

Taste is counted from people's decisions (`human: true` in `feedback.jsonl`, set
by ADE and the CLI's `--human`): how many low-key, warm, centred, or a given shot
value they kept or dropped, reported only for buckets with two or more decisions,
as counts. Calibration compares each `predict` made before a person's first
decision on that take with the decision; the project rate comes from the
project's feedback, and the overall rate from `calibration.jsonl` in the user
store. `studio_create` and `studio_guide` return the active lessons, the taste
counts and the agreement rate without being asked.

## Handoff and implementation

A handoff node writes `handoff/<name>/`:

- `handoff.md`: intent, target, must match, flexible, approved mocks with who
  approved them, measured colours, cut-outs, review notes, lineage, and the exact
  calls to report the build back.
- `mock-N.png`, `cutouts/`, `manifest.json` (the same content, machine-readable).

Colours are dominant clusters measured from pixels and are labelled as
observations, not design tokens. Cut-outs are remove-background results upstream of
the handoff or made from anything in the approved image's lineage. A rerun replaces
the package folder; the source images stay in `assets/`.

An `implementation` node connected from the handoff takes the build's screenshot
(`settings.screenshot`) and, when run, copies it in and writes
`<node>-<take>-compare.png`: mock and build side by side. Nothing scores the
comparison; an agent or a person looks at it.

## Running

`studio_run` starts a job and returns its id; it waits up to `wait_seconds`
(default 20) before returning. `studio_status` reports progress and waits up to 30
seconds per call. The job runs in a detached worker process (`gpt-image studio
worker`), so it survives a client timeout and the MCP server being stopped.

- Scope: `all`, `<id>`, `<id>+` (node and everything downstream), or `nodes: [...]`.
- `dry_run` plans without spending: generations, reused slots, skipped nodes.
- `new_take` renders one more take for every slot in scope.
- `concurrency` 1 to 3, default 1. Sequential is the default because of quota and
  token refresh (see [ARCHITECTURE.md](ARCHITECTURE.md#single-flight-refresh-important)).
- One run per graph at a time; a second is refused with the running job's id.
- `stop` asks the live run to stop after its current image. `resume` continues the
  last stopped or interrupted run and never repeats a finished slot.
- A node that fails is marked failed with its fix; independent branches continue.
  Quota and authentication errors stop the whole run.
- Running one node uses its upstream outputs as they are; the snapshot says when
  upstream is out of date.

## Storage contract

Per project: `<project>/.gptimage/studio/<slug>/`. Other programs (ADE) read these
files directly and change them only through the CLI. Treat this section as a public
interface; schema names carry a version.

| File | Writer | Content |
| --- | --- | --- |
| `graph.json` | edits | `gpt-image-studio/graph@1`: name, slug, `revision`, nodes (id, type, label, group, position, settings), edges (from, fromHandle, to, toHandle), groups (id, label, stage). Stable key order and sorted edges for readable diffs. |
| `state.json` | edits and runs | `gpt-image-studio/state@1`: `revision`, `eventSeq`, `nextTake`, and per node: `takes`, `selected`, gallery `picks`, `error`, and `activity` while a run works on it. |
| `events.jsonl` | every write | One JSON object per line: `seq`, `ts`, `type`, `actor`, `graphRevision`, details. Rotated to `events.1.jsonl` past 1 MB. |
| `feedback.jsonl` | edits | Append-only verdicts, picks, predictions and comments, each with the take's settings and reading. Never rotated. |
| `runs/<job>.json` | the run's worker | `gpt-image-studio/run@1`: status, scope, planned and done counts, generations, completed slot keys, new takes, skips, errors, stop reason and fix, and `origin: {terminal?, workspace?}` when the run was started from an ADE terminal (`HEPHAESTUS_TERMINAL_ID` / `HEPHAESTUS_WORKSPACE` in the starting process). Phase 1d adds `stopCode?` (`budget-run`, `budget-day`, `budget-ceiling`, `budget-user-day`, `budget-user-ceiling`) and `budget?: {chain, limits: {run, day, ceiling}, estimate, spent, chainSpent?, needed?}` in dollars. |
| `../_budget/<YYYY-MM-DD>.jsonl` | runs, direct API calls, `budget --grant` | Per project, next to the graph folders, one file per local day. One JSON object per line with `schema: "gpt-image-studio/budget@1"` and `t`: `reserve` `{id, ts, day, run, chain, graph, node, slot, estimate, model, funding: "limit"\|"grant:<id>", by}` (`graph` is `_direct` for tool calls outside Studio), `settle` `{id, ts, cost, uncertain?, take?, note?}` (in the reservation's day file; ids `s<YYYYMMDD>-...` name it), `grant` `{id, ts, day, amount, graph?, approvedBy, words, expires, source: "agent"\|"app", by}`. Append-only, under `_budget/.lock`. A reservation without a settlement counts at its estimate. `_budget/ledger.jsonl` (2026-11-28 only, before per-day files) is still read, never written. |
| `~/.gptimage/budget/<YYYY-MM-DD>.jsonl` | the same writers | User level, across projects: `reserve` `{id, ts, day, project, graph, estimate, funding, by}` and `settle` `{id, ts, cost}`, same schema and ids. User limits: `~/.gptimage/config.json`. |
| `assets/` | runs, reference imports | Image files. Generated ones keep the usual JSON sidecar. |
| `handoff/<name>/` | handoff runs | The package above. |

Rules:

- Within one schema version, fields are only ever added and optional; readers ignore
  fields they do not know. Renaming, removing or changing the meaning of a field
  needs a new version.
- Every write takes `.lock` (exclusive create, holder pid/host/actor inside; a lock
  older than 30 s or held by a dead local process is taken over), reads, changes,
  writes by temp file plus fsync plus rename, then releases. Readers never see a
  partial file and need no lock; on Windows a read can briefly fail with
  EPERM/EBUSY during a rename, so retry.
- `graph.revision` changes only when the definition changes. `state.revision` changes
  on every write. `studio_edit` / `--expect-revision` refuses an edit if
  `graph.revision` moved, so a person's edit made against an old view is refused,
  not merged. Runs do not bump `graph.revision`.
- Events: `seq` strictly increases, gaps are possible (state is written before the
  event). To follow live, remember the last `seq` and read lines after it; if the
  file shrank, read `events.1.jsonl` first.
- `run.lock` holds the live job (job, pid, host). The worker touches it every 5 s.
  A run is live while that file's mtime is under 60 s old and its process exists.
  A `starting`/`running` record without a live lock is interrupted.
- `node.activity` is meaningful only while its job is live.
- Paths: settings paths (`reference.path`, `implementation.screenshot`) are
  project-relative; takes' `asset` and `files` are relative to the graph folder;
  all use forward slashes. Files outside the project are copied into `assets/` as
  `import-<hash>`, so no absolute path is ever stored. A cloned or moved project
  keeps working and its fingerprints stay valid.
- `_canon/` and `_lessons/` sit next to graph folders (slugs cannot start with
  `_`). `_canon/<name>/canon.json` has schema `gpt-image-studio/canon@1`. `perception` on a take holds optional model-based
  readings keyed by capability (`{version, source, ...}`, source naming the model and its revision);
  see "Perception pack".
- Review fields on a take, all optional: `reading` (local measurements,
  `{version: 1, source: "local", palette, luminance, contrast, color, composition,
  sharpness, detail, frame?}`; `frame` is added 2026-11-28 and present only when bars
  were measured: `{kind: "letterbox"|"pillarbox", top, bottom, left, right, colour,
  picture: {width, height}}`), `deviations` (`{source: "anchor"|"request", measure,
  expected, measured, note}`), `checklist` (`{id, question, from, answer?, by?,
  at?, note?}`, answers yes/no/unsure), `critiques` (`{id, judge, at, summary,
  criteria?, against?, preferred?, blind?}`), `predictions`, `verdict`. A run
  record's `sheet` is the graph-relative path of its review sheet in `views/`.
- Phase 1d take fields, all optional: `render` on every provider take
  (`{renderer: "subscription"|"api", model, quality?, size?, complexity?}`; the
  subscription's model is recorded as `gpt-image-2 (server-chosen)`), and on API takes
  `usage` (the API's numeric usage fields) and `cost` (`{dollars, estimate, rates,
  funding, keySource?}`; `keySource` names where the key came from, an env variable or a file
  path, never the key). Node type `finish` is new. Events: `take.saved` gains `cost?` and
  `funding?`, `run.finished` gains `stopCode?` and `cost?`, and `budget.grant` is
  written to a graph's log when a grant is scoped to it. Lessons gain a `renderer`
  value naming the model of their evidence (`api gpt-image-2.6-sunburst`,
  `subscription gpt-image-2`, or `mixed: ...`).
- Blind pairs: `views/pair-<id>.json` maps A and B to takes. The sheet hides the
  order; the JSON does not, so blindness depends on the judge not opening it.

Git: `<graph>/.gitignore` (written once, ours) ignores only transient files: locks,
temp files, `.previews/`, `views/`, run logs and stop flags. Assets and handoffs
stay tracked, because the graph refers to them and a clone should still work.
Studio never edits the project's own `.gitignore`. To keep images out of git, add
`.gptimage/studio/*/assets/` there yourself.

## Other projects

Every tool takes `project`. Without it, Studio uses `GPT_IMAGE_PROJECT_DIR`, then
`CLAUDE_PROJECT_DIR`, then the current directory, and reports which one it used.
Reading another project's graphs and copying from them (`studio_create` with
`copy_from: {project, graph}`, or a `reference` whose path is in that project) are
allowed. Writes go only to the project passed, so a write into another project
requires naming it.

## CLI

```text
gpt-image studio list | guide [topic] | get <graph> [--node id] [--raw]
gpt-image studio create --spec <json|@file|->
gpt-image studio edit <graph> --ops <json|@file|-> [--expect-revision N]
gpt-image studio run <graph> [--scope s] [--nodes a,b] [--new-take] [--concurrency n]
                     [--dry-run] [--resume] [--stop] [--wait s] [--foreground]
                     [--max-run-cost dollars] [--max-day-cost dollars]
gpt-image studio status <graph> [--job id] [--wait s]
gpt-image studio budget [--graph g]
gpt-image studio budget --grant <dollars> --approved-by <name> --words '<their words>' [--graph g] [--from-app]
gpt-image studio nodes                 (the node registry: handles, setting docs, kind of work)
gpt-image studio sheet <graph> [--nodes a,b] [--all-takes]
gpt-image studio page <graph> [--nodes a,b] [--zoom "[N:]x,y,w,h[=label]"]... [--out dir] [--title t]
gpt-image studio events <graph> [--after seq] [--limit n]
gpt-image studio view [graph] [--port n] [--idle-exit minutes]
gpt-image studio perception [status | install --yes]
common: --project <dir> --actor <name> --json
```

With `--json`, stdout is one JSON object: `{"ok": true, ...}` or
`{"ok": false, "error": {"code", "message", "fix", "issues"}}` with exit code 1.
`--actor` is recorded on every write and in `feedback.jsonl`.

`run` reports a `status` to branch on, with exit code 0: `starting` (a run began;
`job` is its id), `dry-run` (the plan, nothing spent), `blocked` (nothing in scope
can run until the nodes in `plan.skipped` are fixed; no run was started),
`nothing-to-do` (everything in scope is current); with `--stop`, `stopping`, or `none`
or the last run's status when no run is live.
A refusal (for example another run in progress) is `ok: false` with exit code 1.

## Perception pack (optional)

Small open models for what arithmetic on pixels cannot measure. Off by default and
never bundled: `gpt-image studio perception` shows what an install would download
(about 518 MB) and the licences; `gpt-image studio perception install --yes` runs
`npm install` of `@huggingface/transformers` 4.3.2 (Apache-2.0, pulling
onnxruntime-node and onnxruntime-web, MIT) into one folder per user,
`~/.gptimage/perception/` (`GPT_IMAGE_STUDIO_HOME` overrides home), and fetches the
pinned models once (each checked by revision, the mask file also by sha256). Run workers load it lazily with remote downloads switched off;
the MCP server never loads it. Without it everything else works unchanged.

Two capabilities, each measured on real images before it was kept.

Similarity: `onnx-community/dinov2-small` at revision
`8b1f705a3a7f` (quantized, 24 MB; licence Apache-2.0 from the
`facebook/dinov2-small` model card, the ONNX conversion has none of its own). Every
take with an anchor (an edit's image, a subject reference, a canon image, a sweep
anchor) gets `perception.similarity = {version, source, runtime, to, cosine}`, and the
run result shows it. It is the cosine of DINOv2 embeddings: it tracks subject and
shape, not colour (colour drift stays in the local reading). Measured 2026-11-28 on
real images: identical 1.000; the same bottle relit by an anchored sweep 0.961 and
0.852; a prompt-only sweep whose bottle changed shape 0.705 (0.921 for the pair that
kept it); bottle against teapots 0.06 to 0.09; a cobalt and a cream teapot 0.919.
Nine pairs do not calibrate a threshold, so no deviation is raised from it yet. If
the pack is broken, the take gets a warning and the run continues.

Foreground mask: U-2-Netp (`BritishWerewolf/U-2-Netp` at `7112208dbac3`, 4.6 MB,
Apache-2.0), run directly on onnxruntime-node because transformers.js has no U-2-Net
model type. Every take gets `perception.mask`: the salient foreground's coverage,
box, centroid, the frame edges it touches, a count of separate regions, and the
share of pixels the model is unsure about. It finds salient foreground, not "the
subject": touching objects are one region (the shelf scene's cups, utensils and
teapot read as one). Measured 2026-11-28 on eight real images, each mask opened as an
overlay: tight on the bottle (coverage 0.173, then 0.176 relit), both teapots (0.236,
0.235), the shelf scene (0.289) and the flat fox mascot (0.372). On the coded page
screenshot and the branding board it marked large panels touching three edges
(0.617, 0.632) while its uncertainty stayed low (0.032, 0.009), so uncertainty cannot
flag that failure; instead any foreground touching two or more edges or covering over
half the frame is reported as `subject: "unclear"` with no position numbers.

Left out, with the evidence (2026-11-28):

- Depth (Depth Anything V2 small, `onnx-community/depth-anything-v2-small`). On the
  photos its subject-versus-rest separation (0.49 to 0.62, 0.27 for the busy shelf)
  restated what the mask already shows. On the flat fox illustration it reported
  0.60, inside the photo range: it invents depth on flat art, so the number cannot
  tell a flat graphic from a photographed object.
- Text reading (tesseract.js 7.0.0, English `4.0.0_best_int`). It read clean
  rendered cards exactly, including a deliberate misspelling ("FRESH BRAED DIALY")
  and the Segoe Script, Gabriola, Chiller and Brush Script fonts. On ornate scripts it
  failed (Edwardian "Dette Neate", Kunstler nothing, Blackadder "BT Notte"). On three
  low-quality live generations, a chalkboard "FRESH BREAD DAILY", the same sign
  deliberately misspelled, and copperplate "Bella Notte" (all rendered as asked), it
  returned noise, even after grayscale, inversion, contrast stretch and sparse-text
  mode, and three of those passes returned empty text at confidence 95. Generated
  lettering in a scene is the only case Studio needs it for, so the provider's
  vision proofread (`proof`, on by default with `style.text`) stays the text check.

## Viewer

`gpt-image studio view` serves one self-contained page on 127.0.0.1 (port 4780, or
a free one): pan, zoom, groups, edges, thumbnails, take history, full-size preview
and live refresh from the event log. It is read-only, answers only GET requests
with a local Host header, and serves only files under a graph's `assets/`,
`handoff/`, `views/` and `.previews/`. `studio_view` with `serve: true` starts it
detached; it exits after 30 idle minutes.

## Why the MCP surface looks like this

Eight tools, because each schema costs context in every terminal. Ops travel as
data inside `studio_edit` rather than as separate tools. Handoff and
implementation are nodes plus `studio_run`, not extra tools. Viewing is one tool:
an agent needs a labelled contact sheet and paths, not a server.
