// MCP stdio server. Tools any MCP client (Claude Code, Codex, Cursor, …) can call:
//   generate_image      text-to-image via preset compiler; platform targets; vision proof-loop
//   edit_image          image-to-image edit / restyle / variation from reference image(s)
//   upscale_image       detail-enhancing regeneration of an existing image (up to ~2K)
//   export_web_assets   slice one image into favicons / OG cards / hero / app icons
//   remove_background   local chroma keyer, or model-assisted cutout (use_model)
//   compose_overlay     deterministic type + real-logo compositing (exact by construction)
//   create_social_card  one call: text-free plate + exact type + logo
//   list_image_presets  the catalog of presets + modifiers + platforms so the agent chooses well
//
// All return the saved file path as text (works everywhere); GPT_IMAGE_INLINE=1 also attaches the
// image inline. IMPORTANT: stdout is the JSON-RPC channel — never write to it; logging goes to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { editImage, generateImage, upscaleImage, type GenerateOutput } from "./generate.js";
import { catalog, MODIFIER_IDS, PRESET_IDS } from "./presets/index.js";
import { exportWebAssets } from "./webassets.js";
import { cutoutPath, removeBackgroundFile } from "./imageops.js";
import { PLATFORM_IDS, PLATFORMS } from "./platforms.js";
import { composeOverlay } from "./typeset.js";
import { createSocialCard } from "./socialcard.js";
import type { ImageFormat } from "./providers/types.js";

const INLINE = process.env.GPT_IMAGE_INLINE === "1";

function mimeFor(f: ImageFormat): string {
  return f === "jpeg" ? "image/jpeg" : f === "webp" ? "image/webp" : "image/png";
}

const sizeSchema = z.enum([
  "auto",
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "1024x1280",
  "1280x1024",
  "2048x2048",
  "2048x1152",
  "1152x2048",
]);
const qualitySchema = z.enum(["auto", "low", "medium", "high"]);
const formatSchema = z.enum(["png", "jpeg", "webp"]);
const backendSchema = z.enum(["subscription", "apikey"]);

// Per-dimension overrides. Any field left out falls back to the preset's value.
const styleSchema = z
  .object({
    medium: z.string().optional().describe('Form, e.g. "watercolor painting", "studio photograph".'),
    composition: z.string().optional().describe("Framing/angle/layout."),
    subjectDetail: z.string().optional().describe("Material/finish/wardrobe applied to the subject."),
    setting: z.string().optional().describe("Background/environment."),
    lighting: z.string().optional(),
    camera: z.string().optional().describe("Lens/aperture/film (photography)."),
    color: z.string().optional().describe("Palette / color grade."),
    mood: z.string().optional().describe("Atmosphere/feel."),
    detail: z.string().optional().describe("Quality/detail tags."),
    avoid: z.array(z.string()).optional().describe("Things to steer away from."),
    text: z.string().optional().describe("Literal text to render legibly in the image."),
  })
  .partial();

// Diacritics the model is least reliable at rendering verbatim (Croatian + common Latin-ext).
const ACCENTED_RE = /[čćžšđČĆŽŠĐáàâäãåéèêëíìîïóòôöõúùûüñçА-я]/;

