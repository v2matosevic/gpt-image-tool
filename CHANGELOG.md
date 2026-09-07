# Changelog

## 0.4.0, 2026-09-07

- Default subscription routing and image proofreading to GPT-6 Astra; default the explicit paid Images API backend to GPT Image 2. Preserve environment overrides and keep backend selection explicit.
- Force the subscription image tool to run, and send the requested output format on API edits.
- Show configured models in the CLI health check and clarify that session validation does not prove image access.
- Document separate MCP startup and image-call timeouts.

## 0.3.0 public source release

This release packages the existing image toolkit for public use with a portable quick start, client-specific setup, examples, troubleshooting, MIT licensing, contribution and security guidance, and launch artwork.

The toolkit includes ten MCP tools, 70 presets, 23 modifiers, subscription and API-key providers, image editing, chroma transparency, project profiles, local web exports, deterministic text overlays, social cards, carousels, and metadata utilities.

The subscription provider remains experimental. Live access depends on the account and the undocumented upstream endpoint. This source release does not announce an npm package.
