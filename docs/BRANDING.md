# Branding workflow

Version 0.6.0 adds three tools: `preview_image_request`, `export_logo_kit`
and `create_brand_board`. Build with `npm run build`, then reconnect MCP in the
client to load the new tool definitions. [Release notes](releases/v0.6.0.md).

The workflow has separate exploration and delivery steps. Image generation makes
raster concepts. Local exports use supplied artwork and font outlines. A generated
PNG is never relabeled as a vector logo.

## 1. Describe and preview the image

`preview_image_request` takes the same arguments as `generate_image`. It reads
local references and the project's profile, compiles the actual request and reports
its backend, renderer selection, dimensions, transparency method, reference roles,
palette source and request bounds. It never reads credentials or calls a provider.

```json
{
  "subject": "an abstract folded-leaf symbol",
  "preset": "logo-mark",
  "brief": {
    "purpose": "a website identity that reads at favicon size",
    "audience": "independent architecture studios",
    "direction": "one continuous ribbon with an open counter",
    "palette": ["#234D3C", "#F1B954"],
    "avoid": ["lettering", "presentation mockups"]
  },
  "references": [{"path": "/project/brand/material.png", "role": "texture"}],
  "backend": "subscription",
  "image_model": "auto",
  "quality": "low",
  "proof": false
}
```

Brief fields are `purpose`, `audience`, `brandName`, `direction`, `composition`,
`palette`, `mustInclude`, `avoid` and `preserve`. These nested fields use camelCase,
like the existing `style.subjectDetail`. `style.text` remains the literal copy
field. A brief's brand name is context, not permission to add lettering.

Each reference has `path`, `role` and optional `instruction`:

| Role | What reaches the model |
| --- | --- |
| `subject` | The image, with identity/geometry instructions |
| `style` | The image, for treatment and lighting rather than content |
| `photography` | The image, for light, grade and lens feel |
| `texture` | The image, for surface/material treatment |
| `composition` | The image, for placement and negative space |
| `palette` | Extracted colors only; the image is not attached |
| `logo` | Extracted colors only; exact artwork is reserved for local compositing |

Sent images are numbered in the prompt; at most 16 may be sent. Legacy
`style_reference` still works. Missing explicit references fail before requests;
unreadable legacy style references retain their old skip behavior and produce a
preview warning. Declared colors take precedence over extracted colors. A per-call
`style.color` overrides project colors. A legacy profile `style.color` does not
override a new `brand.colors` declaration.

CLI: `--preview` (or `--dry-run`), `--brief brief.json`, and repeatable
`--reference texture:/absolute/path.png`. Preview is generation-only; combining
it with another operation fails without running that operation.

## 2. Keep the brand in the project

Add a `brand` block to `.gptimage.json`. Its paths resolve relative to that file.
The new structured fields are validated; malformed brand settings fail explicitly.
Existing top-level profile fields retain their previous behavior.

```json
{
  "brand": {
    "name": "Northline",
    "tagline": "Material, light and considered form",
    "colors": [
      {"name": "Pine", "role": "primary", "hex": "#234D3C"},
      {"name": "Ink", "role": "ink", "hex": "#1C2821"},
      {"name": "Paper", "role": "paper", "hex": "#F4F0E6"},
      {"name": "Marigold", "role": "accent", "hex": "#F1B954"}
    ],
    "fonts": {
      "heading": {"path": "./brand/Heading-Regular.otf"},
      "body": {"path": "./brand/Body-Regular.ttf"}
    },
    "logos": {
      "mark": "./brand/mark.svg",
      "wordmark": "./brand/wordmark.svg",
      "monoDark": "./brand/mark-mono.svg",
      "monoLight": "./brand/mark-inverse.svg"
    }
  },
  "references": [{"path": "./brand/material.png", "role": "texture"}],
  "outputDir": "./public/images"
}
```

