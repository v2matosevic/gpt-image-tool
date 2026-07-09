# Reference — MCP tools, CLI, and configuration

Complete reference for every tool, flag, and setting. See [PRESETS.md](./PRESETS.md) for the preset
catalog and [ARCHITECTURE.md](./ARCHITECTURE.md) for internals.

## MCP tools

The server exposes seven tools. All image-producing tools **save to disk and return the path(s)**.

### `generate_image`
Text-to-image via the preset compiler (or a raw prompt).

| param | type | notes |
|---|---|---|
| `subject` | string | What to depict. Use with a `preset`. |
| `preset` | enum | A style id (see PRESETS.md / `list_image_presets`). |
| `modifiers` | string[] | Composable overlays (lighting/mood/color/quality/angle). |
| `style` | object | Override any dimension: `medium, composition, subjectDetail, setting, lighting, camera, color, mood, detail`, plus `avoid: string[]` and `text`. |
| `prompt` | string | Raw prompt — full manual control; bypasses preset composition. |
| `transparent` | bool | Transparent background (logos/icons/3D). Forces PNG. |
| `background` | enum | `auto` \| `transparent` \| `opaque`. |
| `style_reference` | string[] | Image path(s) used for *style only* (brand match), not content. A **brand palette** is auto-extracted from these and anchored in the prompt (disable: profile `autoPalette: false` / `GPT_IMAGE_NO_AUTOPALETTE=1`). |
| `platform` | enum | Target platform: `instagram-feed`, `instagram-story`, `tiktok`, `x-post`, `linkedin-post`, `og-card`, `youtube-thumbnail`, `pinterest-pin`. Picks the native size and appends a safe-area composition constraint. Explicit `size` wins. |
| `proof` | bool | **Vision proof-loop**: the model proofreads its own render (verbatim text, diacritics, artifacts) via the free subscription endpoint and auto-regenerates with feedback (≤3 attempts, `GPT_IMAGE_PROOF_ATTEMPTS`). Default: **on when `style.text` is set**. |
| `count` | int 1–10 | N **independent** variations. |
| `series` | int 1–10 | N **consistent** images (first reused as a style ref for the rest). |
| `from_image` | string | Reload a prior image's sidecar as the base, then apply args on top. |
| `size` | enum | `auto`, `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `1152x2048`. |
| `quality` | enum | `auto` \| `low` \| `medium` \| `high`. |
| `format` | enum | `png` \| `jpeg` \| `webp`. |
| `output_path` | string | File, or a directory ending in `/`. Default `./generated-images/`. |
| `backend` | enum | `subscription` (default) \| `apikey`. |

### `edit_image`
Image-to-image: edit / restyle / variation / inpaint.

| param | type | notes |
|---|---|---|
| `image_paths` | string[] | One or more references (first is primary; up to 16). **Required.** |
| `instruction` | string | What to change (e.g. "replace the background with a beach"). |
| `mask_path` | string | PNG mask: transparent areas mark the region to regenerate (inpainting). |
| `preset` / `modifiers` / `style` / `subject` | — | Optional restyle on top of the edit. |
| `proof` | bool | Vision proof-loop on the result (default: on when `style.text` is set). |
| `count`, `size`, `quality`, `format`, `output_path`, `backend` | — | As above. |

### `upscale_image`
Detail-enhancing regeneration toward the 2K tier (aspect-preserving).

| param | type | notes |
|---|---|---|
| `image_path` | string | Source. **Required.** |
| `guidance` | string | Extra hint ("sharpen the text, remove noise"). |
| `size` | enum | Target. Defaults to the largest size matching the source aspect. |
| `quality`/`format`/`output_path`/`backend` | — | As above. |

### `export_web_assets`
Slice one image into production deliverables (all local).

| param | type | notes |
|---|---|---|
| `kind` | enum | `favicon` \| `og` \| `hero` \| `appicon`. **Required.** |
| `image_path` | string | Existing source. Omit to generate from `subject`. |
| `subject` / `preset` / `transparent` | — | Generate the source inline if no `image_path`. |
| `out_dir` | string | Output folder (default: a `./web` folder next to the source). |
| `base_name` | string | Filename stem (default = kind). |
| `format` | enum | Preferred for og/hero (`png`\|`jpeg`\|`webp`); icons are always PNG. webp/jpeg need `sharp`. |

Outputs: **favicon** → 16/32/48/180/512 PNG + `favicon.ico`; **appicon** → 48…1024 PNG;
**og** → 1200×630, 1080×1080, 1600×900; **hero** → responsive widths (640…1920, ≤ source).

### `remove_background`
Cut out any image → transparent PNG. Local keyer by default; `use_model` for busy backgrounds.

| param | type | notes |
|---|---|---|
| `image_path` | string | **Required.** |
| `output_path` | string | Default `<image>-cutout.png`. |
| `tolerance` | int 0–180 | Local keyer: color tolerance vs the sampled background (default 28). |
| `use_model` | bool | Busy/photographic background: the model re-renders the subject on a chroma field (one subscription generation), then the keyer cuts that. |

### `compose_overlay`
Composite **exact text** (real installed fonts — spelling exact by construction) and/or the **real
logo asset** onto an image, deterministically. The premium social workflow: generate a text-free
plate (`social-bg-plate` / `concept-hero`), set the headline here. Text rasterization needs `sharp`.

| param | type | notes |
|---|---|---|
| `image_path` | string | The plate to composite onto. **Required.** |
| `blocks` | object[] | `{ text, position, font_family, font_size, font_weight, color, letter_spacing, line_height, max_width_ratio, uppercase }`. Positions: `top/center/bottom` × `left/center/right`. |
| `logo` | object | `{ path, position, width_ratio (default 0.14), opacity }` — the real PNG asset, never model-drawn. |
| `platform` | enum | Keep overlays inside this platform's UI safe areas. |
| `output_path` | string | Default `<image>-final.png`. |
| `format` | enum | `png` (default) \| `jpeg` \| `webp`. |

### `list_image_presets`
Returns the catalog (`presets`, `modifiers`, `categories`), a `usage` line, and a `playbook` for
agents. Optional `category` filter.

## CLI

```
gpt-image "<prompt>" [options]                      # raw prompt
gpt-image --subject "<thing>" --preset <id> [...]   # compiled
gpt-image --upscale <path> | --edit <path> | --web <kind> | --remove-bg <path>
gpt-image --presets [category] | --check
```

| flag | meaning |
|---|---|
| `--subject <text>` | What to depict (with `--preset`). |
| `--preset <id>` | Curated style. |
| `--modifier <id>` | Layer a modifier (repeatable). |
| `--style.<dim> <text>` | Override a dimension (e.g. `--style.lighting "neon glow"`); `--style.avoid a,b`, `--style.text "SALE"`. |
| `--transparent` | Transparent background. |
| `-n, --count <N>` | N independent variations. |
| `--series <N>` | N consistent images. |
| `--from <image>` | Reproduce/tweak from a sidecar. |
| `--style-ref <path>` | Style/brand reference (repeatable; auto-palette anchor). |
| `--platform <id>` | Platform target: native size + safe-area composition. |
| `--proof` / `--no-proof` | Force / skip the vision proof-loop (default: on when `--style.text` is set). |
| `--use-model` | With `--remove-bg`: model-assisted cutout for busy backgrounds. |
| `--upscale <path>` / `--guidance <text>` | Upscale to 2K. |
| `--edit <path>` / `--instruction <text>` / `--mask <path>` | Edit / inpaint. |
| `--web <kind>` / `--image <path>` | Export web assets (source = `--image` or generated). |
| `--remove-bg <path>` | Background cutout. |
| `--presets [category]` | Print the catalog (JSON). |
| `--size`, `-q/--quality`, `-f/--format`, `-b/--backend` | Output controls. |
| `-o/--out <path>` | Output file or directory. |
| `--check` | Validate the session (no quota spent). |
| `-h/--help` | Full help. |

CLI prints the saved path(s) to **stdout**; status/errors to **stderr**.

## Project brand profile — `.gptimage.json`

Placed at a project root; auto-found by walking up from `CLAUDE_PROJECT_DIR` / cwd. Applied as
defaults to every `generate_image` (per-call args override). Edits/upscales inherit only `outputDir`
and `backend`. Paths resolve relative to the profile's own location.

```jsonc
{
  "preset": "flat-vector",
  "modifiers": ["minimal"],
  "style": { "color": "navy, coral and cream palette", "mood": "confident, modern" },
  "styleReference": ["./brand/hero.png"],   // strongest anchor: every gen matches this image
  "platform": "instagram-feed",             // default platform target (native size + safe areas)
  "autoPalette": true,                      // anchor colors to styleReference's real palette (default)
  "proof": true,                            // force the vision proof-loop on every generation
  "avoid": ["watermark", "stock-photo look"],
  "size": "1536x1024",
  "format": "png",
  "background": "auto",
  "outputDir": "./public/img",
  "backend": "subscription"
}
```

## Sidecars

Every output writes `<image>.<ext>.json` with the full spec (subject, preset, modifiers, style,
settings, compiled + model-revised prompt, references). `--from` / `from_image` reload it. Disable
with `GPT_IMAGE_NO_SIDECAR=1`.

## Environment variables

| var | default | purpose |
|---|---|---|
| `GPT_IMAGE_MODEL` | `gpt-5.5` | Subscription routing model id. |
| `GPT_IMAGE_API_MODEL` | `gpt-image-1` | Model for the `apikey` backend. |
| `GPT_IMAGE_BACKEND` | `subscription` | Default backend. |
| `OPENAI_API_KEY` | — | Required only for `--backend apikey`. |
| `GPT_IMAGE_AUTH_FILE` | `~/.codex/auth.json` | Pin to a specific account's token file. |
| `CODEX_HOME` | `~/.codex` | Override the Codex home. |
| `GPT_IMAGE_OUTPUT_DIR` | `./generated-images` | Default save directory. |
| `GPT_IMAGE_PROFILE` | auto-found | Explicit path to a `.gptimage.json`. |
| `GPT_IMAGE_INLINE` | off | `1` = also return the image inline in MCP results. |
| `GPT_IMAGE_NO_SIDECAR` | off | `1` = don't write sidecars. |
| `GPT_IMAGE_TIMEOUT_MS` | `300000` | Total request timeout. |
| `GPT_IMAGE_STALL_MS` | `120000` | Abort if the stream stalls this long. |
| `GPT_IMAGE_MAX_RETRIES` | `3` | Auto-retries on 429/5xx/network. |
| `GPT_IMAGE_PROOF_MODEL` | `gpt-5.5` | Model used by the vision proof-loop. |
| `GPT_IMAGE_PROOF_ATTEMPTS` | `3` | Max generation attempts in the proof-loop (1–5). |
| `GPT_IMAGE_PROOF_TIMEOUT_MS` | `120000` | Proofread request timeout. |
| `GPT_IMAGE_NO_AUTOPALETTE` | off | `1` = never auto-extract a brand palette from style refs. |
