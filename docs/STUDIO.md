# Studio: image work as a node graph

Studio lets an agent build visual work as a graph instead of a pile of one-off
generations: prompts, looks and references feed generators, a list fans one prompt
out into several images, an approved anchor feeds edits, and every image records
what made it. An approved image becomes a build package for a coding agent, and
a screenshot of the build comes back onto the graph for comparison.

Studio drives the existing generation, edit and upscale paths. It does not make
images better by itself and it has no taste; it keeps the work organised, avoids
paying twice for the same image, and makes each result traceable.

- Agents: eight `studio_*` MCP tools. Start with `studio_guide`.
- People and programs: `gpt-image studio ...` (add `--json` for machine output).
- Looking: `gpt-image studio view` serves a read-only page on 127.0.0.1.

## Account and quota

Studio uses the ChatGPT subscription backend only and never the paid API. Every
provider call passes `backend: "subscription"` and `image_model: "auto"`
explicitly, so neither a project profile nor `GPT_IMAGE_BACKEND` can move a run onto
API billing. The renderer is whatever OpenAI routes.

Quality is the one lever: `low` (the default, for drafts), `medium`, `high`.
`xhigh` and `max` are refused, because this tool only allows them with an explicitly
selected API renderer. `high` was accepted by a live subscription request on
2026-11-27; the provider does not report which quality it actually applied.

Runs spend the account's usage. Agents may run any graph without asking; each run
records how many generations it made, and a quota or rate-limit error stops the run
cleanly so it can be resumed.

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
| `runs/<job>.json` | the run's worker | `gpt-image-studio/run@1`: status, scope, planned and done counts, generations, completed slot keys, new takes, skips, errors, stop reason and fix. |
| `assets/` | runs, reference imports | Image files. Generated ones keep the usual JSON sidecar. |
| `handoff/<name>/` | handoff runs | The package above. |

Rules:

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
- Reserved: `_canon/` and `_lessons/` next to graph folders (slugs cannot start
  with `_`). Take fields reserved for review: `reading`, `perception`, `checklist`,
  `critiques`, `predictions`, `verdict`.

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
gpt-image studio status <graph> [--job id] [--wait s]
gpt-image studio sheet <graph> [--nodes a,b] [--all-takes]
gpt-image studio events <graph> [--after seq] [--limit n]
gpt-image studio view [graph] [--port n] [--idle-exit minutes]
common: --project <dir> --actor <name> --json
```

With `--json`, stdout is one JSON object: `{"ok": true, ...}` or
`{"ok": false, "error": {"code", "message", "fix", "issues"}}` with exit code 1.
`--actor` is recorded on every write and in `feedback.jsonl`.

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