Colors require unique CSS-safe roles and six-digit hex values. Fonts accept static
TTF, OTF or WOFF files. WOFF2 and variable-font axes are unsupported. Missing
characters fail by name, including diacritics. Text is normalized to NFC. Outlined
Latin text, kerning and tracking are tested; complex-script shaping is not certified.
The files retain actual family, subfamily, weight and style metadata. Supply licensed
font files; the tool does not bundle or install your fonts.

`compose_overlay.blocks[].font_file`, `create_social_card.headline_font_file` and
`subline_font_file` use these outlines. Social cards inherit declared brand font
files unless a caller explicitly chooses a different font. The same fields work
on carousels. All carousel copy is checked for glyph coverage before its first
generation. Existing `font_family` still uses system font lookup and can fall back.
SVG overlay logos are rendered at the target size.

## 3. Explore logo forms

Use `logo-mark`, `logo-wordmark`, `logo-monogram`, `logo-emblem`,
`logo-combination` or `logo-mascot`. `brand-material` and `brand-pattern` supply
supporting visual directions. A pattern concept is not a verified seamless tile.

`count` produces independent alternatives; `series` anchors a coherent set. Choose
one mode. Add `contact_sheet: true` to save a labelled review image and its source
map next to the results. These generations run sequentially and consume usage.
Logo results and sidecars say `deliverable: "concept-raster"`; other model outputs
say `generated-raster`.

## 4. Export the website and social logo kit

```json
{
  "mark_path": "/project/brand/mark.svg",
  "wordmark_path": "/project/brand/wordmark.svg",
  "out_dir": "/project/public/brand",
  "layouts": ["mark", "wordmark", "horizontal", "stacked"],
  "formats": ["png", "webp", "svg"]
}
```

`export_logo_kit` is local. It accepts a `brand` object or discovers the profile
from `out_dir`. `mark_path` and `wordmark_path` override profile artwork. To create
a new typeset name explicitly, pass `brand_name` and `font_file` (or a declared
heading font). Merely declaring `brand.name` never creates a replacement logo.
Supplied wordmark artwork wins over typesetting. New typeset names are labelled
as such in the manifest and sheet; the tool does not claim they are approved.

| Parameter | Default / behavior |
| --- | --- |
| `variants` | `color`, `mono`, `inverse` |
| `layouts` | All layouts supported by the supplied components |
| `formats` | PNG, WebP, SVG; review PNGs are always written |
| `padding` | 0.12 for icons, range 0.02–0.35 |
| `social` | `true`, includes avatar and Open Graph card |
| `base_name` | `logo`; filename stem only |
| `monochrome_mode` | `preserve`; see the color boundary below |

SVG logos require vector geometry in every component. SVG-wrapped PNGs are treated
as raster. Outlined fonts qualify as vector geometry. Supplied SVG text, scripts,
foreign objects, external resources, embedded SVG images, stylesheet blocks and
filters are rejected; export outlined artwork with presentation attributes.
Supported local gradients, clipping, masks and references are preserved and IDs
are namespaced. Rejection does not modify the source file.

Multicolor art can lose its identifying detail when flattened. By default, provide
`brand.logos.monoDark` and `monoLight`; missing mono variants of multicolor art are
omitted with a reason. An explicit `monochrome_mode: "silhouette"` allows derived
silhouettes and records that choice. A multicolor wordmark also needs a separately supplied single-ink
wordmark for mono lockups; a mono symbol does not authorize flattening its lettering.
White counters are removed from derived
monochromes; all-white reversed masters retain their alpha silhouette. An SVG
recolor must also match the intended raster ink silhouette at IoU ≥ 0.99. This is
a geometry check, not an aesthetic verdict.

The kit contains:

- `logo/`: color/mono/inverse files for each requested, supported layout.
- `web/`: PNG icons, multi-size `favicon.ico`, vector favicon when possible,
  opaque Apple touch icon, circle-safe maskable icon, web manifest and head markup.
