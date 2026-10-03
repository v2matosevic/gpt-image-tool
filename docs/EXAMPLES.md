# From prompt to project asset

These are copyable starting points, not promises of identical pixels. Generations are nondeterministic. Replace `/project` with an absolute path inside your own project and inspect the result before using it.

## A landing-page hero

Ask your coding agent:

```text
Use gpt-image to generate a folded orange paper sculpture for my landing
page. Use product-studio, an ivory background, and no text. Save it to
public/images/hero.png in this project. Open it to check the result,
then wire it into the hero section with suitable alt text.
```

The MCP call has this shape:

```json
{
  "subject": "a folded orange paper sculpture",
  "preset": "product-studio",
  "background": "opaque",
  "style": { "color": "burnt orange and warm ivory", "avoid": ["text", "logos"] },
  "output_path": "/project/public/images/hero.png"
}
```

![AI-generated orange folded-paper sculpture.](assets/paper-sculpture.png)

This actual sample was generated through this tool's subscription MCP backend on September 5, 2026. Its full subject and style are in the [generation specification](assets/paper-sculpture.png.json), including the compiled and model-revised prompts. The short snippet above is a simpler starting point.

## A mascot with transparency

```text
Create a friendly folded-paper fox mascot with orange and ivory colors.
Use the mascot preset and transparency. Save it in public/images, then
inspect it on both light and dark backgrounds before using it.
```

![AI-generated folded-paper fox mascot with a transparent background.](assets/fox-mascot.png)

The [exact specification](assets/fox-mascot.png.json) records a real subscription generation. This path renders on a chroma field and removes it locally. A transparent file can still have imperfect edges; review at the intended display size.

## Edit an existing asset

Call `edit_image`:

```json
{
  "image_paths": ["/project/public/images/hero.png"],
  "instruction": "Change only the paper color to deep forest green. Keep the composition, paper texture, and background.",
  "output_path": "/project/public/images/hero-green.png"
}
```

Use a PNG `mask_path` for a targeted edit: transparent mask areas identify the region to regenerate. Edits are model-generated and can change details outside your intention. This recipe is documented, not a live edit result from the launch session.

## Export responsive images locally

After generation, call `export_web_assets` with:

```json
{
  "kind": "hero",
  "image_path": "/project/public/images/hero.png",
  "out_dir": "/project/public/images/responsive",
  "base_name": "hero",
  "format": "webp"
}
```

WebP output needs `sharp`, installed by the documented `npm ci`. PNG export also works without it. The hero exporter does not upscale beyond the source. `favicon`, `og`, and `appicon` are other `kind` values. [Full output sizes](TOOLS.md#export_web_assets).

## A consistent set

Put a `.gptimage.json` in the project with its palette and existing style-reference images. Ask for `series: 3` to reuse the first output as a style reference. Each image uses another generation; similar style does not guarantee an identical character.

## Exact text on a social image

Generate a text-free plate, then use `compose_overlay`:

```json
{
  "image_path": "/project/public/images/hero.png",
  "blocks": [{
    "text": "Made for the next idea.",
    "position": "top-left",
    "font_family": "Arial",
    "font_size": 64,
    "color": "#222421",
    "max_width_ratio": 0.8
  }],
  "output_path": "/project/public/images/social.png"
}
```

This uses local font rendering rather than asking a model to spell the headline. Inspect line breaks, contrast, and glyph coverage. `create_social_card` combines plate generation with the overlay; `create_social_carousel` repeats that process as a coherent set.

## Brand brief, logo kit and mood board

After upgrading to v0.6.0 and reconnecting MCP, ask your agent:

```text
Use gpt-image to read this project's brand settings. Preview the request first.
Make two logo-mark concepts and a contact sheet. Keep the existing client logo
unchanged. Build a logo kit from the artwork I selected, then make an editorial
brand board using our actual font files, declared colors and supplied imagery.
Inspect the logo at favicon size and review both light and dark variants.
```

The preview and supplied-artwork exports run locally. Concept generation consumes
usage; optional board tile generation does too. An existing `brand.name` does not
authorize re-typesetting its logo. Use `brand_name` explicitly to create a new
typeset name, and provide approved monochrome artwork for a multicolor mark.

Offline CLI examples, using the repository's synthetic test font:

```sh
node dist/cli.js --subject "an abstract leaf mark" --preset logo-mark --preview
node dist/cli.js --logo-kit test/fixtures/brand-kit.json -o generated-images/logo-kit
node dist/cli.js --brand-board test/fixtures/brand-board.json -o generated-images/brand-board
```

[All branding parameters and font/vector limits](BRANDING.md).

## Give your agent a standing instruction

Add this small rule to your project's agent instructions:

```text
When this project needs original imagery, use the configured gpt-image MCP
server. List presets first. Use our project profile and an absolute output
path under public/images. Generate one candidate, inspect the file, and
integrate it with alt text. Ask before switching to a paid backend. Preserve
existing brand logos by compositing the original asset. Never use credentials
or private client imagery in a public example.
```

The fuller [agent playbook](AGENTS.md) explains refinement and tool selection.
