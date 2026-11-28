# Changelog

## Unreleased

- **Behaviour change for paid API users:** `flare` and `sunburst` now mean GPT-Image-2.6 (`gpt-image-2.6-flare`, `gpt-image-2.6-sunburst`), and the API default is `gpt-image-2.6-sunburst`. In v0.6.0 they meant 2.5. To keep 2.5, use `flare-2.5` / `sunburst-2.5` or the full ID, in calls, profiles (`imageModel`) and `GPT_IMAGE_API_MODEL`. Sidecars written by earlier versions recorded the full ID, so `--from` / `from_image` replays them on the model they were made with. Per-token rates are unchanged, but 2.6 renders low and medium quality with more output tokens, so those images cost more: by OpenAI's calculator a low 1024x1024 image is about $0.025 on 2.6 against $0.006 on 2.5, medium $0.043 against $0.013; high is the same ($0.053). See docs/MODELS.md.
- **Spend limits on every paid request:** every API request, from any tool or the CLI, is now checked before it is sent: a per-call (or Studio run) limit, a project day limit and ceiling (`studio.limits` in `.gptimage.json`, defaults $2 / $10 / $50) and a user-level limit across projects (`~/.gptimage/config.json`, defaults $25 a day, ceiling $100). A request past a limit is refused with "Spend limit: ..." and the fix; nothing is sent and nothing switches to the subscription.
- Bundle the MCP server into a single `dist/mcp.js` during `npm run build`, so a cold start reads one file instead of about 270 modules. Slow starts on busy disks exceeded MCP gateway start limits and made every call fail with "Request timed out".
- Stop sending the reasoning block in subscription image requests; the renderer rejected every explicit level as an unsupported "complexity".
- GPT-Image-2.6 on the paid API: `flare` and `sunburst` now mean 2.6 (2.5 kept as `flare-2.5` / `sunburst-2.5`), the API default is `gpt-image-2.6-sunburst`, plus `complexity`, custom sizes up to 3840 px, and cost per call from reported usage. The key can come from the project's `.secrets` or `~/.gptimage/secrets`; results name the source, never the key.
- Studio: the subscription stays the default renderer; nodes may opt into the paid API (`renderer: "api"`), a `finish` node re-renders an approved draft at up to 4K, and spend limits per run and per day, owner grants and a ceiling are enforced before each paid request (`studio_budget`).

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
