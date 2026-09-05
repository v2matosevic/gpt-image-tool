# gpt-image-tool 0.3.0

Give your coding agent an image tool.

This public source release brings image generation, editing, and local web-asset exports into coding workflows through a local MCP server or CLI. Connect Claude Code, Cursor, Codex, or another client that supports local stdio MCP.

- 70 style presets and 23 composable modifiers.
- Reference-image edits, masks, regeneration-based upscaling, and chroma transparency.
- Project brand profiles, related image series, and saved generation specifications.
- Local favicon, Open Graph, responsive hero, and app-icon exports.
- Deterministic text and logo overlays, social cards, and carousels.
- Portable setup docs, real generated examples, contribution guidance, MIT licensing, and launch artwork.

The subscription backend is experimental: it reads a local Codex ChatGPT login and calls an undocumented endpoint. It uses account allowance, can change upstream, and is not an official integration. The explicitly selected OpenAI API backend has separate billing.

Install from source with Node.js 22.18 or newer. No npm package is being announced. Start with the [README](https://github.com/v2matosevic/gpt-image-tool#quick-start) and [client setup](https://github.com/v2matosevic/gpt-image-tool/blob/main/docs/SETUP.md).

Validation: 87 offline tests and a real stdio MCP handshake passed locally on Windows with Node 22.22. Two live subscription generations were inspected. Requested output dimensions differed from actual dimensions, documented with the samples. Lockfile updates cleared the six dependency advisories reported during release preparation. Cross-platform CI results are recorded in the repository's Actions tab; local checks alone do not establish other-platform support.

The attached launch kit contains social artwork, post copy, alt text, and a recording shot list. Social posts have not been submitted automatically.
