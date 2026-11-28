# Model configuration

API model documentation checked on 2026-09-09 UTC; subscription availability and local configuration rechecked on 2026-09-11. The API model-selection changes are included in v0.5.0.

| Work | Default | Override |
| --- | --- | --- |
| Subscription image tool routing | `gpt-6-astra` | `GPT_IMAGE_MODEL` |
| Subscription vision proofreading | `gpt-6-astra` | `GPT_IMAGE_PROOF_MODEL` |
| Explicit paid Images API generation and edits | `gpt-image-2.6-sunburst` on main; `gpt-image-2.5-sunburst` in v0.6.0 | `GPT_IMAGE_API_MODEL`, profile `imageModel`, per-call `image_model` / `--image-model` |

On main, `flare` and `sunburst` resolve to GPT-Image-2.6; `flare-2.5` and `sunburst-2.5` keep 2.5. This changes what the short names meant in v0.6.0; replayed sidecars keep their recorded full ID. Prices, the cost calculator and measured costs are below in [Paid API prices](#paid-api-prices-2026-11-28).

Use `flare` (`gpt-image-2.5-flare`) for speed and `sunburst` (`gpt-image-2.5-sunburst`) for editing precision. Both support quality through `xhigh` and `max`. [Official Flare page](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare) · [Official Sunburst page](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst).

Both selections require the explicit `apikey` backend and separate API billing. Subscription keeps its server-selected renderer. A live subscription negative control returned an image for a nonexistent tool model, so a successful request cannot certify renderer selection. Named subscription selections are refused before requests, with no automatic billing change. Astra's name does not identify the renderer. [Full analysis, live evidence and implementation verification](IMAGE-2.5-RESEARCH.md).

The API uses native PNG/WebP transparency; subscription keeps the existing chroma workflow. API edits send the requested output format. Explicit legacy API model overrides are preserved; `xhigh`/`max` are rejected for known older GPT Image models and unknown subscription renderers.

Run `node dist/cli.js --check` to see configured models and validate the subscription session. It does not generate an image or establish access to either API model. The v0.5.0 model-selection work passed 97 offline tests and the real MCP smoke; paid API generation was not run. Version 0.6.0 retains those model/billing boundaries and adds the branding workflow; see [release verification](RELEASE-VERIFICATION.md) for current checks. Rebuild and reconnect existing MCP processes to load changes.

## Correction, 2026-11-28

The subscription renders with gpt-image-2 (`gpt-image-2-codex` in the server's echoed tool config), not
Images 2.5. It also replaces the quality and size we send with `auto` and reports every image as
quality `low`. OpenAI's image-generation page for Codex says built-in generation uses gpt-image-2.
Images 2.5 and 2.6 are API-only here (2.6 support was added later the same day). Evidence and sources, with our
checks kept apart from community reports: [IMAGE-2.5-RESEARCH.md](IMAGE-2.5-RESEARCH.md#correction-2026-11-28-the-subscription-renders-with-gpt-image-2-not-images-25).
The section below is kept as written on 2026-09-11; its reading of the 2.5 announcement was wrong.

## Paid API prices, 2026-11-28

Checked 2026-11-28 on OpenAI's model pages for gpt-image-2.6-sunburst and gpt-image-2.6-flare and the image-generation guide's cost section. The one table the tool uses is `src/pricing.ts`; change it there.

| Per million tokens | GPT-Image-2.6 (both) | GPT-Image-2.5 (both) |
| --- | --- | --- |
| Text input | $5 | $5 |
| Image input | $8 | $8 |
| Image output | $30 | $30 |

Cached-input rates apply to the Responses image tool, not to the Images API this tool calls, so they are not used. Actual cost is computed from the `usage` block each response returns; input the API does not split into text and image is charged at the image rate (the higher one). Estimates use OpenAI's published output-token calculator (base tokens by quality, a 2.6 factor of 4.2 for low and 3.3 for medium, scaled by size), plus text input and, for edits, about 1,600 image-input tokens per input image.

Measured live on 2026-11-28 (reported usage, not estimates):

| Request | Input tokens | Output tokens | Cost | Estimate |
| --- | --- | --- | --- | --- |
| 2.6 Flare, low, 1024x1024 | 35 text | 824 | $0.0249 | $0.0256 |
| 2.6 Sunburst, low, 1024x1024 | 35 text | 824 | $0.0249 | $0.0256 |
| 2.6 Sunburst, high, 2048x2048, complexity low, edit from a 1024 px draft | 113 text, 1,024 image | 3,568 | $0.1158 | $0.1206 |

The calculator gives 823 output tokens for low 1024x1024 and the API reported 824. One edit is the only image-input measurement so far (1,024 tokens for a 1024 px input), so the 1,600-token estimate stays deliberately high until more edits are measured.

## Subscription recheck, 2026-09-11

OpenAI's [September 8 announcement](https://openai.com/index/introducing-chatgpt-images-2-5/) says Images 2.5 is available to ChatGPT and Codex users. The announcement was opened in a real browser on September 11. Confidence: high for official availability; unknown for the renderer used by an individual request through our undocumented endpoint.

The inspected local Codex MCP configuration points to the checkout's `dist/mcp.js` with no server environment overrides. Source and compiled output use the subscription default, Astra routing, and an unpinned `image_generation` tool. No older renderer is pinned and no local model change is needed to follow OpenAI's server selection. The September 9 negative control remains relevant: adding a model name does not establish that the server honors it. No new live generation was run for this recheck.

Focused verification on September 11: all 10 tests in `test/image-models.test.ts` and `test/providers.test.ts` passed, including subscription payload selection and protection against switching billing backends. Provider requests were mocked; this does not identify the live renderer.

## MCP startup

Use `startup_timeout_sec = 120` and `tool_timeout_sec = 600` in the Codex image server configuration. Startup and generation are separate waits. See [setup](SETUP.md#codex) and [official MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

On Olympus, the reported startup failures affected both `gpt-image` and `agent-coord`. Direct checks succeeded before the configuration change: image handshake/catalog in roughly 2 seconds overall, coordination handshake in 8.6 seconds. This establishes that both entry points work, but does not establish the cause of the earlier 30-second failures. Shared-disk contention is a plausible contributor, not a proven cause. Both local server startup limits were raised to 120 seconds; the image call limit was raised from 180 to 600 seconds. New connections are required to load these settings.

## Historical verification, 2026-09-07 (v0.4.0)

- `npm test`: 90 tests passed, including model overrides, forced subscription tool selection, reference/mask preservation, and API create/edit model and format payloads.
- `npm run smoke:mcp`: real stdio handshake, ten tools listed, preset catalog called successfully without credentials.
- `codex mcp get gpt-image --json` and `codex mcp get agent-coord --json`: Codex parsed both updated startup limits as 120 seconds and the image tool limit as 600 seconds.
- Live subscription generation with `gpt-6-astra` and forced image tool: one low-quality PNG request succeeded. Saved image inspected, showing the requested orange folded paper bird on ivory, without text. Local evidence: `.playwright-mcp/astra-live.png` (1,687,344 bytes). Requested 1024 square; provider returned 1254 square, consistent with the existing documented approximate-dimensions limitation.
- Live Astra proofreading of that saved image succeeded with `pass: true`, empty text, no issues, and no `unverified` flag. Local verdict: `.playwright-mcp/astra-proof.json`.
- Paid API payloads were tested with mocked responses only. No paid API generation was performed, and account access to GPT Image 2 was not certified.

The local build is updated. Existing MCP processes must reconnect to load it and the timeout settings. The root `AGENTS.md` was absent; the supplied session instructions and repository `CLAUDE.md` were used.
