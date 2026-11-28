# Changelog

## 0.7.0 - 2026-11-28

- **Behaviour change for paid API users:** `flare` and `sunburst` now mean GPT-Image-2.6 (`gpt-image-2.6-flare`, `gpt-image-2.6-sunburst`), and the API default is `gpt-image-2.6-sunburst`. In v0.6.0 they meant 2.5. To keep 2.5, use `flare-2.5` / `sunburst-2.5` or the full ID, in calls, profiles (`imageModel`) and `GPT_IMAGE_API_MODEL`. Sidecars written by earlier versions recorded the full ID, so `--from` / `from_image` replays them on the model they were made with. Per-token rates are unchanged, but 2.6 renders low and medium quality with more output tokens, so those images cost more: by OpenAI's calculator a low 1024x1024 image is about $0.025 on 2.6 against $0.006 on 2.5, medium $0.043 against $0.013; high is the same ($0.053). See docs/MODELS.md.
- **Spend limits on every paid request:** every API request, from any tool or the CLI, is now checked before it is sent: a per-call (or Studio run) limit, a project day limit and ceiling (`studio.limits` in `.gptimage.json`, defaults $2 / $10 / $50) and a user-level limit across projects (`~/.gptimage/config.json`, defaults $25 a day, ceiling $100). A request past a limit is refused with "Spend limit: ..." and the fix; nothing is sent and nothing switches to the subscription.
- **Studio: image work as a node graph.** Nine new MCP tools (`studio_guide`, `studio_list`, `studio_get`, `studio_create`, `studio_edit`, `studio_run`, `studio_status`, `studio_view`, `studio_budget`) and the `gpt-image studio ...` CLI (`--json` for programs). Prompt, look and reference nodes feed generate, edit and process nodes; a list fans one prompt out into several images; a sweep varies one look dimension, as edits of an anchor when there is one; canon entries keep a locked description that any graph can use. Runs are background jobs that outlive the MCP server, reuse unchanged images instead of regenerating them, and resume after a stop. Every image records what made it. Approved images become a handoff package for a coding agent, and a screenshot of the build comes back onto the graph for comparison. Lessons, the owner's choices and prediction calibration are kept across graphs. Storage is a versioned file contract other programs can read (ADE reads it); within a schema version fields are only added. [docs/STUDIO.md](docs/STUDIO.md).
- **Studio review.** Every image gets a local reading (palette, lightness, contrast, colour temperature, visual weight, sharpness, a soft share for depth of field, letterbox or pillarbox bars), deviations where the reading contradicts the prompt or drifts from its anchor, and a checklist of yes/no questions drawn from the checkable parts of the prompt. An agent must record a look before it can approve. Review sheets, full-resolution zooms, blind A/B pairs, studying an admired image into a style node, a read-only local viewer (`gpt-image studio view`), and `gpt-image studio page`, a self-contained side-by-side page for a person with plain captions and no verdicts.
- **Studio renderers.** The subscription renders every node by default; a node opts into the paid API with `renderer: "api"`, and a `finish` node re-renders an approved draft from its pixels at up to 4K. Dry runs price the work, API takes record their usage, cost and key source, a finish reports drift from its draft, and the plan warns when a finish changes the draft's aspect. The owner's approval of more spend is recorded as a grant (`studio_budget`). A run stopped by the subscription's image cap records when the cap resets.
- **Optional perception pack.** `gpt-image studio perception install --yes` adds similarity to the anchor (DINOv2 small) and a foreground mask (U-2-Netp) from local models, about 518 MB, into one per-user folder. Off unless installed; nothing else depends on it.
- GPT-Image-2.6 on the paid API: `complexity` (`low`, `medium`, `high`), custom sizes up to 3840 px on an edge, and each result's cost from the usage the API reported. The key can come from `OPENAI_API_KEY`, the project's git-ignored `.secrets` or `~/.gptimage/secrets`; results name the source, never the key.
- The subscription's image-cap error states when the cap resets.
- Bundle the MCP server into a single `dist/mcp.js` during `npm run build`, so a cold start reads one file instead of about 270 modules. Slow starts on busy disks exceeded MCP gateway start limits and made every call fail with "Request timed out".
- Stop sending the reasoning block in subscription image requests; the renderer rejected every explicit level as an unsupported "complexity".
- Dependency updates for reported advisories: `@modelcontextprotocol/sdk` 1.32.2, `sharp` 0.35.5 (librsvg), and compatible transitive updates (`hono`, `@hono/node-server`, `body-parser`, `proxy-addr`, `qs`, `fast-uri`, `ip-address`). Known: `zod` 3 is inside a high-severity advisory (GHSA-mrhx-c7xc-m3w5, memory exhaustion when validating oversized input); the fix is zod 4, a breaking upgrade left for a later release.
- Documentation corrected: the subscription renders with gpt-image-2, replaces the quality and size it is sent with `auto`, and reports every image as quality `low`.

## 0.6.0 - 2026-10-03

- Add quota-free request preview, structured creative briefs, role-specific references, and exact project brand settings.
- Add local logo kits with supplied vector artwork, explicitly requested outlined wordmarks, approved mono variants, web/app/social assets and review sheets.
- Add exact editorial/grid brand boards with font specimens, color measurements, source manifests and CSS/JSON tokens.
- Add seven branding presets and concept contact sheets. Label generated logo concepts as raster.
- Support static font files and outlined SVG logos in overlays/social workflows; preflight font coverage before generating boards/carousels.
- Preserve original pixels outside masked edits by default; report actual output dimensions/format/alpha and diagnostic checks.
- Fix transparent-edge darkening in scaling/compositing; preserve non-square icons with an optional contain fit.
- Update compatible fast-uri and ip-address transitive dependencies to address reported advisories.

## 0.5.0, 2026-09-10

- Update `sharp` to 0.35.4 or newer within its compatible patch range, addressing its bundled libheif security advisory (GHSA-rgj7-g3m4-5g8c).

- Add GPT Image 2.5 Flare (speed) and Sunburst (editing precision) selection through CLI, MCP, profiles and sidecar replay; default the explicit API backend to Sunburst.
- Support `xhigh` and `max` quality for Image 2.5 API calls, preserving lower quality and legacy model overrides.
- Carry model/backend choices through edits, upscales, series, social plates, cutouts and generated web sources.
- Reject named subscription renderer selections before requests: a live negative control accepted a nonexistent model, so returned images cannot establish model selection. Preserve automatic subscription routing and never switch billing backends.

## 0.4.0, 2026-09-07

- Default subscription routing and image proofreading to GPT-6 Astra; default the explicit paid Images API backend to GPT Image 2. Preserve environment overrides and keep backend selection explicit.
- Force the subscription image tool to run, and send the requested output format on API edits.
- Show configured models in the CLI health check and clarify that session validation does not prove image access.
- Document separate MCP startup and image-call timeouts.

## 0.3.0 public source release

This release packages the existing image toolkit for public use with a portable quick start, client-specific setup, examples, troubleshooting, MIT licensing, contribution and security guidance, and launch artwork.

The toolkit includes ten MCP tools, 70 presets, 23 modifiers, subscription and API-key providers, image editing, chroma transparency, project profiles, local web exports, deterministic text overlays, social cards, carousels, and metadata utilities.

The subscription provider remains experimental. Live access depends on the account and the undocumented upstream endpoint. This source release does not announce an npm package.
