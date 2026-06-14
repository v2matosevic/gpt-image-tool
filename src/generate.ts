// Core operations: text-to-image (generate), image-to-image (edit), and detail-enhancing
// regeneration (upscale). Each composes a prompt via the preset engine, runs a backend, saves the
// image to disk, and returns a path-first result (the only return shape that works across agents).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { getProvider } from "./providers/index.js";
import type { GenerateInput, ImageBackground, ImageFormat, ImageProvider, ImageQuality, ImageSize, InputImage } from "./providers/types.js";
import { build, type PromptOverrides } from "./presets/index.js";
import { imageSize, sizeForAspect, upscaleSizeForAspect } from "./imageinfo.js";
import { removeBackground } from "./bgremove.js";

export interface StyleInput {
  subject?: string;
  prompt?: string; // raw prompt — full manual control, bypasses preset composition
  preset?: string;
  modifiers?: string[];
  style?: PromptOverrides; // per-dimension overrides + avoid[] + text
  size?: ImageSize;
  quality?: ImageQuality;
  format?: ImageFormat;
  background?: ImageBackground;
  /** Convenience for background:"transparent" (forces a png/webp output). */
  transparent?: boolean;
  /** Reference image path(s) used ONLY for style/aesthetic, not content (brand matching). */
  styleReference?: string[];
  /** Produce N variations of the same brief (1–10). Returned in `variants`. */
  count?: number;
  outputPath?: string;
  backend?: string;
}

export interface GenerateOutput {
  path: string;
  bytes: number;
  format: ImageFormat;
  background: ImageBackground;
  backend: string;
  prompt: string;
  preset?: string;
  modifiers: string[];
  revisedPrompt?: string;
  base64: string;
  /** Extra output paths when count > 1 (the primary is `path`). */
  variants?: string[];
}

function defaultOutputDir(): string {
  if (process.env.GPT_IMAGE_OUTPUT_DIR?.trim()) return process.env.GPT_IMAGE_OUTPUT_DIR;
  if (process.env.CLAUDE_PROJECT_DIR?.trim()) return join(process.env.CLAUDE_PROJECT_DIR, "generated-images");
  return join(process.cwd(), "generated-images");
}