- `social/`: circle-safe avatar and 1200×630 Open Graph image.
- `sheet.png`, its source map, an actual-size icon proof strip, and `kit.json` with
  source/font hashes, dimensions, vector flags, origin labels, checks and omissions.

Monochrome files, new typeset names and generated concepts still need visual
selection. Large raster exports are resampled, not new detail. PNG sources should
have real alpha; opaque backgrounds and low-resolution sources are reported.

## 5. Create a full brand board

```json
{
  "out_dir": "/project/brand/board",
  "layout": "editorial",
  "assets": [
    {"path": "/project/brand/material.png", "label": "Material and light"},
    {"path": "/project/brand/concept.png", "label": "Logo direction", "fit": "contain"}
  ],
  "keywords": ["Grounded", "Precise", "Warm"]
}
```

`create_brand_board` uses the supplied/profile brand. A heading font file is
required; the body font defaults to it. The editorial layout uses a large image
bleeding to the left edge; grid uses aligned identity/type/direction columns and
equal image rows. Both render exact color names/hexes, contrast measurements,
font specimens and supplied logo geometry. Palette swatches close to the board's
ground get a visible border. The board height grows to fit up to eight tiles.

Supplied `assets` are local and cost no image usage. Optional `generate` entries
have `subject`, optional `preset`, and `label`. Up to four generated tiles run
sequentially, with the first generated tile anchoring later ones. Set `quality`,
`backend` and `image_model` explicitly when needed. All fonts, annotations and
supplied inputs are checked before generation. Proofreading is off for these
text-free tiles; local type supplies the labels.

Outputs are `board.png`, `board.svg`, `board.json`, `tokens.json` and `tokens.css`.
The SVG embeds its raster tiles and outlines its type, so it is self-contained but
is not an all-vector logo master. Tokens include actual font families, weights and
styles; webfont loading remains the site's responsibility. No font files are copied.

## CLI specifications and verification

```sh
node dist/cli.js --logo-kit brand-kit.json -o public/brand
node dist/cli.js --brand-board brand-board.json -o brand/board
```

CLI specification files use camelCase core keys: `markPath`, `wordmarkPath`,
`brandName`, `fontPath`, `outDir`, `baseName`, `monochromeMode`, and `imageModel`.
All input paths in these files resolve relative to the specification. `-o` resolves
relative to the shell's current directory. Runnable offline examples live in
[`test/fixtures`](../test/fixtures/README.md).

Every generated output records actual size/format/alpha, requested-size mismatches,
reference roles, resolved settings and brand hashes. Color diagnostics use
**CIE76 Lab D65**, not CIEDE2000, and edge counts are candidates for visual inspection.
Shadows, dark artwork and antialiasing can legitimately trigger them. Logo-kit
checks also measure small-icon ink coverage and connected components. They do not
certify visual quality.

Masked edits preserve all original pixels where the mask is opaque by default.
The mask's alpha controls the transition; no feather is silently added outside
the editable area. Outputs are PNG at the original dimensions. An aspect mismatch
is reported. `preserve_unmasked: false` returns the full model redraw instead.

`npm test` and `npm run smoke:mcp` run offline. The latter calls all three new tools
through a real stdio MCP connection. The optional manual live test:

```sh
node scripts/verify-branding-live.mjs brand-kit.json generated-images/live-check
```

That script spends at most three subscription image requests (including a forced
no-image retry), disables transport retries, and records a manifest. It never uses
the paid API. It is not part of CI. Output inspection remains required.

The request design follows [OpenAI's prompting guide](https://developers.openai.com/api/docs/guides/image-prompting): state use/composition, label references, separate edits from preserved constraints, and inspect results. Font outlines use [opentype.js](https://github.com/opentypejs/opentype.js). Provider/model selection and billing boundaries remain as documented in [MODELS.md](MODELS.md).