function ok(out: GenerateOutput, verb: string) {
  const allPaths = [out.path, ...(out.variants ?? [])];
  const pathLine = allPaths.length > 1 ? `${allPaths.length} images saved to:\n${allPaths.join("\n")}` : `saved to:\n${out.path}`;
  // Vision proof-loop verdict (when it ran) — the model proofread its own output.
  let verdictLine = "";
  if (out.proof) {
    if (out.proof.unverified) {
      verdictLine = `\n\n⚠ Auto-proofread could NOT run — the image is unverified. Inspect it yourself before publishing.`;
    } else if (out.proof.pass) {
      verdictLine =
        `\n\n✓ Auto-proofread PASSED (${out.proof.attempts ?? 1} attempt${(out.proof.attempts ?? 1) > 1 ? "s" : ""})` +
        (out.proof.textRead ? ` — text read back: "${out.proof.textRead}"` : "");
    } else {
      verdictLine =
        `\n\n✗ Auto-proofread FAILED after ${out.proof.attempts} attempts — DO NOT publish without fixing:\n` +
        out.proof.issues.map((i) => `  • ${i}`).join("\n") +
        `\nConsider compose_overlay (deterministic type) or a different preset.`;
    }
  }
  // Proof gate — every source stresses: even at high accuracy, verify before publishing.
  const proof =
    verdictLine +
    `\n\n--- Verify before publishing ---\n` +
    `• Text: every word spelled right, verbatim, no duplicated/stray text.  • Single-accent rule held.\n` +
    `• Logo/wordmark integrity (the model can't reproduce a real logo — composite the real asset).\n` +
    `• Kerning + the platform safe area (preview on a phone: top ~10% / bottom ~12% get covered by UI).` +
    (ACCENTED_RE.test(out.prompt)
      ? `\n⚠ Accented text (e.g. Croatian č/ć/ž/š/đ) detected — check EVERY mark. If any is wrong after 1–2 tries, set the type in a deterministic compositor (Remotion) instead.`
      : ``);
  const text =
    `Image ${verb} via the ${out.backend} backend and ${pathLine}\n\n` +
    `Open/view to see (${out.bytes} bytes, ${out.format}${out.background === "transparent" ? ", transparent" : ""}).` +
    (out.preset ? `\nPreset: ${out.preset}${out.modifiers.length ? ` + [${out.modifiers.join(", ")}]` : ""}` : "") +
    (out.platform ? `\nPlatform: ${out.platform} — ${out.platformNote}` : "") +
    (out.palette?.length ? `\nBrand palette (auto-extracted from style refs): ${out.palette.join(", ")}` : "") +
    `\nCompiled prompt: ${out.prompt}` +
    (out.revisedPrompt ? `\nModel-revised prompt: ${out.revisedPrompt}` : "") +
    proof;
  const content: Array<Record<string, unknown>> = [{ type: "text", text }];
  if (INLINE) content.push({ type: "image", data: out.base64, mimeType: mimeFor(out.format) });
  return { content } as any;
}

function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text", text: `Image operation failed: ${msg}` }] } as any;
}

const server = new McpServer({ name: "gpt-image", version: "0.2.0" });