function ext(format: ImageFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

function timestampName(format: ImageFormat, prefix = "img"): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${ts}.${ext(format)}`;
}

function resolveOutputPath(outputPath: string | undefined, format: ImageFormat, prefix = "img"): string {
  if (!outputPath) return join(defaultOutputDir(), timestampName(format, prefix));
  const abs = isAbsolute(outputPath) ? outputPath : resolve(process.cwd(), outputPath);
  if (/[\\/]$/.test(outputPath)) return join(abs, timestampName(format, prefix));
  return abs;
}

function mimeForPath(p: string): string {
  const e = extname(p).toLowerCase();
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".webp") return "image/webp";
  if (e === ".gif") return "image/gif";
  return "image/png";
}

async function readInputImage(path: string): Promise<{ image: InputImage; dim: ReturnType<typeof imageSize> }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new Error(`Reference image not found or unreadable: ${path}`);
  }
  if (bytes.length === 0) throw new Error(`Reference image is empty: ${path}`);
  return { image: { bytes, mime: mimeForPath(path) }, dim: imageSize(bytes) };
}

/** Call the provider, retrying once if the model replied with text instead of an image. */
async function generateWithRetry(provider: ImageProvider, input: GenerateInput) {
  try {
    return await provider.generate(input);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no image|returned no image/i.test(msg)) {
      const forced: GenerateInput = {
        ...input,
        prompt:
          input.prompt +
          " IMPORTANT: respond ONLY by calling the image_generation tool to produce the image — do not reply with any text.",
      };
      return provider.generate(forced);
    }
    throw e;
  }
}

/** Insert a "-N" suffix before the extension (for variation filenames). */
function indexedPath(p: string, i: number): string {
  const e = extname(p);
  return `${p.slice(0, p.length - e.length)}-${i}${e}`;
}

/** Run a backend, persist the bytes, return the path-first result. */
async function runAndSave(
  input: GenerateInput,
  outputPath: string | undefined,
  backend: string | undefined,
  prefix: string,
  meta: { prompt: string; preset?: string; modifiers: string[]; count?: number; transform?: (b: Buffer) => Buffer },
): Promise<GenerateOutput> {
  const provider = getProvider(backend);
  const count = Math.max(1, Math.min(10, meta.count ?? 1));
  const basePath = resolveOutputPath(outputPath, input.format, prefix);
  await mkdir(dirname(basePath), { recursive: true });

  const saved: { path: string; result: Awaited<ReturnType<ImageProvider["generate"]>> }[] = [];
  for (let i = 0; i < count; i++) {
    const result = await generateWithRetry(provider, input);
    if (meta.transform) result.bytes = meta.transform(result.bytes);
    const outPath = count > 1 ? indexedPath(basePath, i + 1) : basePath;
    await writeFile(outPath, result.bytes);
    saved.push({ path: outPath, result });
  }

  const primary = saved[0]!;
  return {
    path: primary.path,
    bytes: primary.result.bytes.length,
    format: primary.result.format,
    background: input.background ?? "auto",
    backend: provider.name,
    prompt: meta.prompt,
    preset: meta.preset,
    modifiers: meta.modifiers,
    revisedPrompt: primary.result.revisedPrompt,
    base64: primary.result.bytes.toString("base64"),
    variants: saved.length > 1 ? saved.slice(1).map((s) => s.path) : undefined,
  };
}

const STYLE_REF_PREFIX =
  "Use the attached image(s) ONLY as a style and aesthetic reference — match their visual style, " +
  "color palette, lighting, and treatment — but depict the subject described below, not the reference's content. ";

// Injected when we need transparency on a backend that can't emit it natively (subscription): the
// model renders on a flat chroma background we then key out locally.
const CHROMA_HEX = "#00B140"; // broadcast chroma-green: rarely present in real subjects
const CHROMA_RGB = { r: 0x00, g: 0xb1, b: 0x40 };
const CHROMA_PROMPT =
  ` Render the subject fully isolated and centered on a completely solid, uniform chroma-key green` +
  ` (${CHROMA_HEX}) background — no shadows, no gradient, no reflections, no other elements, and do` +
  ` not use that green anywhere in the subject itself.`;

function resolveBackendName(backend: string | undefined): string {
  return (backend || process.env.GPT_IMAGE_BACKEND || "subscription").toLowerCase();
}

/** Text-to-image. Compose from subject + preset (+ modifiers + style overrides), or a raw prompt. */
export async function generateImage(opts: StyleInput): Promise<GenerateOutput> {
  const composed = build({
    subject: opts.subject,
    rawPrompt: opts.prompt,
    preset: opts.preset,
    modifiers: opts.modifiers,
    overrides: opts.style,
    size: opts.size,
    quality: opts.quality,
    format: opts.format,
    background: opts.transparent ? "transparent" : opts.background,
  });

  const wantTransparent = composed.background === "transparent";
  const backendName = resolveBackendName(opts.backend);
  // apikey supports native transparency; subscription does not, so render-on-chroma + key it out.
  const nativeTransparent = wantTransparent && backendName === "apikey";
  const chromaTransparent = wantTransparent && backendName !== "apikey";

  let inputImages: InputImage[] | undefined;
  let prompt = composed.prompt;
  if (chromaTransparent) prompt += CHROMA_PROMPT;
  if (opts.styleReference?.length) {
    inputImages = (await Promise.all(opts.styleReference.map(readInputImage))).map((l) => l.image);
    prompt = STYLE_REF_PREFIX + prompt;
  }

  const input: GenerateInput = {
    prompt,
    size: composed.size,
    quality: composed.quality,
    format: wantTransparent ? "png" : composed.format, // alpha needs png
    background: nativeTransparent ? "transparent" : "auto",
    inputImages,
  };
  return runAndSave(input, opts.outputPath, opts.backend, "img", {
    prompt,
    preset: composed.presetId,
    modifiers: composed.modifierIds,
    count: opts.count,
    transform: chromaTransparent ? (b) => removeBackground(b, { keyColor: CHROMA_RGB, tolerance: 70 }) : undefined,
  });
}

export interface EditInput extends StyleInput {
  /** One or more reference images. The first is the primary; extras are style/context references. */
  imagePaths: string[];
  /** What to change. Becomes the core directive; preset/style add styling guidance on top. */
  instruction?: string;
  /** Optional mask (PNG with alpha): transparent areas mark the region to regenerate (inpainting). */
  maskPath?: string;
}

// Restating invariants every edit fights gpt-image's tendency to drift across regenerations.
const EDIT_PRESERVE = " Change only what is described; keep all other elements, composition, framing, lighting, and style identical to the reference.";

/** Image-to-image edit / variation / restyle, guided by reference image(s). */
export async function editImage(opts: EditInput): Promise<GenerateOutput> {
  if (!opts.imagePaths?.length) throw new Error("editImage requires at least one imagePath.");
  const loaded = await Promise.all(opts.imagePaths.map(readInputImage));
  const inputImages = loaded.map((l) => l.image);
  const maskImage = opts.maskPath ? (await readInputImage(opts.maskPath)).image : undefined;

  const hasStyle = Boolean(opts.preset || opts.subject || opts.modifiers?.length || opts.style);
  const instruction = opts.instruction?.trim();
  if (!instruction && !hasStyle) {
    throw new Error("editImage requires `instruction` (what to change) or a preset/subject/style.");
  }

  // If a style is requested, compose it; otherwise the instruction alone drives the edit.
  const composed = build({
    subject: opts.subject ?? "the result",
    rawPrompt: hasStyle ? undefined : instruction,
    preset: opts.preset,
    modifiers: opts.modifiers,
    overrides: opts.style,
    size: opts.size ?? sizeForAspect(loaded[0]!.dim),
    quality: opts.quality,
    format: opts.format,
  });

  let prompt = composed.prompt;
  if (instruction && hasStyle) prompt = `${instruction}. Apply this to the reference image. ${composed.prompt}`;
  else if (instruction) prompt = instruction + EDIT_PRESERVE;

  const input: GenerateInput = {
    prompt,
    size: composed.size,
    quality: composed.quality,
    format: composed.format,
    background: composed.background,
    inputImages,
    maskImage,
  };
  return runAndSave(input, opts.outputPath, opts.backend, "edit", {
    prompt,
    preset: composed.presetId,
    modifiers: composed.modifierIds,
    count: opts.count,
  });
}

export interface UpscaleInput {
  imagePath: string;
  /** Optional extra guidance (e.g. "sharpen the text", "remove JPEG artifacts"). */
  guidance?: string;
  size?: ImageSize;
  quality?: ImageQuality;
  format?: ImageFormat;
  outputPath?: string;
  backend?: string;
}

const UPSCALE_PROMPT =
  "Recreate this exact image at a higher resolution with sharper, cleaner detail. " +
  "Preserve the composition, subject, proportions, colors and style precisely — do not add, remove, " +
  "or rearrange any elements. Enhance fine detail and texture, and remove compression artifacts, " +
  "blur and noise. Keep it faithful to the original.";

/** Detail-enhancing regeneration ("upscale") guided by the source image, targeting the 2K tier. */
export async function upscaleImage(opts: UpscaleInput): Promise<GenerateOutput> {
  if (!opts.imagePath) throw new Error("upscaleImage requires an imagePath.");
  const { image, dim } = await readInputImage(opts.imagePath);
  const prompt = opts.guidance?.trim() ? `${UPSCALE_PROMPT} ${opts.guidance.trim()}` : UPSCALE_PROMPT;
  const input: GenerateInput = {
    prompt,
    size: opts.size ?? upscaleSizeForAspect(dim),
    quality: opts.quality ?? "high",
    format: opts.format ?? "png",
    inputImages: [image],
  };
  const prefix = `${basename(opts.imagePath, extname(opts.imagePath))}-upscaled`;
  return runAndSave(input, opts.outputPath, opts.backend, prefix, { prompt, modifiers: [] });
}
