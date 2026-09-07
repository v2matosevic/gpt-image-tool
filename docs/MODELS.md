# Model configuration

Checked against official OpenAI documentation on 2026-09-07.

| Work | Default | Override |
| --- | --- | --- |
| Subscription image tool routing | `gpt-6-astra` | `GPT_IMAGE_MODEL` |
| Subscription vision proofreading | `gpt-6-astra` | `GPT_IMAGE_PROOF_MODEL` |
| Explicit paid Images API generation and edits | `gpt-image-2` | `GPT_IMAGE_API_MODEL` |

Astra directs the subscription image tool. The undocumented subscription endpoint selects its underlying image renderer; this project cannot certify or pin that renderer's version. Selecting Astra is not evidence of a particular GPT Image version. API billing is used only when the caller explicitly selects `apikey`.

The [official image guide](https://developers.openai.com/api/docs/guides/image-generation) names GPT Image 2 as the latest image model and uses Astra in Responses API examples. The [Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra) lists image generation tool support. No official GPT Image 2.5 model was established by this check, so no guessed ID is sent.

GPT Image 2 supports transparent backgrounds in preview on the documented API, using PNG or WebP. Subscription transparency retains the existing local chroma workflow, whose behavior has been tested on that separate endpoint. API edits now explicitly send `output_format`, matching generation requests.

Run `node dist/cli.js --check` to see the effective configuration and validate the local session. It does not generate an image or prove access to the selected model. Explicit model overrides are preserved; errors do not silently downgrade the model or switch billing backends.

## MCP startup

Use `startup_timeout_sec = 120` and `tool_timeout_sec = 600` in the Codex image server configuration. Startup and generation are separate waits. See [setup](SETUP.md#codex) and [official MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

On Olympus, the reported startup failures affected both `gpt-image` and `agent-coord`. Direct checks succeeded before the configuration change: image handshake/catalog in roughly 2 seconds overall, coordination handshake in 8.6 seconds. This establishes that both entry points work, but does not establish the cause of the earlier 30-second failures. Shared-disk contention is a plausible contributor, not a proven cause. Both local server startup limits were raised to 120 seconds; the image call limit was raised from 180 to 600 seconds. New connections are required to load these settings.

## Verification

- `npm test`: 90 tests passed, including model overrides, forced subscription tool selection, reference/mask preservation, and API create/edit model and format payloads.
- `npm run smoke:mcp`: real stdio handshake, ten tools listed, preset catalog called successfully without credentials.
- `codex mcp get gpt-image --json` and `codex mcp get agent-coord --json`: Codex parsed both updated startup limits as 120 seconds and the image tool limit as 600 seconds.
- Live subscription generation with `gpt-6-astra` and forced image tool: one low-quality PNG request succeeded. Saved image inspected, showing the requested orange folded paper bird on ivory, without text. Local evidence: `.playwright-mcp/astra-live.png` (1,687,344 bytes). Requested 1024 square; provider returned 1254 square, consistent with the existing documented approximate-dimensions limitation.
- Live Astra proofreading of that saved image succeeded with `pass: true`, empty text, no issues, and no `unverified` flag. Local verdict: `.playwright-mcp/astra-proof.json`.
- Paid API payloads were tested with mocked responses only. No paid API generation was performed, and account access to GPT Image 2 was not certified.

The local build is updated. Existing MCP processes must reconnect to load it and the timeout settings. The root `AGENTS.md` was absent; the supplied session instructions and repository `CLAUDE.md` were used.
