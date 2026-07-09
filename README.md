# gpt-image-tool

Generate, **edit**, and **upscale** images from your **ChatGPT / Codex subscription** — no per-image
API cost — and expose that as a tool any LLM agent (Claude Code, Codex CLI, Cursor, …) can call via
the **Model Context Protocol (MCP)**. Also usable as a plain CLI.

It works by reusing the OAuth token that `codex login` already stores at `~/.codex/auth.json` and
POSTing to the same ChatGPT-backend Responses endpoint Codex uses, with the built-in
`image_generation` tool. This is the same mechanism behind Codex's own `$imagegen` — generation is
metered against your ChatGPT/Codex usage, not API credits.

**The agent doesn't write raw prompts.** It declares *intent* — a `subject` plus a curated **style
preset** (e.g. `product-studio`, `watercolor`, `app-icon`, `hero-3d`) and optional `modifiers`
(lighting, mood, color, angle) — and a built-in **prompt compiler** assembles the professional,
natural-language prompt the gpt-image model responds to best. **70 presets across 7 categories**, 23
composable modifiers, every dimension overridable. Edit and upscale work image-to-image (restyle,
swap backgrounds, mask **inpainting**, enhance to **2K**). Plus **transparency** (logos/stickers),
**variations** + consistent **series**, **brand profiles**, **web-asset export** (favicons/OG/hero/
app-icons), and **background cutout** — all free, all on the subscription.

Quality is closed-loop: a **vision proof-loop** sends every text-bearing render back through the
same free endpoint to proofread it (verbatim text, diacritics, artifacts) and auto-regenerates with
concrete feedback; **platform targets** (`instagram-story`, `tiktok`, `og-card`, …) pick the native
size and keep composition out of platform UI safe areas; a **brand palette** is auto-extracted from
your style references and anchored in the prompt; and **compose_overlay** / **create_social_card**
set headlines and the real logo deterministically (real fonts — exact spelling by construction) on
model-generated plates, with an automatic legibility scrim when the type would sink into the plate.
(The two compositing tools are the one feature that needs `sharp` installed — `npm i sharp` —
for SVG type rasterization; everything else stays dependency-free.)

## Documentation

| Doc | What's in it |
|---|---|
| This README | Overview, quick start, the toolkit, install/register, caveats. |
| [docs/AGENTS.md](docs/AGENTS.md) | How an AI agent should drive the tools (the practical loop). |
| [docs/TOOLS.md](docs/TOOLS.md) | Complete reference: every MCP tool + param, every CLI flag, `.gptimage.json`, env vars. |
| [docs/PRESETS.md](docs/PRESETS.md) | The full preset + modifier catalog (auto-generated). |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it works internally: auth, SSE, compiler, transparency, web pipeline, reliability. |

## How it works

```
agent ──MCP──▶ generate_image / edit_image / upscale_image
                     │  (subject + preset + modifiers + style)
                     ▼
              prompt compiler ──▶ optimized natural-language prompt + size/quality/format
                     ▼
              SubscriptionProvider
                ├─ read ~/.codex/auth.json (refresh token if expired)
                ├─ POST https://chatgpt.com/backend-api/codex/responses
                │     model gpt-5.5, tools:[{type:image_generation}], + input_image for edit/upscale
                └─ parse SSE → image_generation_call.result (base64)
              ──▶ save image to disk ──▶ return absolute path

MCP tools:  generate_image · edit_image · upscale_image · export_web_assets
            remove_background · compose_overlay · create_social_card · list_image_presets
```

The tool **saves the image to disk and returns its path**. That's the only return shape that works
for every agent: Codex can't see inline image blocks (it opens the path with its `view_image` tool),
and Claude Code can `Read` the path to view it. (Set `GPT_IMAGE_INLINE=1` to additionally embed the
image inline in MCP results.)

## Requirements

- Node 18+ (built/tested on Node 22).
- `codex` logged in with a ChatGPT account: run `codex login` once. The subscription backend needs
  no API key.

## Install & build

```bash
cd B:/Coding/gpt-image-tool
npm install
npm run build
```

## CLI

```bash
# Raw prompt (full manual control)
node dist/cli.js "a red fox curled up in fresh snow, soft watercolor" -o fox.png

# Preset-driven (compiled prompt): subject + style + modifiers + per-dimension overrides
node dist/cli.js --subject "a ceramic coffee mug with a gold rim" --preset product-studio --modifier warm-grade -o mug.png
node dist/cli.js --subject "a friendly robot mascot" --preset clay-render --style.color "teal and coral palette"

# Image-to-image
node dist/cli.js --upscale mug.png --guidance "sharpen the gold rim" -o mug-hi.png   # → 2K
node dist/cli.js --edit mug.png --instruction "place it on a sunlit wooden table"
node dist/cli.js --edit photo.png --mask mask.png --instruction "add a bird in the sky"  # inpaint
node dist/cli.js --subject "a fox logo" --preset logo-mark --transparent -n 4           # 4 variations
node dist/cli.js --subject "a hero banner" --preset hero-banner --style-ref brand.png    # match brand

# Discover presets, or fall back to the paid API
node dist/cli.js --presets photography      # prints the catalog (JSON)
node dist/cli.js "product mockup" --backend apikey   # paid OpenAI Images API (needs OPENAI_API_KEY)
```

