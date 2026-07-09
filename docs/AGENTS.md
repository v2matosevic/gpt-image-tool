# Using gpt-image-tool as an AI agent

A practical guide for agents (Claude Code, Codex, …) calling this tool over MCP. The same guidance is
returned in the `playbook` field of `list_image_presets`.

## The loop

1. **Pick a preset.** Call `list_image_presets` (optionally `category`) and choose the `id` that fits
   the goal. Don't hand-write a prompt — the preset compiler produces a better one from `subject` +
   `preset`.
2. **Generate.** `generate_image({ subject, preset, modifiers?, style? })`. The tool returns a file
   path — `Read` it to see the result and judge it.
3. **Refine.** Not right? Adjust `style.<dimension>` (e.g. `style.lighting`), add a `modifier`, or
   `edit_image` the result. To redo a past image with one change, `from_image` it.

Set `GPT_IMAGE_INLINE=1` (env, at registration) if you want the image returned inline so you can see
it directly without a separate read.

## Choosing the right call

| You want… | Use |
|---|---|
| A new image in a known style | `generate_image` + `preset` |
| A logo / icon / sticker / 3D element with no background | `generate_image` + `transparent: true` (or a transparent preset) |
| Several options to choose from | `generate_image` + `count: N` |
| A consistent set (same character/brand) | `generate_image` + `series: N` |
| To match an existing image's look | `style_reference: ["path"]` |
| To change part of an existing image | `edit_image` + `instruction` (+ `mask_path` to confine it) |
| A bigger, sharper version | `upscale_image` |
| Favicons / OG cards / hero / app icons | `export_web_assets` |
| To cut out a background | `remove_background` (busy background → `use_model: true`) |
| To reproduce/tweak a past image | `from_image` |
| A social post for a specific platform | `generate_image` + `platform` (native size + safe areas) |
| A headline/logo that must be EXACT | `create_social_card` (one call: plate + exact type + logo) — or plate preset → `compose_overlay` for full control |
| A coherent multi-slide carousel | `create_social_carousel` (slide 1's plate anchors the set) |

## Quality tips

- **Be specific in `subject`** — the preset supplies the *style*; you supply *what*. "a matte black
  ceramic mug with a thin gold rim" beats "a mug".
- **Text in an image:** put it in `style.text` (rendered verbatim, quoted). Keep it short; the model
  is most reliable on a few words. The **vision proof-loop runs automatically** whenever `style.text`
  is set: the render is proofread (spelling, diacritics, artifacts) and regenerated with feedback up
  to 3 attempts — read the ✓/✗ verdict in the result before publishing. If it still fails (long copy,
  heavy diacritics), switch strategy: generate a text-free plate and set the type with
  `compose_overlay` — that path is exact by construction and can place the real logo file too.
- **Platform posts:** pass `platform` instead of `size` — it picks the native resolution AND keeps
  composition out of the platform's UI overlays (story bars, TikTok rail, OG crop).
- **Brand color fidelity:** with `style_reference` set, the dominant brand colors are auto-extracted
  and anchored in the prompt (and reported back as `Brand palette:` in the result).
- **Don't over-stack** conflicting modifiers (e.g. `photoreal` on a `flat-vector` preset) — pick a
  coherent direction.
- **Web assets:** generate the source at high quality first (the tool auto-picks 2K for hero/og),
  then `export_web_assets` downsamples crisply. For favicons, generate a *simple* mark (e.g.
  `logo-mark`) — fine detail won't survive at 16px.

## Project branding

If the project has a `.gptimage.json` at its root, **every generation already inherits it** (brand
preset, palette, a `styleReference` logo anchor, output dir). You don't need to pass those each time —
just `subject` + any per-call overrides. To create one, write the file at the project root (schema in
[TOOLS.md](./TOOLS.md)).

## Gotchas

- Generation spends the user's ChatGPT/Codex quota. Don't fire many calls in parallel — prefer
  sequential; `count`/`series` already run sequentially for you.
- If a call fails with "session ended", the user must run `codex login` once — surface that, don't
  retry in a loop.
- The returned path is the source of truth; the image is on disk, not (by default) inline.
