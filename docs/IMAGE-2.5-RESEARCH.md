# GPT Image 2.5: system analysis and integration

Research checked 2026-09-09 UTC; implementation completed across September 9–10 local time. This document describes the current working source, after released v0.4.0. No new release was published during this task.

## Finding and recommendation

Both Image 2.5 models are officially documented. Offer Flare for speed and Sunburst for precision, with independent quality controls. Keep Sunburst as the explicit API backend's default. Confidence: high for the documented models and integration contract; their relative results on our actual production briefs have not been benchmarked.

| Choice | Exact API ID | Intended use |
| --- | --- | --- |
| `flare` | `gpt-image-2.5-flare` | Fast everyday generation, drafts and iteration |
| `sunburst` | `gpt-image-2.5-sunburst` | More demanding image work, especially precise edits |

OpenAI describes these roles on the [Flare model page](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare) and [Sunburst model page](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst). Both pages were opened in a real browser. This supersedes our September 7 finding that Image 2.5 had not yet been established in official documentation.

## What our tool currently does

This is an MIT-licensed local TypeScript/Node MCP server and CLI, installed from source. It is neither an image model nor a hosted generation service. Its value is the workflow around image generation: compiling prompts, keeping project style, editing references, saving usable project files and preparing web assets.

The request flows through five parts:

1. CLI/MCP accepts the brief and explicit options. A project `.gptimage.json` or prior image's JSON sidecar supplies defaults.
2. The preset compiler combines subject, style, modifiers, literal text and platform composition instructions. Raw prompts can bypass preset composition.
3. A provider performs generation. The default experimental subscription path uses local Codex authentication and Astra as a director at an undocumented ChatGPT endpoint. The explicitly selected API path calls the documented Images generation/edit endpoints.
4. Optional proofreading uses the subscription vision model and can trigger more generations. Selecting the API image backend does not change that existing proof mechanism; `proof: false` / `--no-proof` skips it.
5. Outputs are saved locally with sidecars. Local operations export web sizes, remove simple backgrounds, place exact text/logos and strip metadata. Upscaling is a regeneration and can change details.

The ten MCP tools already cover generation, editing, upscaling, web exports, background removal, overlays, social cards, carousels, metadata and presets. A separate model-specific tool is unnecessary: one renderer option travels through the existing operations. Relevant code: [models](../src/models.ts), [orchestration](../src/generate.ts), [API provider](../src/providers/apikey.ts), [subscription provider](../src/providers/subscription.ts).

## Documented compatibility

Both models work through the Images API; the documented Responses API instead places the renderer ID inside the image-generation tool while retaining a supported mainline model at the top level. Both support `auto`, `low`, `medium`, `high`, `xhigh`, and `max` quality. PNG/WebP support transparent backgrounds. Custom dimensions must use multiples of 16, an aspect ratio from 1:3 to 3:1, edges no larger than 3840 and 655,360–8,294,400 total pixels; larger-than-2560×1440 resolutions are experimental. Our existing size menu remains unchanged in this integration. [Official image guide](https://developers.openai.com/api/docs/guides/image-generation).

No endpoint migration or SDK dependency was required. The API provider already uses the right JSON generation and multipart edit endpoints. The necessary change was exposing and propagating the renderer choice, expanding quality validation and recording the requested renderer for replay. Existing reference images, masks, format and transparency handling remain on those paths.

## Cost and speed

Both model pages list the same token prices: text input $5/M and cached text $1.25/M; image input $8/M and cached image input $2/M; image output $30/M. Equal token rates do not establish equal per-image costs. Use actual returned usage for representative requests before publishing a fixed per-image price or savings claim. [Sunburst pricing](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst), [Flare pricing](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare).

Flare's speed positioning is official; a local speed multiplier, per-image price and quality ranking across our presets are unknown. The subscription timings below cannot benchmark these models because renderer selection was not established.

## The subscription selector failed its negative control

We tested the documented Responses `tools[0].model` field against our separate, undocumented subscription endpoint. All requests used Astra as director, low quality, PNG and 1024-square requested size.

| Requested tool model | HTTP | Result |
| --- | --- | --- |
| `gpt-image-2.5-flare` | 200 | Image returned in 24,281 ms, 1,566,158 bytes |
| `gpt-image-2.5-sunburst` | 200 | Image returned in 25,194 ms, 1,570,428 bytes |
| `nonexistent-image-model-selection-probe` | 200 | Image also returned |

Both saved bird images were visually inspected: orange folded paper birds on ivory, without text. Both were 1254-square rather than the requested 1024-square. The output items contained no renderer `model` field.

Confidence: high that the endpoint accepted all three requests; unknown which image models executed. The invalid-name success means successful output alone cannot prove the selector is honored. It could be ignored or fall back internally. No claim that the subscription uses either Image 2.5 variant follows from this test, and this does not prove every possible future subscription selection mechanism is unavailable.

Consequently this integration rejects explicit renderer choices on `subscription` before sending requests. It never silently switches to API billing. `auto` preserves subscription behavior. Local probe records and inspected images are under `.playwright-mcp/image-2.5/`; they are scratch evidence, not public model-comparison assets.

## Implemented user contract

CLI, with `OPENAI_API_KEY` already set:

```sh
node dist/cli.js "an orange paper bird" --backend apikey --image-model flare --quality low -o draft.png
node dist/cli.js --edit draft.png --instruction "Make the paper blue; preserve the folds and framing" --backend apikey --image-model sunburst --quality high -o final.png
```

MCP:

```json
{
  "prompt": "an orange paper bird on ivory",
  "backend": "apikey",
  "image_model": "flare",
  "quality": "low",
  "output_path": "/absolute/project/public/images/bird.png"
}
```

Project default:

```json
{
  "backend": "apikey",
  "imageModel": "sunburst",
  "quality": "high",
  "outputDir": "./public/images"
}
```

Explicit calls override the profile. `--from` / `from_image` restores the saved renderer unless overridden. `auto` selects the built-in API default or the subscription's automatic renderer; omission permits inherited configuration. Existing `GPT_IMAGE_API_MODEL` overrides remain supported, including legacy IDs. `GPT_IMAGE_MODEL` and `GPT_IMAGE_PROOF_MODEL` remain the Astra/director and proof controls.

The choice propagates through generation, reference edits, upscales, series, social plates/carousels, generated web sources and model-assisted cutouts. Local-only operations do not invoke a model. The existing default subscription backend does not change.

## Verification and delivery

- `npm test`: build and all 97 offline tests passed. New checks cover both models in generation/edit payloads, references and masks, quality, override precedence, profile inheritance, replay, series, upscales, real CLI forwarding, access errors and the no-fallback boundary. Network requests in these tests are mocked.
- `npm run smoke:mcp`: real stdio handshake, all ten tools, seven renderer schemas, new quality choices, local catalog call and subscription-selection refusal passed without credentials or provider usage.
- Three live subscription probes were made; the negative control prevents claiming Image 2.5 live verification.
- No `OPENAI_API_KEY` was present in the task environment. No paid API generation, paid account access, precise editing comparison or `max` visual-quality benchmark was verified.
- Local source and `dist` were updated. Existing MCP processes must reconnect to load the changes. No new GitHub release, npm publication or client restart was performed.

The supplied session instructions and repository `CLAUDE.md` were used; root `AGENTS.md` was absent. The pre-existing `.gitignore` edit was preserved.
