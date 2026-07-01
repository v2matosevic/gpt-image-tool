// MCP stdio server. Exposes four tools any MCP client (Claude Code, Codex, Cursor, …) can call:
//   generate_image      text-to-image, driven by a curated preset library + prompt compiler
//   edit_image          image-to-image edit / restyle / variation from reference image(s)
//   upscale_image       detail-enhancing regeneration of an existing image (up to ~1536px)
//   list_image_presets  the catalog of presets + modifiers so the agent can choose well
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

function ok(out: GenerateOutput, verb: string) {
  const allPaths = [out.path, ...(out.variants ?? [])];
  const pathLine = allPaths.length > 1 ? `${allPaths.length} images saved to:\n${allPaths.join("\n")}` : `saved to:\n${out.path}`;
  const text =
    `Image ${verb} via the ${out.backend} backend and ${pathLine}\n\n` +
    `Open/view to see (${out.bytes} bytes, ${out.format}${out.background === "transparent" ? ", transparent" : ""}).` +
    (out.preset ? `\nPreset: ${out.preset}${out.modifiers.length ? ` + [${out.modifiers.join(", ")}]` : ""}` : "") +
    `\nCompiled prompt: ${out.prompt}` +
    (out.revisedPrompt ? `\nModel-revised prompt: ${out.revisedPrompt}` : "");
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
      "Cut out the background of ANY image and save a transparent PNG. Works best on a clean/solid " +
      "background — it samples the corner color and flood-fills from the edges (a keyer, not AI " +
      "matting), so busy/photographic backgrounds won't cut cleanly. PNG input is dependency-free; " +
      "jpeg/webp input needs `sharp` installed.",
    inputSchema: {
      image_path: z.string().describe("Image to cut out."),
      output_path: z.string().optional().describe("Where to save (default: <image>-cutout.png)."),
      tolerance: z.number().int().min(0).max(180).optional().describe("Color tolerance vs the sampled background (default 28). Raise for soft/anti-aliased edges."),
    },
  },
  async (a) => {
    try {
      const out = a.output_path ?? cutoutPath(a.image_path);
      await removeBackgroundFile(a.image_path, out, a.tolerance != null ? { tolerance: a.tolerance } : undefined);
      return { content: [{ type: "text", text: `Background removed → ${out} (transparent PNG).` }] } as any;
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
        .enum(["photography", "illustration", "design", "render3d", "specialized", "webdev"])
        .optional()
        .describe("Filter presets to one category (webdev = hero 3D / icons / mockups / gradients for web & app dev)."),
    },
  },
  async (a) => {
    const cat = catalog(a.category);
    return { content: [{ type: "text", text: JSON.stringify(cat, null, 2) }] } as any;
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[gpt-image] MCP server ready on stdio — ${PRESET_IDS.length} presets, ${MODIFIER_IDS.length} modifiers`);
