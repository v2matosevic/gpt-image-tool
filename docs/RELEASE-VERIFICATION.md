# Public source release verification

This is the canonical release handoff. The v0.7.0 release documentation is [here](releases/v0.7.0.md); prior release evidence is retained below.

## v0.7.0, November 28, 2026

Published [v0.7.0](https://github.com/v2matosevic/gpt-image-tool/releases/tag/v0.7.0)
as Latest at 14:35:12 UTC on November 28 (15:35 local), titled "gpt-image-tool
0.7.0: Studio". It is a normal public release, neither draft nor prerelease. The
annotated tag and the release target both resolve to exact source
`fb0546edf9d8bb31dae796edd34361e18e7bfe7c`. Later documentation commits on main do
not move the tag. Marko approved the push of the night's work and asked for this
release; the orchestrating agent relayed it.

The release adds Studio (nine `studio_*` MCP tools and `gpt-image studio`), the
paid API's GPT-Image-2.6 models with spend limits on every paid request, and the
alias change (`flare` / `sunburst` now mean 2.6). Package, lockfile and MCP
version are aligned at `0.7.0`; the server exposes 22 tools. The repository
remains public and MIT licensed (GitHub's license API reports MIT); installation
is from the GitHub source tag or archive, not an npm package or binary.

Source on main for this release: `8f9d48b` (playbook: subscription-first rule and
when to use Studio), `d77f914` (version, changelog, release notes, README, setup
and agent docs, Studio screenshot), `fb0546e` (dependency updates). The Studio
implementation and its reviews are the commits between `v0.6.0` and `8532b01`.

- [CI run 46155282719](https://github.com/v2matosevic/gpt-image-tool/actions/runs/46155282719)
  passed all four jobs at the exact release source: Node 22 on Windows, macOS and
  Linux, plus Node 24 on Linux. Each job installs, runs the tests and the MCP
  smoke, regenerates presets and checks for catalog drift.
- Locally the release build passed 211 tests, the MCP smoke (version `0.7.0`, 22
  tools, offline calls to the catalog, preview, logo kit, brand board and a Studio
  loop) and the preset regeneration with no drift. `git diff --check` passed. All
  139 relative Markdown links in 28 files resolved, anchors included.
- A clean clone of `fb0546e` on Windows with Node 22.22.0 passed `npm ci`, build,
  all 211 tests, the 22-tool smoke and the preset comparison.
- Dependencies: `npm audit` on a clean install of the first candidate (`d77f914`)
  reported ten advisories (1 critical, 4 high, 5 moderate). Compatible updates
  (`@modelcontextprotocol/sdk` 1.32.2, `sharp` 0.35.5 and transitive `hono`,
  `@hono/node-server`, `body-parser`, `proxy-addr`, `qs`, `fast-uri`, `ip-address`)
  fixed nine and passed the same gates. **One high advisory remains**: `zod` 3,
  [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), memory
  exhaustion when validating oversized input. Its fix is zod 4; a trial build
  failed 23 type checks in three files and zod 4 changes validation messages and
  tool schemas, so it was left for a later release and disclosed in the changelog
  and release notes. Input reaches the validator only from the local agent over
  stdio. Every earlier release shipped with zero npm findings; this one ships
  with this one.
- After fetching remote refs, the publication heuristic scanned 758 blobs and
  reported 7 findings, all planted fake keys in tests: `sk-test-...` values in
  `test/studio-api.test.ts` and `test/api-2.6.test.ts`, a sequential
  `sk-proj-ABCDEFGHIJKLMNOP0123456789wxyz` with its masked echo, and
  `sk-other1234567890`, used by the redaction tests. Each matched value in every
  flagged blob was checked without printing it. This is a heuristic, not proof
  that no secret exists. `docs/STUDIO-PLAN.md` stays untracked.
- GitHub's source ZIP was downloaded: **8,341,160 bytes**, SHA-256
  `18a19dc7ed74bf84c6b5882d1e211f3f8c0f47d433f37654a4b18488bc69ae18`. All **179
  file blobs** matched the tag exactly; none missing or extra. The extracted
  archive passed `npm ci`, build, 211 tests, the 22-tool smoke, normalized preset
  equality and `npm audit` with the one zod finding.
- The signed-out release page and README were opened in a real browser: title,
  Latest badge, tag and commit `fb0546e` shown; all four README images loaded,
  including the new [Studio graph](assets/studio-graph.png), whose provenance is
  [documented](assets/README.md#studio-viewer-v070). The repository description now
  names Studio and the spend limits.

No paid API request and no image generation was made for this release. The
README screenshot shows images made during the November 28 comparison run.

What is and is not verified is listed in the [release notes](releases/v0.7.0.md#what-is-verified-and-what-is-not):
live on one Windows machine and one account for Studio on the subscription and
2.6 on the API; offline only for limits, grants, ledgers and resume; not verified
for grants against the real API, 2.5 models live, the perception pack's download
size on a clean machine or on macOS/Linux, the soft-share focus measure beyond its
twelve calibration images, and anything Mac- or Linux-specific beyond CI.

### Local installation

The working checkout at `B:/Coding/gpt-image-tool` is built at `0.7.0`
(`dist/mcp.js` and `dist/cli.js`). Codex starts that file directly and sees all
22 tools after a reconnect. Claude terminals reach it through ToolHub, whose saved
tool catalogue was still the October 26 one with 13 tools: ToolHub keys the
catalogue by the server's command line, which did not change, and loads it once at
hub start. `toolhub refresh gpt-image` rewrote `~/.toolhub/catalog.json` with 22
tools (the previous file is kept in the verification folder below), but the
running hub keeps its in-memory copy, so **Claude terminals see the Studio tools
only after the ToolHub hub is restarted and the client reconnects MCP**. The hub
was not restarted; stopping it needs the owner. The defect is logged for ToolHub
(agent-coord issue `i-badf1015`). No client, terminal or service was stopped.

Verification files: `C:/Users/matos/AppData/Local/Temp/gpt-image-release-0.7.0-fb0546e`
(clean-clone and archive logs, `ci.json`, `archive-verification.json`, the
downloaded ZIP, release and README screenshots, `toolhub-catalog.before.json`). No
social posts or direct messages were sent.

## v0.6.0, October 3, 2026

Published [v0.6.0](https://github.com/v2matosevic/gpt-image-tool/releases/tag/v0.6.0)
as Latest at 10:44:16 UTC on October 3. It is a normal public release, neither draft
nor prerelease. The annotated tag and release target both resolve to exact source
`e867bfa542f2d725e55b133a11292e37f70b361e`. The implementation is `0e2f678`.
Later handoff documentation on main does not move this immutable tag.

This release adds the three branding tools, structured briefs/reference roles,
exact font outlines, logo kits, board layouts, presets and image-fidelity fixes.
Package, lockfile and MCP version are aligned at `0.6.0`. The repository remains
public and MIT licensed; installation is from the GitHub source tag/archive, not
an npm package or separate binary distribution.

- [CI run 37117204276](https://github.com/v2matosevic/gpt-image-tool/actions/runs/37117204276)
  passed all four jobs at the exact release source: Node 22 on Windows, macOS and
  Linux, plus Node 24 on Linux. Every job installed dependencies, ran the tests and
  MCP smoke, regenerated presets and checked for catalog drift.
- The release build passed 115 tests locally. A separate clean extraction of the
  exact source, on Windows with Node 22.22.0, passed `npm ci`, all 115 tests, the
  13-tool MCP smoke and normalized preset-catalog comparison. Installation and
  the runtime audit reported zero npm vulnerability findings.
- The real MCP smoke checked version `0.6.0`, all 13 registered tools and actual
  offline calls to the catalog, request preview, logo kit and brand board.
- After fetching remote refs, the publication heuristic scanned 400 blobs and
  reported no credential-pattern or sensitive-filename findings. This is a
  heuristic, not proof of absence of every secret. All 115 relative Markdown
  file links resolved.
- GitHub's source ZIP was downloaded: **7,536,004 bytes**. All **132 file blobs**
  matched the annotated tag exactly, with no mismatches. Observed ZIP SHA-256:
  `78f60e25ae0e294b208ae1561448e83564aa380f2cf0fbc2da52a74936cbea79`.
- The signed-out public repository and release page were opened in a real browser.
  The updated description, public/MIT status, Latest badge, release title and exact
  commit were verified. README images loaded, including the new branding board.
  The board and logo-sheet PNGs were copied from inspected outputs and their
  [provenance](assets/README.md#branding-showcase-v060) is documented.

### Local installation and wrap

The working checkout at `B:/Coding/gpt-image-tool` is built at `0.6.0`. Existing
Claude and Codex registrations both point to its `dist/mcp.js`; no global install,
credential change or paid-backend change was needed. A fresh server from that
registered entry point passed the version-aware MCP test. The already-open coding
session retains its previous tool catalog until the user reconnects GPT-image MCP.
No running client, terminal or background service was stopped or restarted.

The implementation was reviewed and approved by Claude Opus 5.5. Its earlier live
sample used exactly three subscription generations; no additional generation or
paid API request was needed for this release. Confidence is high for measured
installation/publication outcomes, and moderate for creative usefulness based on
the bounded sample. The release does not claim every new preset was validated at
final quality or certify an individual subscription renderer.

Canonical usage: [BRANDING.md](BRANDING.md), [TOOLS.md](TOOLS.md) and
[SETUP.md](SETUP.md). The dated implementation record remains in
[BRANDING-PLAN.md](BRANDING-PLAN.md). Verification artifacts are retained in the
local temp folder `gpt-image-release-0.6.0-5EaXrH` (`candidate.json`, installation/
test/MCP logs, `ci.json`, `links.json`, `clean-verification.json`, downloaded ZIP and
`archive-verification.json`). No social posts or direct messages were sent.

## v0.5.0, September 10, 2026

The release adds Flare/Sunburst selection for the explicit paid API backend, Sunburst as its default, and `xhigh`/`max` quality. CLI, MCP, profiles, sidecar replay and generation wrappers preserve the choice. Package, lockfile and MCP versions are aligned at `0.5.0`.

The implementation passed 97 offline tests and the real MCP smoke, including renderer schemas and refusal to switch billing. Subscription accepts an invalid renderer name in a direct negative-control probe, so named subscription selections are refused before provider requests. Paid API payloads are tested with mocks; no API key was available for live API verification. [Research and evidence](IMAGE-2.5-RESEARCH.md).

Published [v0.5.0](https://github.com/v2matosevic/gpt-image-tool/releases/tag/v0.5.0) as Latest at 22:13:13 UTC on September 9 (00:13 local, September 10). It is neither a draft nor a prerelease. The annotated tag resolves to `7b1f7cc34f4ab6891f53eddef2d105bffc9496d4`; release target metadata names that exact commit. Later documentation commits do not change the tagged source.

- [CI run 34410973428](https://github.com/v2matosevic/gpt-image-tool/actions/runs/34410973428) passed all four jobs: Node 22 on Windows, macOS and Linux, plus Node 24 on Linux. Each installed dependencies, ran 97 tests, checked the real MCP handshake/version/schema and verified preset catalog consistency.
- A separate clean Windows extraction of the exact tagged source passed `npm ci`, all 97 tests, the MCP check and normalized preset catalog comparison. Installation reported zero vulnerabilities. During preparation, an earlier candidate exposed the high-severity `sharp` advisory GHSA-rgj7-g3m4-5g8c; the release updates `sharp` to 0.35.4 and repeats verification. [Upstream patch](https://github.com/lovell/sharp/releases/tag/v0.35.4).
- The publication heuristic scanned 333 blobs across fetched, locally reachable refs and reported no findings. It is a heuristic, not proof of absence of every secret. All 83 relative Markdown file links resolved.
- GitHub's source ZIP was downloaded: 5,941,667 bytes. All 107 file blobs matched the tag exactly. Downloaded ZIP SHA-256: `2ff21a516dd41a0fc9674f68b5366162d3b68c124e56b5736ba5a27cc4938cf2`.
- The signed-out public README and release page were opened in a real browser. The release title, Latest label, exact commit, installation examples and API/subscription boundary were visible. Release screenshot inspected. The GitHub description now names Image 2.5 and the explicit API path.

Confidence is high for these measured publication outcomes. Paid API live access remains unverified; the release does not claim selectable subscription renderers.

Local verification artifacts are under `C:/Users/matos/AppData/Local/Temp/gpt-image-release-0.5.0-7b1f7cc`; release screenshot: ignored `gpt-image-v0.5.0-release.png`. The repository remains public and MIT licensed. GitHub supplies source ZIP/tar archives; no npm package or separate binary distribution was published. Local `dist` was rebuilt at 0.5.0, but existing clients were not restarted. The pre-existing `.gitignore` edit was excluded. No social posts or direct messages were sent.

### End-of-day wrap, September 10, 2026

Marko accepted the published result and requested the final documentation wrap. The requested analysis, implementation and GitHub source release are complete. No further feature, release or installation work remains in this session.

| Source | Purpose |
| --- | --- |
| `a6a57fa` | Flare/Sunburst API choices, quality controls, tests and research |
| `83248f2` | Version 0.5.0 and installation/release documentation |
| `7b1f7cc` | Sharp security patch; exact immutable v0.5.0 release source |
| `6778f73` | Published release, CI and downloaded-archive evidence on main |

Start a later session with this document, then [Image 2.5 research](IMAGE-2.5-RESEARCH.md), [model configuration](MODELS.md) and [upgrade instructions](SETUP.md#upgrade-an-existing-installation). The tagged code and release evidence above are the baseline; historical v0.4.0 and v0.3.0 sections do not describe today's defaults.

Preserve these boundaries:

- Flare/Sunburst selection works through the explicit paid API integration. Its request handling is tested; live paid account access, relative speed and editing quality are not verified. The successful subscription probes cannot establish either renderer's identity because an invalid name also returned an image.
- Keep subscription routing automatic and keep billing selection explicit. The user did not authorize new paid test requests, npm publication or social announcements during this documentation wrap.
- Local `dist` is built at 0.5.0. Existing client processes were not restarted; reconnect MCP when loading the new code into those clients. No global settings were changed in this release.
- All image jobs, clean-install checks and browser verification from this lane have finished. No dev server or test process was left running. Verification artifacts are retained at the paths above; no cleanup of unrelated files was performed.
- The only remaining working-tree modification at wrap start was the pre-existing `.gitignore` edit. It is outside this work and remains preserved, uncommitted and excluded from the tag.

This wrap changes documentation and project memory only. It does not repeat completed test suites, spend image quota, move the release tag or create another release.

## v0.4.0, September 7, 2026

The Astra/Image 2 update is documented in [MODELS.md](MODELS.md), the [changelog](../CHANGELOG.md), and the [upgrade instructions](SETUP.md#upgrade-an-existing-installation). Package, lockfile, and MCP handshake versions are aligned at `0.4.0`. The smoke check verifies that the running MCP server advertises the package version.

The project remains public and MIT licensed, with installation from tagged source and no npm publication. Model overrides remain explicit; an upgrade does not switch a subscription user to paid API billing. The original launch artwork remains a labeled historical sample, not new Astra evidence.

Published [v0.4.0](https://github.com/v2matosevic/gpt-image-tool/releases/tag/v0.4.0) as the latest stable release at 13:25:30 UTC on September 7, 2026. Tag and release target both name `1c992f58edeb806c84d386e8197e2807529ba270`. It is neither a draft nor a prerelease. This later handoff update does not change the released source.

- [CI run 34127181942](https://github.com/v2matosevic/gpt-image-tool/actions/runs/34127181942) passed all four jobs: Node 22 on Windows, macOS and Linux; Node 24 on Linux. Every job completed installation, 90 tests, the version-aware MCP smoke check, and the preset catalog drift check. A duplicate manual run was cancelled after the push-triggered run appeared.
- A clean extraction of that exact commit on Windows, Node 22.22.0, passed `npm ci`, all 90 tests, and the MCP handshake/version check. Installation reported zero dependency vulnerabilities. Regenerated preset content matched the committed catalog. An initial raw-byte comparison flagged archive line-ending differences; normalized content comparison and all four CI drift checks passed.
- The publication heuristic scanned 294 blobs across fetched, locally reachable history and found no credential-pattern or sensitive-filename findings. This remains a heuristic, not proof that no secret exists. All 77 relative Markdown file links resolved.
- The published GitHub source ZIP was downloaded (5,930,606 bytes), extracted, and all 104 file blobs matched the exact tagged commit. Package version is `0.4.0`. GitHub provides the source ZIP and tar archive; no npm package or separate binary distribution was published.
- The signed-out GitHub release page displayed the correct title and Latest label. Its screenshot was inspected. Repository description and discovery topics now include the current model setup. The README links the release and upgrade instructions.

The model implementation also passed a live Astra subscription generation, visual inspection of the saved image, and live Astra proofreading. API payloads were tested with mocks only. See [MODELS.md](MODELS.md) for account-access and renderer-version limits. Confidence is high for these measured release outcomes.

Local verification files are under `C:/Users/matos/AppData/Local/Temp/gpt-image-release-0.4.0-1c992f5`; the release screenshot is ignored at `release-v0.4.0.png`. No running client was restarted, and no social posts were sent.

## Historical v0.3.0 verification

Completed September 5, 2026. The sections below describe that release and its original launch kit.

## Published state

- Repository: [v2matosevic/gpt-image-tool](https://github.com/v2matosevic/gpt-image-tool), public, MIT licensed, with a description, discovery topics, issue forms, contribution guidance, and private vulnerability reporting enabled.
- Released source: `7a445c66b25318a5d265c08910bb20f4f0884d16`, prepared from `530f194`. [Release v0.3.0](https://github.com/v2matosevic/gpt-image-tool/releases/tag/v0.3.0) is published, not a draft. Later handoff-only commits on `main` do not change that released source.
- [CI run 33973876223](https://github.com/v2matosevic/gpt-image-tool/actions/runs/33973876223) passed all four jobs: Node 22 on Windows, macOS, and Linux; Node 24 on Linux. Every job installed dependencies, ran the 87 tests and MCP smoke check, regenerated the catalog, and checked for catalog drift.
- The public README was opened in a signed-out browser. Both images loaded. Desktop and 390-pixel mobile screenshots were inspected, with no horizontal page overflow in the mobile check.
- Installation remains from source. `package.json` deliberately retains `private: true`; no npm package was published.

Confidence is high for these observed outcomes. Upstream subscription availability remains account-dependent and experimental.

## Deliverables and source of truth

- [README](../README.md): positioning, portable quick start, capabilities, and limits.
- [SETUP.md](SETUP.md): Claude Code, Cursor, Codex, generic local MCP, file-based authentication, and explicit API-key setup. Current official client documentation is linked there.
- [EXAMPLES.md](EXAMPLES.md), [TOOLS.md](TOOLS.md), [PRESETS.md](PRESETS.md), and [AGENTS.md](AGENTS.md): workflows, parameters, preset catalog, and agent usage.
- [Asset manifest](assets/README.md): actual generated examples, exact prompt sidecars, provenance, and measured output differences.
- [Launch kit](launch/README.md): post copy for X, LinkedIn, Instagram, and developer communities; six social graphics; alt text; a contact sheet; and a recording shot list.
- [CONTRIBUTING.md](../CONTRIBUTING.md), [SECURITY.md](../SECURITY.md), and [CLAUDE.md](../CLAUDE.md): contribution, credential/data-flow, and maintenance rules.

The [release ZIP](https://github.com/v2matosevic/gpt-image-tool/releases/download/v0.3.0/gpt-image-tool-launch-kit.zip) contains the documentation and launch artwork as packaged at release time. It is 5,753,178 bytes. GitHub's reported digest matches the locally computed SHA-256:

```text
03148df3d92c406a722fc562e660bad1dafca0135737b52e96f47bbce99d3cdf
```

The release ZIP is an immutable launch snapshot; use this document on `main` for the final handoff. Rebuild graphic layouts with `npm ci` followed by `npm run assets:launch`. That command composites the committed samples locally and makes no provider requests. It requires no regeneration of the two original examples.

## Local evidence

- Windows, Node.js 22.22.0. A clean `npm ci` completed successfully.
- `npm test`: 87 passed, zero failed, no credentials or provider requests.
- `npm run smoke:mcp`: fresh stdio process initialized, listed all ten expected tools, and returned the webdev catalog without credentials.
- `npm run docs:presets`: 70 presets and 23 modifiers, no catalog drift.
- `npm audit fix`: compatible lockfile updates cleared six reported dependency advisories. Subsequent clean install reported zero vulnerabilities across 105 audited packages.
- Publication heuristic initially scanned 222 historical blobs. After fetching remote heads and committing the release, the final scan covered 265 blobs across locally reachable branches and tags, including old sync refs. Both scans returned no credential-pattern or sensitive-filename findings. It does not prove the absence of every possible secret.
- Relative Markdown links were checked for existing targets. `git diff --check` passed.

## Live evidence

Two `generate_image` calls through the subscription MCP backend produced the committed paper sculpture and fox mascot. Their full generation specifications are beside the images. They were visually inspected, and a contact sheet of all launch layouts was reviewed.

Both requests specified 1024×1024 and returned 1254×1254. The sculpture is opaque; the fox's alpha channel includes both fully transparent and fully opaque pixels. Requested dimensions in a sidecar are not measured output dimensions.

A real `export_web_assets` call produced four WebP hero widths from the sculpture: 640, 828, 1200, and 1254 pixels. It used local image processing and did not upscale beyond the source. These check outputs are ignored, not release assets.

The README and social kit use actual outputs with deterministic layout and typography. The workflow graphic is labeled as an explanatory panel, not a captured coding-client session. Social posts and demo footage have not been fabricated or submitted.

## Limits

Cross-platform offline CI passed as recorded above. No live API-key request was made, and each named coding client was not separately driven through a new installation. The fresh stdio handshake and existing live MCP calls establish the server behavior that was tested. Live subscription tests establish access on one account at one point in time, not an upstream service contract or universal account access.

## Remaining owner choices

1. Optional GitHub polish, about one minute: in Settings, General, Social preview, upload [github-banner.png](assets/github-banner.png). The available browser was signed out, so this owner-only upload was not performed. The README already displays the banner.
2. Choose accounts and timing for social publication. Recommendation: start with one real example and the prepared announcement, then follow with a concrete workflow. Captions, image order, and alt text are in the launch kit. No social posts or direct messages were sent.
3. Optional video: the launch kit includes a 30–45-second edited-demo shot list, not an actual recording. Record a genuine client workflow and label any shortened generation wait.

No pending implementation is required for the released source. A future maintainer should not republish the npm name, change provider billing behavior, or imply unlimited subscription access as part of routine launch follow-up.

## Wrap-up and replay

The code and launch assets were committed and pushed. The verification browser was closed; no preview server, image job, or test process was left running by this lane. Local screenshots and export checks remain under ignored `generated-images/`; public deliverables are committed or attached to the release. Project memory and the shared-memory pointer were updated with the public release location and corrected authentication caveats.

From a checkout, use `npm ci`, `npm test`, and `npm run smoke:mcp` to replay the offline checks. Use `npm run docs:presets` and inspect the resulting diff after preset changes. Before a future visibility or distribution change, fetch remote refs and run `npm run audit:publication`, then review its limits and any findings. A live generation is a separate, quota-consuming check.
