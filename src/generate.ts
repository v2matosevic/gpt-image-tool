// Core operations: text-to-image (generate), image-to-image (edit), and detail-enhancing
// regeneration (upscale). Each composes a prompt via the preset engine, runs a backend, saves the
// image to disk, and returns a path-first result (the only return shape that works across agents).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { getProvider } from "./providers/index.js";
import type { GenerateInput, ImageFormat, ImageQuality, ImageSize, InputImage } from "./providers/types.js";
import { build, type PromptOverrides } from "./presets/index.js";
import { imageSize, sizeForAspect } from "./imageinfo.js";

export interface StyleInput {
  subject?: string;
  prompt?: string; // raw prompt — full manual control, bypasses preset composition
  preset?: string;
  modifiers?: string[];
  style?: PromptOverrides; // per-dimension overrides + avoid[] + text
  size?: ImageSize;
  quality?: ImageQuality;
  format?: ImageFormat;
  outputPath?: string;
  backend?: string;
}

export interface GenerateOutput {
  path: string;
  bytes: number;
  format: ImageFormat;
  backend: string;
  prompt: string;
  preset?: string;
  modifiers: string[];
  revisedPrompt?: string;
  base64: string;
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

/** Run a backend, persist the bytes, return the path-first result. */
async function runAndSave(
  input: GenerateInput,
  outputPath: string | undefined,
  backend: string | undefined,
  prefix: string,
  meta: { prompt: string; preset?: string; modifiers: string[] },
): Promise<GenerateOutput> {
  const provider = getProvider(backend);
  const result = await provider.generate(input);
  const outPath = resolveOutputPath(outputPath, result.format, prefix);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, result.bytes);
  return {
    path: outPath,
    bytes: result.bytes.length,
    format: result.format,
    backend: provider.name,
    prompt: meta.prompt,
    preset: meta.preset,
    modifiers: meta.modifiers,
    revisedPrompt: result.revisedPrompt,
    base64: result.bytes.toString("base64"),
  };
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
  });
  const input: GenerateInput = {
    prompt: composed.prompt,
    size: composed.size,
    quality: composed.quality,
    format: composed.format,
  };
  return runAndSave(input, opts.outputPath, opts.backend, "img", {
    prompt: composed.prompt,
    preset: composed.presetId,
    modifiers: composed.modifierIds,
  });
}

export interface EditInput extends StyleInput {
  /** One or more reference images. The first is the primary; extras are style/context references. */
  imagePaths: string[];
  /** What to change. Becomes the core directive; preset/style add styling guidance on top. */
  instruction?: string;
}

/** Image-to-image edit / variation / restyle, guided by reference image(s). */
export async function editImage(opts: EditInput): Promise<GenerateOutput> {
  if (!opts.imagePaths?.length) throw new Error("editImage requires at least one imagePath.");
  const loaded = await Promise.all(opts.imagePaths.map(readInputImage));
  const inputImages = loaded.map((l) => l.image);

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
  else if (instruction) prompt = instruction;

  const input: GenerateInput = {
    prompt,
    size: composed.size,
    quality: composed.quality,
    format: composed.format,
    inputImages,
  };
  return runAndSave(input, opts.outputPath, opts.backend, "edit", {
    prompt,
    preset: composed.presetId,
    modifiers: composed.modifierIds,
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

/** Detail-enhancing regeneration ("upscale") guided by the source image. Caps at the model's max (~1536px). */
export async function upscaleImage(opts: UpscaleInput): Promise<GenerateOutput> {
  if (!opts.imagePath) throw new Error("upscaleImage requires an imagePath.");
  const { image, dim } = await readInputImage(opts.imagePath);
  const prompt = opts.guidance?.trim() ? `${UPSCALE_PROMPT} ${opts.guidance.trim()}` : UPSCALE_PROMPT;
  const input: GenerateInput = {
    prompt,
    size: opts.size ?? sizeForAspect(dim),
    quality: opts.quality ?? "high",
    format: opts.format ?? "png",
    inputImages: [image],
  };
  const prefix = `${basename(opts.imagePath, extname(opts.imagePath))}-upscaled`;
  return runAndSave(input, opts.outputPath, opts.backend, prefix, { prompt, modifiers: [] });
}
