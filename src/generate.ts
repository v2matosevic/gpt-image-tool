// Core operations: text-to-image (generate), image-to-image (edit), and detail-enhancing
// regeneration (upscale). Each composes a prompt via the preset engine, runs a backend, saves the
// image to disk, and returns a path-first result (the only return shape that works across agents).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { getProvider } from "./providers/index.js";
import type { GenerateInput, ImageBackground, ImageFormat, ImageProvider, ImageQuality, ImageSize, InputImage } from "./providers/types.js";
import { build, type PromptOverrides } from "./presets/index.js";
import { imageSize, sizeForAspect, upscaleSizeForAspect } from "./imageinfo.js";
import { removeBackground } from "./bgremove.js";
import { loadProfile, type BrandProfile } from "./profile.js";

const SIDECARS = process.env.GPT_IMAGE_NO_SIDECAR !== "1";

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.map((s) => s.trim()).filter(Boolean))];
}

/** Merge two style-override sets: top dims win per-key, avoid lists concatenate, text prefers top. */
export function mergeStyle(base?: PromptOverrides, top?: PromptOverrides): PromptOverrides | undefined {
  if (!base && !top) return undefined;
  const out: PromptOverrides = { ...(base ?? {}), ...(top ?? {}) };
  const avoid = dedupe([...(base?.avoid ?? []), ...(top?.avoid ?? [])]);
  if (avoid.length) out.avoid = avoid;
  else delete out.avoid;
  if (top?.text ?? base?.text) out.text = top?.text ?? base?.text;
  return out;
}

/**
 * Overlay explicit call options on top of a base layer (project profile or a `--from` sidecar).
 * `top` (the per-call args) always wins; modifiers and avoid lists are merged, not replaced.
 */
export function overlay(base: StyleInput, top: StyleInput): StyleInput {
  return {
    subject: top.subject ?? base.subject,
    prompt: top.prompt ?? base.prompt,
    preset: top.preset ?? base.preset,
    modifiers: dedupe([...(base.modifiers ?? []), ...(top.modifiers ?? [])]),
    style: mergeStyle(base.style, top.style),
    transparent: top.transparent ?? base.transparent,
    background: top.background ?? base.background,
    styleReference: top.styleReference ?? base.styleReference,
    size: top.size ?? base.size,
    quality: top.quality ?? base.quality,
    format: top.format ?? base.format,
    count: top.count ?? base.count,
    series: top.series ?? base.series,
    outputPath: top.outputPath ?? base.outputPath,
    backend: top.backend ?? base.backend,
  };
}

function profileAsBase(p: BrandProfile, baseDir: string): StyleInput {
  const rel = (x: string) => (isAbsolute(x) ? x : resolve(baseDir, x));
  const dir = p.outputDir ? rel(p.outputDir) : undefined;
  return {
    preset: p.preset,
    modifiers: p.modifiers,
    style: p.style,
    styleReference: p.styleReference?.map(rel),
    size: p.size,
    quality: p.quality,
    format: p.format,
    background: p.background,
    backend: p.backend,
    // A directory default — trailing sep makes resolveOutputPath drop a timestamped file in it.
    outputPath: dir ? (dir.endsWith(sep) ? dir : dir + sep) : undefined,
  };
}

interface Sidecar {
  tool: string;
  operation: "generate" | "edit" | "upscale";
  subject?: string;
  prompt?: string;
  preset?: string;
  modifiers?: string[];
  style?: PromptOverrides;
  size?: ImageSize;
  quality?: ImageQuality;
  format?: ImageFormat;
  background?: ImageBackground;
  backend?: string;
  compiledPrompt: string;
  revisedPrompt?: string;
  styleReference?: string[];
  inputImages?: string[];
  maskPath?: string;
}

interface SaveMeta {
  prompt: string;
  preset?: string;
  modifiers: string[];
  count?: number;
  transform?: (b: Buffer) => Buffer;
  operation: Sidecar["operation"];
  opts: StyleInput;
  refs?: string[];
  mask?: string;
}

function sidecarFromOpts(op: Sidecar["operation"], opts: StyleInput, meta: SaveMeta): Sidecar {
  return {
    tool: "gpt-image-tool",
    operation: op,
    subject: opts.subject,
    prompt: opts.prompt,
    preset: meta.preset,
    modifiers: meta.modifiers,
    style: opts.style,
    size: opts.size,
    quality: opts.quality,
    format: opts.format,
    background: opts.background ?? (opts.transparent ? "transparent" : undefined),
    backend: opts.backend,
    compiledPrompt: meta.prompt,
    styleReference: opts.styleReference,
  };
}

