# Model configuration

API model documentation checked on 2026-09-09 UTC; subscription availability and local configuration rechecked on 2026-09-11. The API model-selection changes are included in v0.5.0.

| Work | Default | Override |
| --- | --- | --- |
| Subscription image tool routing | `gpt-6-astra` | `GPT_IMAGE_MODEL` |
| Subscription vision proofreading | `gpt-6-astra` | `GPT_IMAGE_PROOF_MODEL` |
| Explicit paid Images API generation and edits | `gpt-image-2.5-sunburst` | `GPT_IMAGE_API_MODEL`, profile `imageModel`, per-call `image_model` / `--image-model` |

Use `flare` (`gpt-image-2.5-flare`) for speed and `sunburst` (`gpt-image-2.5-sunburst`) for editing precision. Both support quality through `xhigh` and `max`. [Official Flare page](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare) · [Official Sunburst page](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst).

Both selections require the explicit `apikey` backend and separate API billing. Subscription keeps its server-selected renderer. A live subscription negative control returned an image for a nonexistent tool model, so a successful request cannot certify renderer selection. Named subscription selections are refused before requests, with no automatic billing change. Astra's name does not identify the renderer. [Full analysis, live evidence and implementation verification](IMAGE-2.5-RESEARCH.md).

The API uses native PNG/WebP transparency; subscription keeps the existing chroma workflow. API edits send the requested output format. Explicit legacy API model overrides are preserved; `xhigh`/`max` are rejected for known older GPT Image models and unknown subscription renderers.

Run `node dist/cli.js --check` to see configured models and validate the subscription session. It does not generate an image or establish access to either API model. The v0.5.0 model-selection work passed 97 offline tests and the real MCP smoke; paid API generation was not run. Version 0.6.0 retains those model/billing boundaries and adds the branding workflow; see [release verification](RELEASE-VERIFICATION.md) for current checks. Rebuild and reconnect existing MCP processes to load changes.

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
