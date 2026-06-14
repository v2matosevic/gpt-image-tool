// Core: pick a backend, generate, save the image to disk, and return a path-first result.
// Saving to disk + returning the absolute path is the only return shape that works across every
// agent (Codex can't see inline image blocks; it opens the path with `view_image`).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getProvider } from "./providers/index.js";
import type { GenerateInput, ImageFormat, ImageQuality, ImageSize } from "./providers/types.js";

export interface GenerateOptions {
  prompt: string;
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

function timestampName(format: ImageFormat): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `img-${ts}.${ext(format)}`;
}

function resolveOutputPath(outputPath: string | undefined, format: ImageFormat): string {
  if (!outputPath) return join(defaultOutputDir(), timestampName(format));
  const abs = isAbsolute(outputPath) ? outputPath : resolve(process.cwd(), outputPath);
  // Treat a trailing-separator path as a directory to drop a timestamped file into.
  if (/[\\/]$/.test(outputPath)) return join(abs, timestampName(format));
  return abs;
}

export async function generateImage(opts: GenerateOptions): Promise<GenerateOutput> {
  const input: GenerateInput = {
    prompt: opts.prompt,
    size: opts.size ?? "1024x1024",
    quality: opts.quality ?? "auto",
    format: opts.format ?? "png",
  };
  if (!input.prompt.trim()) throw new Error("prompt is required.");

  const provider = getProvider(opts.backend);
  const result = await provider.generate(input);

  const outPath = resolveOutputPath(opts.outputPath, result.format);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, result.bytes);

  return {
    path: outPath,
    bytes: result.bytes.length,
    format: result.format,
    backend: provider.name,
    revisedPrompt: result.revisedPrompt,
    base64: result.bytes.toString("base64"),
  };
}