/** Reconstruct call options from a previously-written sidecar (for `--from`). */
async function sidecarAsBase(imagePath: string): Promise<StyleInput> {
  let raw: string;
  try {
    raw = await readFile(`${imagePath}.json`, "utf8");
  } catch {
    throw new Error(`No sidecar found for ${imagePath} (expected ${basename(imagePath)}.json). Can't --from this image.`);
  }
  const s = JSON.parse(raw) as Sidecar;
  return {
    subject: s.subject,
    prompt: s.prompt,
    preset: s.preset,
    modifiers: s.modifiers,
    style: s.style,
    size: s.size,
    quality: s.quality,
    format: s.format,
    background: s.background,
    styleReference: s.styleReference,
    backend: s.backend,
  };
}

/**
 * Apply the base layer beneath the explicit call args. `--from` reproduces a prior image (full
 * sidecar base). Otherwise the project profile applies — its full style for generate, but only
 * operational defaults (output dir, backend) for edit/upscale so an edit isn't silently re-branded.
 */
async function resolveOpts(opts: StyleInput, applyProfileStyle = true): Promise<StyleInput> {
  if (opts.fromImage) {
    const base = await sidecarAsBase(opts.fromImage);
    return overlay(base, { ...opts, fromImage: undefined });
  }
  const loaded = loadProfile();
  if (!loaded) return opts;
  const full = profileAsBase(loaded.profile, dirname(loaded.path));
  const base: StyleInput = applyProfileStyle ? full : { outputPath: full.outputPath, backend: full.backend };
  return overlay(base, opts);
}

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
  /** Produce N independent variations of the same brief (1–10). Returned in `variants`. */
  count?: number;
  /** Produce a CONSISTENT set of N: the first image is reused as a style reference for the rest. */
  series?: number;
  /** Reproduce/tweak a prior image: load its sidecar as the base, then apply any args on top. */
  fromImage?: string;
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

/** Run a backend, persist the bytes (+ a reproducibility sidecar), return the path-first result. */
async function runAndSave(
  input: GenerateInput,
  outputPath: string | undefined,
  backend: string | undefined,
  prefix: string,
  meta: SaveMeta,
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
    if (SIDECARS) {
      const sc = sidecarFromOpts(meta.operation, meta.opts, meta);
      sc.revisedPrompt = result.revisedPrompt;
      if (meta.refs) sc.inputImages = meta.refs;
      if (meta.mask) sc.maskPath = meta.mask;
      sc.backend = provider.name;
      await writeFile(`${outPath}.json`, JSON.stringify(sc, null, 2)).catch(() => {});
    }
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
export async function generateImage(rawOpts: StyleInput): Promise<GenerateOutput> {
  const opts = await resolveOpts(rawOpts); // apply project profile / --from sidecar beneath the call
  const series = Math.max(1, Math.min(10, opts.series ?? 1));
  if (series > 1) return generateSeries(opts, series);

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
    operation: "generate",
    opts,
    refs: opts.styleReference,
    transform: chromaTransparent ? (b) => removeBackground(b, { keyColor: CHROMA_RGB, tolerance: 70 }) : undefined,
  });
}

/**
 * Consistent SET of N: generate an anchor, then reuse it as a style reference for the rest so the
 * whole series shares a coherent look (same character / brand). Returns anchor + variants.
 */
async function generateSeries(opts: StyleInput, n: number): Promise<GenerateOutput> {
  const base = { ...opts, series: undefined, count: undefined };
  const anchor = await generateImage(base);
  const variants: string[] = [];
  for (let i = 2; i <= n; i++) {
    const next = await generateImage({
      ...base,
      styleReference: [...(opts.styleReference ?? []), anchor.path],
      outputPath: opts.outputPath ? indexedPath(resolveOutputPath(opts.outputPath, anchor.format, "img"), i) : undefined,
    });
    variants.push(next.path);
  }
  return { ...anchor, variants: variants.length ? variants : undefined };
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
export async function editImage(rawOpts: EditInput): Promise<GenerateOutput> {
  // Merge profile's operational defaults (+ a --from sidecar) without re-branding the edit.
  const opts: EditInput = { ...rawOpts, ...(await resolveOpts(rawOpts, false)) };
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
    operation: "edit",
    opts,
    refs: opts.imagePaths,
    mask: opts.maskPath,
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
  // Profile operational defaults only (output dir / backend) — never restyle an upscale.
  const loaded = loadProfile();
  const outputPath = opts.outputPath ?? (loaded ? profileAsBase(loaded.profile, dirname(loaded.path)).outputPath : undefined);
  const backend = opts.backend ?? loaded?.profile.backend;

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
  return runAndSave(input, outputPath, backend, prefix, {
    prompt,
    modifiers: [],
    operation: "upscale",
    opts: { size: opts.size, quality: opts.quality, format: opts.format, backend },
    refs: [opts.imagePath],
  });
}
