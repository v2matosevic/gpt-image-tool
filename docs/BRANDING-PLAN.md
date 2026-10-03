# Branding upgrade: plan and delivery record

Agreed on 2026-10-02 by Codex and Claude Opus 5.5 at Marko's request.
Codex implements; Opus critiques the plan and reviews code and sample files.
The detailed public contracts are in [BRANDING.md](BRANDING.md).

Release follow-up, 2026-10-03: Marko authorized documentation, publication and
updating the local installation. The original implementation handoff below remains
dated evidence; current delivery status belongs in
[RELEASE-VERIFICATION.md](RELEASE-VERIFICATION.md).

## Intended outcome

Give an agent a complete path from image direction and logo exploration to reusable
website/branding assets and an exact brand board. Preserve approved artwork, make
new typography intentional, and distinguish generated raster concepts from vectors.

## Implementation plan

1. Share one compiler between generation and quota-free request preview. Add
   structured creative briefs, role-labelled references and validated project brands.
   Palette/logo references supply colors without sending logo shapes into scenes.
2. Read static font files and turn their glyphs into real paths. Check every character
   before spending image usage. Retain family, subfamily, weight, style and file hashes.
3. Build local logo kits from supplied marks/wordmarks or explicitly requested typeset
   names. Export supported layouts/variants, website/app/social files, review sheets
   and provenance manifests. Preserve vector truth and multicolor identity.
4. Compose editorial and grid brand boards with exact type, palette, logo and visual
   references. Export PNG, self-contained SVG presentation, JSON and CSS tokens.
   Optional generated tiles run sequentially and are labelled in the manifest.
5. Fix alpha resampling/compositing and preserve original pixels outside masked edits.
   Record actual output sizes and report diagnostic color/alpha/icon measurements.
6. Add logo form/material/pattern presets, examples and tool documentation. Verify
   through unit/integration checks, CLI, real MCP calls, visual inspection and a
   bounded subscription sample. Have Opus review the resulting source and files.

## Decisions refined with Opus

- An image model creates raster concepts. True logo SVG delivery starts from supplied
  vectors or font outlines. No automatic tracing, model-written SVG, CMYK/Pantone or
  print-ready certification is included.
- A project brand name is context. It never authorizes replacing a client's wordmark.
  Only explicit `brand_name` requests a newly typeset name, which is labelled as such.
- Flattening a multicolor mark can erase its defining shapes. Default mono/inverse
  delivery therefore requires supplied mono artwork for such marks. Explicit
  `monochrome_mode: silhouette` is a labelled opt-in to that lossy conversion.
- Preserve the existing 16-sent-reference limit. New roles are subject, style,
  photography, texture, composition, palette and logo. Nested brand/brief settings
  use camelCase; top-level MCP options use snake_case.
- Final profile names are `brand.colors`, `fonts.heading/body.path`, and
  `logos.mark/wordmark/monoDark/monoLight`. They replace the draft's provisional names.
- Font-file text uses actual metrics and outlines. System-font lookup remains only
  on the legacy `font_family` path. WOFF2, variable axes and certified complex-script
  shaping are outside this implementation.
- Reject unsupported/unsafe SVG rather than silently stripping meaningful artwork.
  Embedded PNG/JPEG/WebP sources can be raster inputs, never vector logo masters.
- Mask alpha supplies the editable region and transition. Do not add an unrequested
  feather outside that region. Resize a provider redraw to source dimensions, report
  aspect changes, and retain all opaque-mask bytes exactly.
- Color diagnostics use CIE76 Lab D65, explicitly labelled, rather than the draft's
  proposed CIEDE2000. Alpha-edge counts and small-icon measurements are report-only
  heuristics; neither a score nor a proof model certifies design quality.
- Keep the subscription default and automatic renderer selection. No paid API
  requests, publication, version bump or client/process restart belongs to this work.

## Review corrections implemented

Opus caught destructive automatic mono conversion, implicit wordmark creation,
short-name lockup imbalance, incomplete glyph preflight, incorrect font-family tokens,
wrong accent-role selection, profile color precedence, estimated font wrapping,
accent overpainting, invisible paper swatches and inconsistent board labels.
Codex corrected them and added regression checks for the consequential behaviors.

Codex identified two alpha bugs: straight-color interpolation during enlargement and
incorrect source-over in image padding. The existing overlay compositor was correct;
its logic is now shared. A provided mask now enforces outside-region pixel preservation
rather than relying on prompt instructions alone.

## Verification and delivery state

Implementation is present and built locally. The final suite passes **115 tests**;
the real 13-tool MCP smoke passes, preset regeneration is stable, `git diff --check`
passes and `npm audit --omit=dev` reports no vulnerabilities. No release is published and existing MCP clients have not been
restarted. Reconnect MCP to load new tool definitions from the rebuilt checkout.

- Baseline before edits: 97 tests passed.
- Final test evidence: `generated-images/branding-verification/tests-final.log`.
- Opus's final verdict is approved with no remaining blockers. He verified the
  carousel's actual accent pinning, independent multicolor-wordmark guard and
  caption inset in source. Codex owns the suite/MCP evidence and inspected the
  recomposed boards and every website/social icon after the changes.
- Focused regression checks cover reference roles, preview/request equality,
  profile precedence, font coverage/NFC/spacing, SVG input boundaries, honest vector
  output, explicit wordmark creation, multicolor mono omission, supplied counters,
  maskable geometry, opaque icons, text bounds and byte-exact mask preservation.
- Real stdio MCP smoke calls the catalog and all three new tools offline (13 tools).
- CLI fixture specifications run offline with an original synthetic test font;
  the fixture is MIT-licensed test geometry, not a typography-quality example.
- Visual sample uses separately supplied Georgia and Arial files; their names and
  hashes are recorded in local manifests. No system font is bundled.
- Live sample: exactly 3 low-quality subscription generation requests, sequential,
  proof disabled and retries bounded by a hard counter. Two leaf-symbol concepts
  and one material study completed. No paid API was used. Requested 1024 square
  returned 1254 square; the new actual-size warning reported this correctly.
- Live sample outputs were inspected. They show two similar concept alternatives,
  usable cutouts and a coherent material tile. This is a bounded behavior check,
  not a comparative quality benchmark or validation of every new preset.
- Reviewed local examples are under `generated-images/branding-verification/`:
  `kit-reviewed/sheet.png`, `board-reviewed-editorial/board.png`,
  `board-reviewed-grid/board.png`, and `live/verification.json`.

Confidence: high for measured local behavior and file-format checks; moderate for
creative usefulness based on the three-image sample; unknown for universal visual
quality or another account's provider access. Paid-provider live access was not tested.

Pre-existing edits to `.gitignore`, `README.md`, `docs/TOOLS.md`, `docs/MODELS.md`
and `docs/IMAGE-2.5-RESEARCH.md` are preserved. Only the first two documentation files
receiving new branding text were extended; existing model-selection notes remain.