server.registerTool(
  "generate_image",
  {
    title: "Generate image (ChatGPT subscription)",
    description:
      "Generate an image from text using the user's ChatGPT/Codex subscription (no API cost). " +
      "PREFERRED USAGE: pass `subject` (what to depict) + `preset` (a curated style) + optional " +
      "`modifiers` (lighting/mood/color/angle) + `style` (override any dimension). The tool compiles " +
      "a professional prompt for you. Call list_image_presets first to see all presets. " +
      "Alternatively pass a raw `prompt` for full manual control. Saves to disk, returns the path.",
    inputSchema: {
      subject: z.string().optional().describe("What to depict, e.g. 'a matte black ceramic coffee mug'. Use with a preset."),
      preset: z
        .enum(PRESET_IDS as [string, ...string[]])
        .optional()
        .describe("Curated style preset. See list_image_presets for descriptions."),
      modifiers: z
        .array(z.enum(MODIFIER_IDS as [string, ...string[]]))
        .optional()
        .describe("Composable overlays (lighting/mood/color/quality/angle) layered onto the preset."),
      style: styleSchema.optional().describe("Override individual prompt dimensions (and avoid[]/text)."),
      prompt: z.string().optional().describe("Raw prompt for full manual control. If set, preset/subject composition is bypassed."),
      transparent: z.boolean().optional().describe("Render on a transparent background (icons/logos/stickers). Forces a png output."),
      style_reference: z
        .array(z.string())
        .optional()
        .describe("Path(s) to reference image(s) used ONLY for style/brand aesthetics (palette, treatment), not content. Great for on-brand assets."),
      platform: z
        .enum(PLATFORM_IDS as [string, ...string[]])
        .optional()
        .describe("Target platform: picks the native size AND constrains composition to the platform's safe areas (story UI bars, TikTok action rail, OG crop…). Explicit `size` still wins."),
      proof: z
        .boolean()
        .optional()
        .describe("Vision proof-loop: the model proofreads its own render (verbatim text, diacritics, artifacts) and auto-regenerates with feedback up to 3 attempts. Default: ON when style.text is set. Set false to skip, true to force for text-free images."),
      count: z.number().int().min(1).max(10).optional().describe("Produce N INDEPENDENT variations of the same brief (1–10). All paths are returned."),
      series: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Produce N CONSISTENT images (1–10): the first is reused as a style reference for the rest, so a character/brand stays coherent across the set."),
      from_image: z
        .string()
        .optional()
        .describe("Path to a previously-generated image: reload its saved settings (sidecar) as the base, then apply any args here on top to reproduce or tweak it."),
      size: sizeSchema.optional().describe("Default 1024x1024. 1536x1024 = landscape (3:2), 1024x1536 = portrait (2:3), 1024x1280 = 4:5 portrait (Instagram/Facebook feed — renders native 4:5), 1280x1024 = 5:4 landscape. Falls back to the preset's recommended size."),
      quality: qualitySchema.optional(),
      format: formatSchema.optional(),
      background: z.enum(["auto", "transparent", "opaque"]).optional().describe("Alpha handling. 'transparent' forces png."),
      output_path: z.string().optional().describe("Absolute file path (or a directory ending in /) to save to. Defaults to ./generated-images/."),
      backend: backendSchema.optional(),
    },
  },
  async (a) => {
    try {
      if (!a.subject?.trim() && !a.prompt?.trim() && !a.from_image?.trim()) {
        throw new Error("Provide `subject` (with an optional preset), a raw `prompt`, or `from_image`.");
      }
      const out = await generateImage({
        subject: a.subject,
        preset: a.preset,
        modifiers: a.modifiers,
        style: a.style,
        prompt: a.prompt,
        transparent: a.transparent,
        background: a.background,
        styleReference: a.style_reference,
        platform: a.platform,
        proof: a.proof,
        count: a.count,
        series: a.series,
        fromImage: a.from_image,
        size: a.size,
        quality: a.quality,
        format: a.format,
        outputPath: a.output_path,
        backend: a.backend,
      });
      return ok(out, "generated");
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "edit_image",
  {
    title: "Edit / restyle image (image-to-image)",
    description:
      "Transform existing image(s) using the subscription backend (no API cost). Provide one or more " +
      "reference images and either an `instruction` (what to change) and/or a preset/style to restyle. " +
      "Great for variations, restyling, background swaps, adding/removing elements. Output aspect " +
      "matches the first reference unless `size` is set. Saves to disk, returns the path.",
    inputSchema: {
      image_paths: z.array(z.string()).min(1).describe("Absolute path(s) to reference image(s). First is primary; extras are style/context references (up to 16)."),
      instruction: z.string().optional().describe("What to change, e.g. 'replace the background with a sunlit beach'."),
      mask_path: z
        .string()
        .optional()
        .describe("Optional PNG mask (same size as the first image): transparent areas mark the region to regenerate (inpainting)."),
      count: z.number().int().min(1).max(10).optional().describe("Produce N variations (1–10)."),
      preset: z.enum(PRESET_IDS as [string, ...string[]]).optional().describe("Restyle the image into this preset's look."),
      modifiers: z.array(z.enum(MODIFIER_IDS as [string, ...string[]])).optional(),
      style: styleSchema.optional(),
      subject: z.string().optional().describe("Optional: describe the intended subject of the result."),
      proof: z
        .boolean()
        .optional()
        .describe("Vision proof-loop on the edited result (see generate_image.proof). Default: ON when style.text is set."),
      size: sizeSchema.optional(),
      quality: qualitySchema.optional(),
      format: formatSchema.optional(),
      output_path: z.string().optional(),
      backend: backendSchema.optional(),
    },
  },
  async (a) => {
    try {
      const out = await editImage({
        imagePaths: a.image_paths,
        instruction: a.instruction,
        maskPath: a.mask_path,
        count: a.count,
        preset: a.preset,
        modifiers: a.modifiers,
        style: a.style,
        subject: a.subject,
        proof: a.proof,
        size: a.size,
        quality: a.quality,
        format: a.format,
        outputPath: a.output_path,
        backend: a.backend,
      });
      return ok(out, "edited");
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "upscale_image",
  {
    title: "Upscale / enhance image",
    description:
      "Produce a higher-resolution, sharper, cleaner version of an existing image via the subscription " +
      "backend (no API cost), preserving composition/subject/colors. This is a detail-enhancing " +
      "regeneration guided by the source — the model caps output at ~1536px on the long edge, so it's " +
      "ideal for sharpening and cleaning up, not arbitrary 4K. Output aspect matches the source. " +
      "Optionally pass `guidance` (e.g. 'sharpen the text, remove noise'). Saves to disk, returns the path.",
    inputSchema: {
      image_path: z.string().describe("Absolute path to the image to upscale/enhance."),
      guidance: z.string().optional().describe("Extra enhancement guidance, e.g. 'remove JPEG artifacts, sharpen edges'."),
      size: sizeSchema.optional().describe("Target size. Defaults to the largest size matching the source aspect ratio."),
      quality: qualitySchema.optional().describe("Default high."),
      format: formatSchema.optional().describe("Default png."),
      output_path: z.string().optional(),
      backend: backendSchema.optional(),
    },
  },
  async (a) => {
    try {
      const out = await upscaleImage({
        imagePath: a.image_path,
        guidance: a.guidance,
        size: a.size,
        quality: a.quality,
        format: a.format,
        outputPath: a.output_path,
        backend: a.backend,
      });
      return ok(out, "upscaled");
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "export_web_assets",
  {
    title: "Export web-ready asset set (favicons, OG, hero, app icons)",
    description:
      "Slice ONE image into the exact production deliverables a site needs — correctly sized and " +
      "cropped, dropped into a folder. kinds: 'favicon' (16-512 PNGs + favicon.ico), 'og' " +
      "(1200x630 / 1080x1080 / 1600x900 social cards), 'hero' (responsive widths), 'appicon' " +
      "(iOS/Android/PWA sizes). Provide an existing `image_path`, OR generate the source inline by " +
      "passing `subject` (+ optional preset/transparent). PNG output is dependency-free; jpeg/webp " +
      "for og/hero need `sharp` installed (falls back to PNG otherwise).",
    inputSchema: {
      kind: z.enum(["favicon", "og", "hero", "appicon"]).describe("Which deliverable set to produce."),
      image_path: z.string().optional().describe("Existing source image to slice. Omit to generate one from `subject`."),
      subject: z.string().optional().describe("If no image_path: what to depict for the generated source."),
      preset: z.enum(PRESET_IDS as [string, ...string[]]).optional().describe("Preset for the generated source (e.g. logo-mark for favicons, hero-banner for hero)."),
      transparent: z.boolean().optional().describe("Generate the source on a transparent background (recommended for favicon/appicon)."),
      out_dir: z.string().optional().describe("Output directory. Defaults to a ./web folder next to the source."),
      base_name: z.string().optional().describe("Base filename for the assets (default = kind)."),
      format: z.enum(["png", "jpeg", "webp"]).optional().describe("Preferred format for og/hero (icons are always png)."),
    },
  },
  async (a) => {
    try {
      let sourcePath = a.image_path;
      let genNote = "";
      if (!sourcePath) {
        if (!a.subject?.trim()) throw new Error("Provide either `image_path` or `subject` to generate the source.");
        const gen = await generateImage({
          subject: a.subject,
          preset: a.preset,
          transparent: a.transparent ?? (a.kind === "favicon" || a.kind === "appicon"),
          size: a.kind === "og" ? "1536x1024" : a.kind === "hero" ? "2048x1152" : "1024x1024",
        });
        sourcePath = gen.path;
        genNote = `Generated source: ${gen.path}\n`;
      }
      const res = await exportWebAssets({
        sourcePath,
        kind: a.kind,
        outDir: a.out_dir,
        baseName: a.base_name,
        format: a.format,
      });
      const list = res.files.map((f) => `  ${f.path}  (${f.width}x${f.height} ${f.format})`).join("\n");
      const text =
        `${genNote}Exported ${res.files.length} ${res.kind} asset(s) to ${res.outDir}:\n${list}` +
        (res.notes.length ? `\n\nNotes: ${res.notes.join(" ")}` : "");
      return { content: [{ type: "text", text }] } as any;
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "remove_background",
  {
    title: "Remove image background (cutout → transparent PNG)",
    description:
      "Cut out the background of ANY image and save a transparent PNG. The default local keyer " +
      "samples the corner color and flood-fills from the edges — fast, free, best on clean/solid " +
      "backgrounds. For busy/photographic backgrounds set `use_model: true`: the model re-renders " +
      "the subject on a chroma field (one subscription generation) and the keyer cuts that — real " +
      "matting quality at zero API cost. PNG input is dependency-free; jpeg/webp input needs `sharp`.",
    inputSchema: {
      image_path: z.string().describe("Image to cut out."),
      output_path: z.string().optional().describe("Where to save (default: <image>-cutout.png)."),
      tolerance: z.number().int().min(0).max(180).optional().describe("Local keyer only: color tolerance vs the sampled background (default 28). Raise for soft/anti-aliased edges."),
      use_model: z
        .boolean()
        .optional()
        .describe("Busy/photographic background: re-render the subject on a chroma field via the model, then key. Slower (one generation) but works where the local keyer can't."),
    },
  },
  async (a) => {
    try {
      const out = a.output_path ?? cutoutPath(a.image_path);
      if (a.use_model) {
        const res = await editImage({
          imagePaths: [a.image_path],
          instruction:
            "Reproduce ONLY the main subject of this image, pixel-faithful — identical shape, colors, " +
            "materials, texture, pose and fine detail; do not restyle or simplify it",
          transparent: true,
          format: "png",
          outputPath: out,
          proof: false,
        });
        return ok(res, "cut out (model-assisted)");
      }
      await removeBackgroundFile(a.image_path, out, a.tolerance != null ? { tolerance: a.tolerance } : undefined);
      return { content: [{ type: "text", text: `Background removed → ${out} (transparent PNG).` }] } as any;
    } catch (e) {
      return fail(e);
    }
  },
);

const positionSchema = z.enum([
  "top-left",
  "top-center",
  "top-right",
  "center-left",
  "center",
  "center-right",
  "bottom-left",
  "bottom-center",
  "bottom-right",
]);

server.registerTool(
  "compose_overlay",
  {
    title: "Composite exact text / real logo onto an image (deterministic, no AI)",
    description:
      "Set type and place a logo onto an existing image DETERMINISTICALLY — real installed fonts, " +
      "exact spelling and brand hex by construction, the real logo asset (never model-drawn). " +
      "This is the premium social workflow: generate a text-free plate (preset social-bg-plate or " +
      "concept-hero), then set the headline here. Needs `sharp` for text rasterization. " +
      "Pass `platform` to keep overlays inside its UI safe areas.",
    inputSchema: {
      image_path: z.string().describe("The plate/background image to composite onto."),
      blocks: z
        .array(
          z.object({
            text: z.string().describe("Literal copy — rendered exactly as given."),
            position: positionSchema.optional().describe("Default: first block center, later blocks bottom-center."),
            font_family: z.string().optional().describe("Installed font family, e.g. 'Inter', 'Playfair Display'. Falls back to system sans."),
            font_size: z.number().int().optional().describe("Px. Default: canvasWidth/9 for the first block, /22 after."),
            font_weight: z.union([z.number(), z.string()]).optional().describe("Default 700."),
            color: z.string().optional().describe("CSS color / hex. Default #111111."),
            accent_word: z.string().optional().describe("One word/phrase inside `text` to ink in accent_color (the editorial accent)."),
            accent_color: z.string().optional().describe("Hex for the accent word."),
            scrim: z.boolean().optional().describe("Legibility scrim behind the block. Omit = auto (added when measured contrast < 2.5:1)."),
            letter_spacing: z.number().optional().describe("Extra px between glyphs (e.g. 2 for airy caps)."),
            line_height: z.number().optional().describe("Multiple of font size. Default 1.12."),
            max_width_ratio: z.number().optional().describe("Wrap width as a fraction of canvas width. Default 0.86."),
            uppercase: z.boolean().optional(),
          }),
        )
        .optional()
        .describe("Text blocks to set. Spelling is exact by construction — no proofing needed."),
      logo: z
        .object({
          path: z.string().describe("The REAL logo asset (png; svg not supported here)."),
          position: positionSchema.optional().describe("Default bottom-center."),
          width_ratio: z.number().optional().describe("Logo width as a fraction of canvas width. Default 0.14."),
          opacity: z.number().min(0).max(1).optional(),
        })
        .optional(),
      platform: z
        .enum(PLATFORM_IDS as [string, ...string[]])
        .optional()
        .describe("Keep overlays inside this platform's UI safe areas."),
      output_path: z.string().optional().describe("Default: <image>-final.png."),
      format: z.enum(["png", "jpeg", "webp"]).optional(),
    },
  },
  async (a) => {
    try {
      const res = await composeOverlay({
        imagePath: a.image_path,
        blocks: a.blocks?.map((b) => ({
          text: b.text,
          position: b.position,
          fontFamily: b.font_family,
          fontSize: b.font_size,
          fontWeight: b.font_weight,
          color: b.color,
          accentWord: b.accent_word,
          accentColor: b.accent_color,
          scrim: b.scrim,
          letterSpacing: b.letter_spacing,
          lineHeight: b.line_height,
          maxWidthRatio: b.max_width_ratio,
          uppercase: b.uppercase,
        })),
        logo: a.logo
          ? { path: a.logo.path, position: a.logo.position, widthRatio: a.logo.width_ratio, opacity: a.logo.opacity }
          : undefined,
        platform: a.platform,
        outputPath: a.output_path,
        format: a.format,
      });
      const text =
        `Overlay composited → ${res.path} (${res.width}x${res.height})` +
        (res.notes.length ? `\n${res.notes.map((n) => `• ${n}`).join("\n")}` : "");
      return { content: [{ type: "text", text }] } as any;
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "create_social_card",
  {
    title: "Create a premium social card in one call (plate + exact type + logo)",
    description:
      "The complete premium social workflow in ONE call: generates a TEXT-FREE plate with the model " +
      "(art steered away from where the type goes), then sets the headline/subline/logo " +
      "DETERMINISTICALLY with real fonts — spelling, diacritics and the logo are exact by " +
      "construction, no proofing needed. Use instead of generate_image + style.text whenever the " +
      "copy must be exact (long copy, diacritics, brand fonts). Needs `sharp`.",
    inputSchema: {
      headline: z.string().describe("The headline copy — set verbatim."),
      accent_word: z.string().optional().describe("One word/phrase of the headline inked in the accent color."),
      accent_color: z.string().optional().describe("Accent hex. Default: dominant brand color from style refs, else wine #8b0f24."),
      subline: z.string().optional(),
      headline_position: positionSchema.optional().describe("Default top-left; the plate's art goes to the opposite zone."),
      headline_font: z.string().optional().describe("Installed font family for the headline."),
      subline_font: z.string().optional(),
      headline_color: z.string().optional().describe("Default near-black #1c1917."),
      subline_color: z.string().optional().describe("Default = accent color."),
      uppercase: z.boolean().optional().describe("Uppercase the headline (default true)."),
      logo: z
        .object({
          path: z.string(),
          position: positionSchema.optional().describe("Default bottom-center."),
          width_ratio: z.number().optional(),
          opacity: z.number().min(0).max(1).optional(),
        })
        .optional()
        .describe("The real logo asset to place."),
      platform: z.enum(PLATFORM_IDS as [string, ...string[]]).optional().describe("Default instagram-feed."),
      plate_subject: z.string().optional().describe("What the plate depicts. Default: a quiet premium material study."),
      plate_preset: z
        .enum(PRESET_IDS as [string, ...string[]])
        .optional()
        .describe("Plate preset. Default social-bg-plate; use concept-hero for a photographic hero object."),
      style_reference: z.array(z.string()).optional().describe("Brand reference image(s) — anchors plate style AND auto-extracts the palette."),
      quality: qualitySchema.optional().describe("Plate quality (default high)."),
      output_path: z.string().optional(),
      backend: backendSchema.optional(),
    },
  },
  async (a) => {
    try {
      const res = await createSocialCard({
        headline: a.headline,
        accentWord: a.accent_word,
        accentColor: a.accent_color,
        subline: a.subline,
        headlinePosition: a.headline_position,
        headlineFont: a.headline_font,
        sublineFont: a.subline_font,
        headlineColor: a.headline_color,
        sublineColor: a.subline_color,
        uppercase: a.uppercase,
        logo: a.logo ? { path: a.logo.path, position: a.logo.position, widthRatio: a.logo.width_ratio, opacity: a.logo.opacity } : undefined,
        platform: a.platform,
        plateSubject: a.plate_subject,
        platePreset: a.plate_preset,
        styleReference: a.style_reference,
        quality: a.quality,
        outputPath: a.output_path,
        backend: a.backend,
      });
      const text =
        `Social card created → ${res.path} (${res.width}x${res.height})\n` +
        `Plate (text-free, reusable): ${res.platePath}` +
        (res.palette?.length ? `\nBrand palette: ${res.palette.join(", ")}` : "") +
        (res.notes.length ? `\n${res.notes.map((n) => `• ${n}`).join("\n")}` : "") +
        `\nText is exact by construction — no proofread needed. Check kerning/wrap visually before publishing.`;
      return { content: [{ type: "text", text }] } as any;
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_image_presets",
  {
    title: "List image presets & modifiers",
    description:
      "Return the catalog of style presets (id, title, description, recommended settings, tunable " +
      "dimensions) and composable modifiers. Call this before generate_image to pick the right preset. " +
      "Optionally filter by category.",
    inputSchema: {
      category: z
        .enum(["photography", "illustration", "design", "render3d", "specialized", "webdev", "social"])
        .optional()
        .describe("Filter presets to one category (webdev = hero 3D / icons / mockups / gradients for web & app dev; social = premium social-media cards & plates)."),
    },
  },
  async (a) => {
    const cat = catalog(a.category);
    const withPlatforms = { ...cat, platforms: PLATFORMS.map(({ id, title, size, note }) => ({ id, title, size, note })) };
    return { content: [{ type: "text", text: JSON.stringify(withPlatforms, null, 2) }] } as any;
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[gpt-image] MCP server ready on stdio — ${PRESET_IDS.length} presets, ${MODIFIER_IDS.length} modifiers`);