Prints the saved file path to stdout. Key options: `--subject`, `--preset`, `--modifier` (repeatable),
`--style.<dim>`, `--upscale`, `--edit`, `--instruction`, `--guidance`, `--presets`, `-o/--out`,
`--size`, `-q/--quality`, `-f/--format`, `-b/--backend`, `--check`. Run `-h` for the full list.

## Presets & the prompt compiler

A **preset** is a curated bundle of prompt *dimensions* (medium, composition, lighting, camera,
color, mood, detail…) for a use case. The agent supplies a `subject`; the compiler weaves a
subject-led, natural-language prompt and resolves the recommended size/quality/format. **Modifiers**
(`golden-hour`, `cinematic`, `pastel`, `low-angle`, …) overlay onto any preset; a `style` object
overrides any single dimension; an `avoid` list and literal `text` are appended cleanly.

Categories: **photography** (product, food, portrait, automotive, macro, golden-hour…),
**illustration** (flat-vector, watercolor, oil, comic, ukiyo-e, children's-book…), **design**
(app-icon, logo-mark, ui-mockup, hero-banner, OG-card, sticker, seamless-pattern…), **render3d**
(isometric, clay, low-poly, CGI product, glass, voxel), **specialized** (pixel-art, blueprint,
infographic, tattoo-flash, cyberpunk, synthwave, trading-card…), **webdev** (hero-3d, icon-3d,
glyph-icon, spot-illustration, mesh-gradient, device-mockup, avatar, mascot, wireframe), and
**social** (type-led editorial card, image-led campaign card, textless concept hero, background
plate for type composited on top).

Full catalog: [docs/PRESETS.md](docs/PRESETS.md), or `node dist/cli.js --presets` / the
`list_image_presets` MCP tool. Adding a style is just dropping an entry into `src/presets/lib/*.ts` —
no engine change (`npm run docs:presets` regenerates the catalog).

### Health check

```bash
node dist/cli.js --check      # or: npm run check
```

Validates the subscription session **without spending any image quota** (it only exercises the
OAuth refresh). Prints the auth file in use, the signed-in account, the token expiry, and either
`✓ valid` or the exact re-login command. Run this first whenever generation fails or after setting
up a new machine.

## Register with agents

**Claude Code** (user scope = available in every project):

```bash
claude mcp add --scope user --transport stdio gpt-image -- node "B:/Coding/gpt-image-tool/dist/mcp.js"
```

**Codex** — in `~/.codex/config.toml`:

```toml
[mcp_servers.gpt-image]
command = "node"
args = ["B:/Coding/gpt-image-tool/dist/mcp.js"]
tool_timeout_sec = 180   # image generation exceeds the 60s default
```

By default it rides `~/.codex/auth.json` — the same login your normal Codex coding keeps fresh, so
nothing extra goes stale. `GPT_IMAGE_AUTH_FILE` can point it at a separate auth file, but note that
Codex allows only **one live ChatGPT session per machine**: a dedicated second account just gets
superseded (see *Caveats* → shared token file), so the override is rarely worth it. Any other MCP
client: run `node B:/Coding/gpt-image-tool/dist/mcp.js` as a stdio server.

## Backends

| Backend | Cost | Auth | Notes |
|---|---|---|---|
| `subscription` *(default)* | Free (your ChatGPT/Codex quota) | `~/.codex/auth.json` | The whole point of this tool. |
| `apikey` | Paid (~$0.01–0.17/image) | `OPENAI_API_KEY` | Stable fallback / bulk. Never used unless selected. |

## Configuration

Everything is optional for the subscription backend. The full table of environment variables, the
`.gptimage.json` profile schema, and every tool/flag are in **[docs/TOOLS.md](docs/TOOLS.md)**
(see also `.env.example`). Notable: `GPT_IMAGE_MODEL` (default `gpt-5.5`), `GPT_IMAGE_OUTPUT_DIR`,
`GPT_IMAGE_INLINE`, `GPT_IMAGE_PROFILE`, `GPT_IMAGE_MAX_RETRIES`.

## Web-ready assets (favicons, OG, hero, app icons)

Generate once, then slice into the exact production deliverables — correctly sized and cropped —
without leaving the tool. All local (no model call), and **dependency-free** (PNG + `.ico`); install
`sharp` only if you want `webp`/`jpeg` output or non-PNG input.

```bash
# from an existing image
node dist/cli.js --web favicon --image logo.png            # 16/32/48/180/512 PNGs + favicon.ico
node dist/cli.js --web og      --image hero.png             # 1200x630, 1080x1080, 1600x900
node dist/cli.js --web hero    --image hero.png             # responsive widths (640…1920)
node dist/cli.js --web appicon --image mark.png            # iOS/Android/PWA sizes

# or generate the source inline
node dist/cli.js --web favicon --subject "a mountain peak mark" --preset logo-mark
```

MCP: `export_web_assets({ kind, image_path | subject, out_dir? })`. Generate the source at high
quality (it auto-picks 2K for hero/og) and the slices downsample crisply.

**Background cutout** — `remove_background` (MCP) / `--remove-bg <image>` cuts out *any* image to a
transparent PNG. Best on clean/solid backgrounds (it's a chroma/edge keyer, not AI matting).

## Consistency & reproducibility

Three features keep a project's assets coherent and re-runnable:

**Project brand profile** — drop a `.gptimage.json` at your project root; every generation inherits
it (per-call args still override). Auto-found by walking up from `CLAUDE_PROJECT_DIR` / cwd.

```jsonc
{
  "preset": "flat-vector",
  "style": { "color": "navy, coral and cream brand palette" },
  "styleReference": ["./brand/hero.png"],
  "modifiers": ["minimal"],
  "avoid": ["watermark", "stock-photo look"],
  "outputDir": "./public/img"
}
```
`styleReference` (a logo/hero/brand image, resolved relative to the profile) is the strongest anchor —
every generation visually matches it. Paths in the profile resolve from the profile's own location.
Edits/upscales only inherit the *operational* defaults (output dir, backend) — never the brand
style — so an edit is never silently re-themed.

**Reproducible sidecars** — every output writes a `<image>.png.json` next to it (subject, preset,
modifiers, style, settings, compiled + model-revised prompt). Re-run or tweak any past image:

```bash
node dist/cli.js --from hero.png --style.color "warmer"   # reload hero's spec, change one thing
```
(Disable with `GPT_IMAGE_NO_SIDECAR=1`.)

**Series mode** — generate a *consistent* set (same character/brand look) by reusing the first
image as a style reference for the rest:

```bash
node dist/cli.js --subject "a robot mascot waving" --preset mascot --series 4
```
(`--count` gives N *independent* variations; `--series` gives N *coherent* ones.)

## Use it on a new machine

The repo carries the code; the **auth is per-device** (each machine has its own `codex login`; the
token file is never committed). On a fresh checkout:

```bash
git clone https://github.com/v2matosevic/gpt-image-tool.git
cd gpt-image-tool && npm install && npm run build

codex login            # if not already signed in on this machine
node dist/cli.js --check   # confirm the session is live
```

Then register with your agents (above), pointing `dist/mcp.js` at this checkout's path. That path
differs per machine, so the MCP registration is **not** synced between devices — set it once per
machine.

> ⚠ It's the same ChatGPT account & quota as your interactive Codex/ChatGPT use. Codex keeps only
> **one live session per machine**, and signing the same account into Codex on another device
> supersedes this one (`--check` will then report "session ended" — just `codex login` again).

## Model notes

The subscription endpoint routes to a current GPT Image model (the `gpt-image-2` generation as of
mid-2026). Verified behavior on this path: **2K output** (up to `2048x2048`; the long edge can go
higher but stays within the model's pixel budget), reference-image **edit/upscale**, and **mask
inpainting** (`input_image_mask`). It does **not** support a native transparent-background flag —
so transparency is produced by rendering on a chroma field and keying it out locally (see
`src/bgremove.ts`). The paid `apikey` backend (`gpt-image-1` by default; set `GPT_IMAGE_API_MODEL`)
*does* support native transparency and `input_fidelity` for faithful edits.

## Caveats (read once)

- **Undocumented endpoint.** `backend-api/codex/responses` is an internal API; OpenAI may change or
  restrict it, and the routing model id churns (a stale Codex `version` header gets `gpt-5.5` rejected
  with a 400 — this tool floors the header at `0.130.0` to avoid that). If the subscription path
  breaks, switch to `--backend apikey` while it's updated. The model is a one-line config const.
- **Terms of service.** Using this endpoint outside the official Codex client is unsanctioned. Fine
  for personal/dev use (it's the identical call Codex makes); do **not** point it at a public or
  multi-user service.
- **Shared token file.** This tool and Codex both refresh `~/.codex/auth.json` (last-writer-wins).
  We read fresh per call and only refresh when expired.
- **Rate limits.** Generation spends the same quota as interactive ChatGPT/Codex. A `429` means wait
  a few minutes; don't hammer it.
