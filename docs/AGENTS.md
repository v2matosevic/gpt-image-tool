# Using gpt-image-tool as an AI agent

A practical guide for agents (Claude Code, Codex, …) calling this tool over MCP. The same guidance is
returned in the `playbook` field of `list_image_presets`.

## The loop

For brand work, read [BRANDING.md](BRANDING.md). Use `preview_image_request` before
an expensive batch. Explore logo forms with the branding presets and a contact
sheet, then use `export_logo_kit` with the chosen artwork. A raster concept is not
an SVG master, and `brand.name` never authorizes re-typesetting an existing logo.
Use `create_brand_board` to combine the real identity, exact font-file specimens,
palette and image references. Supplied tiles are local; `generate` is explicit.

1. **Pick a preset.** Call `list_image_presets` (optionally `category`) and choose the `id` that fits
   the goal. Don't hand-write a prompt — the preset compiler produces a better one from `subject` +
   `preset`.
2. **Generate.** `generate_image({ subject, preset, modifiers?, style? })`. The tool returns a file
   path — `Read` it to see the result and judge it.
3. **Refine.** Not right? Adjust `style.<dimension>` (e.g. `style.lighting`), add a `modifier`, or
   `edit_image` the result. To redo a past image with one change, `from_image` it.

Set `GPT_IMAGE_INLINE=1` (env, at registration) if you want the image returned inline so you can see
it directly without a separate read.

## Multi-step work: Studio

Use single calls for one or two images you will judge on the spot: a quick hero, an icon, an
edit of one file. Use Studio when any of these is true:

- the task needs three or more related images (variations, a lookbook, one prompt across several
  subjects or sizes, the same look across a set);
- you will iterate: compare takes, pick one, then edit or sweep from it;
- a person should review the images, or a choice should be recorded with its reasons;
- an approved image becomes code (a page, a component), or a draft is to be finished at full size;
- the work may be resumed later, by you or by another agent.

How: `studio_guide` once (topic `renderer` before any paid work), then `studio_create`, a dry
run (`studio_run` with `dry_run: true`; it shows the plan, the compiled prompts and any API
estimate), `studio_run`, and `studio_status` for the result. Open the review sheet it names and the
images themselves; deviations are measurements to confirm by looking, not verdicts. Answer the
take's checklist or write a critique, then approve; an agent cannot approve without a recorded
look. Revise with `studio_edit`: unchanged images are reused, not regenerated. For a person, write a
side-by-side page with `studio_view {page: {}}` (CLI `gpt-image studio page <graph>`) and give them
its path. A handoff node turns an approved image into a build package for a coding agent.

Studio renders everything on the subscription unless a node says `renderer: "api"` or is a
`finish` node. Quality `low` is the default; on the subscription `high` is sent but not shown to
change the result ([Account and quota](STUDIO.md#account-and-quota)). A run stopped by the
subscription's image cap says when it resets; resume after that, not before. [STUDIO.md](STUDIO.md).

## Subscription or paid API

Simple, everyday images always go on the subscription. The paid API is for images that need real refinement and the highest quality. Before choosing it, ask: will anyone look at this image at full size, print it, ship it as a hero or brand asset, or does it need a size or precision the subscription cannot give (above about 1254 px, a custom aspect, `xhigh`/`max`, complexity)? If not, stay on the subscription. Never default a project to the API, and never switch someone's work to paid billing they did not ask for.

When the API is right, use the ladder: draft cheaply (the subscription, or `flare` at `low`, about 2.5 cents at 1024 px), look and choose, then finish only the chosen image from its pixels, an edit with `sunburst`, `high` and the final size, never a fresh generation from the prompt (that gives a different object). In Studio the `finish` node does this after an approval. Run a dry run first; it prices the work.

## Choosing the image model

On the explicit `apikey` backend, `flare` is fast and `sunburst` is precise; since v0.7.0 both are GPT-Image-2.6 (`flare-2.5` / `sunburst-2.5` keep 2.5) and Sunburst is the default. Keep model choice separate from quality: use `low` for drafts, compare `high`, `xhigh` or `max` for final assets. Subscription renderer selection is unverified and named selections are refused, even though direct experimental requests can return images.

## Spend limits

Every paid request in the tool is checked before it is sent: a run limit (default $2, counted across resumes; the same amount bounds one direct tool call), a day limit per project ($10), a project ceiling ($50) only the owner's profile can change, and a user-level limit across all projects ($25 a day, ceiling $100) only the owner's `~/.gptimage/config.json` can change. When a limit stops a run, the result says what the rest needs. Ask the owner once, with that amount. Do not work around it: no fresh run, no other renderer, no repeated asking. When the owner approves in chat, record exactly that with `studio_budget` (amount, their words, who approved), then resume. A grant ends with the day. Direct `generate_image` / `edit_image` calls are refused the same way, with "Spend limit:" and the fix; never split work into more calls to get under a limit. If a ledger line cannot be read, every paid request is refused with the file and line named: tell the owner rather than editing the ledger.

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
| Inspect the request without quota | `preview_image_request` |
| Logo family, true vector wordmark, website/social package | `export_logo_kit` |
| Exact brand board, font specimens, palette and tokens | `create_brand_board` |

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
- **Preserve identity:** pass dedicated `monoDark` / `monoLight` assets for multicolor logos.
  Flattening every color into one ink can erase important interior shapes. Font-file typesetting
  creates a new name only when explicitly requested. Review both light and dark versions.
- **Masked edits:** opaque mask pixels stay byte-identical to the original by default. The mask's
  alpha supplies the transition. `preserve_unmasked: false` deliberately returns the full redraw.
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
