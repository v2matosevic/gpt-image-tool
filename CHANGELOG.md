# Changelog

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
