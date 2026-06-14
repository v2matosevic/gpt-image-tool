# Per-project brand profile — `.gptimage.json`

Drop a `.gptimage.json` at a project's root and **every** `generate_image` in
that project inherits it as defaults — brand preset, palette, a logo anchor,
output dir, size/format. Agents then only pass `subject`; assets stay on-brand
without re-specifying the look each call. Per-call args always override the
profile. (Edits/upscales inherit only `outputDir` + `backend`.)

## Use it

```sh
cp examples/.gptimage.json /path/to/your-project/.gptimage.json
# then edit the values for the project's brand and commit it
```

The loader walks **up** from the directory the asset is written to (then
`CLAUDE_PROJECT_DIR`, then cwd), so a single long-lived MCP server picks the
right project's profile automatically. Override with `GPT_IMAGE_PROFILE=<path>`.

> **Must be valid strict JSON — no comments.** A malformed profile is silently
> ignored (logged to stderr) and assets come out un-branded. Keep it parseable.

## Fields (all optional)

| field | example | effect |
|---|---|---|
| `preset` | `"flat-vector"` | Default style id (see `list_image_presets` / docs/PRESETS.md). |
| `modifiers` | `["minimal"]` | Default modifier overlays. |
| `style` | `{ "color": "...", "mood": "..." }` | Default style dimensions: `medium, composition, subjectDetail, setting, lighting, camera, color, mood, detail`, plus `avoid: string[]` and `text`. |
| `styleReference` | `["./brand/logo.png"]` | **Strongest anchor** — every generation matches this image's look. Path resolves relative to the profile file. |
| `size` | `"1536x1024"` | Default canvas (`auto`, `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `1152x2048`). |
| `quality` | `"high"` | `auto` \| `low` \| `medium` \| `high`. |
| `format` | `"png"` | `png` \| `jpeg` \| `webp`. |
| `background` | `"auto"` | `auto` \| `transparent` \| `opaque`. |
| `outputDir` | `"./public/img"` | Where generated assets land. |
| `backend` | `"subscription"` | `subscription` (Codex quota, default) \| `apikey`. |

Full reference: [../docs/TOOLS.md](../docs/TOOLS.md) · preset catalog:
[../docs/PRESETS.md](../docs/PRESETS.md).
