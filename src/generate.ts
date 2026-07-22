// Core operations: text-to-image (generate), image-to-image (edit), and detail-enhancing
// regeneration (upscale). Each composes a prompt via the preset engine, runs a backend, saves the
// image to disk, and returns a path-first result (the only return shape that works across agents).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { getProvider } from "./providers/index.js";
import type { GenerateInput, ImageBackground, ImageFormat, ImageProvider, ImageQuality, ImageSize, InputImage } from "./providers/types.js";
import { build, type PromptOverrides } from "./presets/index.js";
import { imageSize, looksLikeImage, sizeForAspect, upscaleSizeForAspect } from "./imageinfo.js";
import { removeBackground } from "./bgremove.js";
import { mimeForFormat } from "./imageops.js";
import { loadProfile, type BrandProfile } from "./profile.js";
import { getPlatform, type PlatformTarget } from "./platforms.js";
import { extractPalette } from "./palette.js";
import { proofImage, type ProofRequest, type ProofVerdict } from "./proof.js";
import { stripImageMetadata } from "./metastrip.js";

const SIDECARS = process.env.GPT_IMAGE_NO_SIDECAR !== "1";
// Every saved image is scrubbed of provenance metadata (EXIF/XMP/C2PA) by default — opt out to
// keep the model's original container bytes (e.g. if you WANT content credentials preserved).
const STRIP_METADATA = process.env.GPT_IMAGE_KEEP_METADATA !== "1";

/** The directory to discover a `.gptimage.json` profile from, given where an asset is being written.
 *  A trailing-separator path IS the target directory; otherwise use the file's directory. */
export function profileStartDir(outputPath?: string): string | undefined {
  if (!outputPath) return undefined;
  const abs = resolve(process.cwd(), outputPath);
  return /[\\/]$/.test(outputPath) ? abs : dirname(abs);
}

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
    platform: top.platform ?? base.platform,
    proof: top.proof ?? base.proof,
    autoPalette: top.autoPalette ?? base.autoPalette,
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
    platform: p.platform,
    proof: p.proof,
    autoPalette: p.autoPalette,
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
  platform?: string;
  style?: PromptOverrides;
  size?: ImageSize;
  quality?: ImageQuality;
  format?: ImageFormat;
  background?: ImageBackground;
  backend?: string;
  compiledPrompt: string;
  revisedPrompt?: string;
  styleReference?: string[];
  /** Brand colors auto-extracted from styleReference for this generation. */
  palette?: string[];
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
  /** Brand colors extracted for this call — recorded in the sidecar for reproducibility. */
  palette?: string[];
  /** Vision proof-loop: verify each render, regenerate with feedback up to maxAttempts. */
  proof?: ProofRequest & { maxAttempts: number };
}

function sidecarFromOpts(op: Sidecar["operation"], opts: StyleInput, meta: SaveMeta): Sidecar {
  return {
    tool: "gpt-image-tool",
    operation: op,
    subject: opts.subject,
    prompt: opts.prompt,
    preset: meta.preset,
    modifiers: meta.modifiers,
    platform: opts.platform,
    style: opts.style,
    size: opts.size,
    quality: opts.quality,
    format: opts.format,
    background: opts.background ?? (opts.transparent ? "transparent" : undefined),
    backend: opts.backend,
    compiledPrompt: meta.prompt,
    styleReference: opts.styleReference,
    palette: meta.palette,
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
    platform: s.platform,
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
  // Discover the profile from where the caller is writing the asset (follows the right project on a
  // shared MCP server), falling back to CLAUDE_PROJECT_DIR / cwd inside loadProfile.
  const loaded = loadProfile(profileStartDir(opts.outputPath));
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
  /** Target platform (e.g. "instagram-story"): picks the native size and appends a safe-area
   *  composition constraint so critical content isn't hidden under platform UI. */
  platform?: string;
  /** Vision proof-loop: verify the render (text verbatim, no artifacts) and auto-regenerate with
   *  feedback on failure. Defaults to ON when style.text is set; set false to skip. */
  proof?: boolean;
  /** Auto-extract a brand palette from styleReference (profile flag; default true). */
  autoPalette?: boolean;
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
  /** Platform target that shaped this image (size + safe-area constraint). */
  platform?: string;
  /** Publishing note for the platform (what UI covers what). */
  platformNote?: string;
  /** Brand colors auto-extracted from styleReference and anchored in the prompt. */
  palette?: string[];
  /** Vision proofread verdict for the primary image (when the proof-loop ran). */
  proof?: ProofVerdict;
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

/** Call the provider, retrying once if the model replied with text instead of an image. Validates
 *  the returned bytes are actually an image at the provider boundary (protects every consumer). */
async function generateWithRetry(provider: ImageProvider, input: GenerateInput) {
  const ensureImage = (r: Awaited<ReturnType<ImageProvider["generate"]>>) => {
    if (!looksLikeImage(r.bytes)) {
      throw new Error("backend returned data that isn't a valid image — try again or switch --backend apikey.");
    }
    return r;
  };
  try {
    return ensureImage(await provider.generate(input));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no image|returned no image/i.test(msg)) {
      const forced: GenerateInput = {
        ...input,
        prompt:
          input.prompt +
          " IMPORTANT: respond ONLY by calling the image_generation tool to produce the image — do not reply with any text.",
      };
      return ensureImage(await provider.generate(forced));
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

  const saved: { path: string; result: Awaited<ReturnType<ImageProvider["generate"]>>; verdict?: ProofVerdict }[] = [];
  for (let i = 0; i < count; i++) {
    let result = await generateWithRetry(provider, input); // validated to be an image
    let verdict: ProofVerdict | undefined;
    if (meta.proof) {
      // Proof-loop: proofread the render; on concrete failures, regenerate with that feedback.
      const mime = mimeForFormat(input.format);
      for (let attempt = 1; ; attempt++) {
        verdict = { ...(await proofImage(result.bytes, mime, meta.proof)), attempts: attempt };
        if (verdict.pass || verdict.unverified || attempt >= meta.proof.maxAttempts) break;
        console.error(
          `[gpt-image] proofread failed (attempt ${attempt}/${meta.proof.maxAttempts}): ${verdict.issues.join("; ")} — regenerating with feedback.`,
        );
        result = await generateWithRetry(provider, {
          ...input,
          prompt:
            input.prompt +
            ` IMPORTANT — a previous attempt failed proofreading with these exact problems: ${verdict.issues.join("; ")}.` +
            ` Fix ALL of them. Render every word of text perfectly, verbatim, correctly spelled with correct diacritics.`,
        });
      }
    }
    if (meta.transform) {
      // A keying/post-process failure must not lose the image — fall back to the original bytes.
      try {
        result.bytes = meta.transform(result.bytes);
      } catch (e) {
        console.error(`[gpt-image] background key-out failed (${e instanceof Error ? e.message : e}); saving without transparency.`);
      }
    }
    if (STRIP_METADATA) {
      // A stripping failure must never lose the image — keep the original container bytes.
      try {
        result.bytes = stripImageMetadata(result.bytes);
      } catch (e) {
        console.error(`[gpt-image] metadata strip failed (${e instanceof Error ? e.message : e}); saving original bytes.`);
      }
    }
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
    saved.push({ path: outPath, result, verdict });
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
    proof: primary.verdict,
  };
}

const STYLE_REF_PREFIX =
  "Use the attached image(s) ONLY as a style and aesthetic reference — match their visual style, " +
  "color palette, lighting, and treatment — but depict the subject described below, not the reference's content. ";

// Transparency on a backend that can't emit it natively (subscription) is faked: the model renders
// on a flat chroma field we key out locally. A FIXED green field fails when the subject is itself
// green/teal/cyan — the key bites into the subject and the de-spill has no clean colour to clamp to.
// So the key ADAPTS: we pick the candidate whose hue sits farthest from the brand/subject colour.
interface ChromaKey {
  hex: string;
  name: string;
  rgb: { r: number; g: number; b: number };
  hue: number;
}

const CHROMA_KEYS: ChromaKey[] = [
  { hex: "#00B140", name: "green", rgb: { r: 0x00, g: 0xb1, b: 0x40 }, hue: 150 },
  { hex: "#FF00FF", name: "magenta", rgb: { r: 0xff, g: 0x00, b: 0xff }, hue: 300 },
  { hex: "#1E5AFF", name: "blue", rgb: { r: 0x1e, g: 0x5a, b: 0xff }, hue: 224 },
];
const DEFAULT_CHROMA = CHROMA_KEYS[0]!; // green — the safe default when no colour hint is available

function hexToHue(hex: string): number | null {
  const m = /([0-9a-f]{6})/i.exec(hex);
  if (!m) return null;
  const int = parseInt(m[1]!, 16);
  const r = (int >> 16) / 255;
  const g = ((int >> 8) & 0xff) / 255;
  const b = (int & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-6) return null; // achromatic — no usable hue
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Pick the chroma key whose hue is farthest from EVERY colour the subject is being steered toward
 * (style colour + the full auto-extracted brand palette — the prompt anchors all of them, so the
 * key must not collide with any). Maximizes the minimum hue distance; falls back to green when
 * there's no usable hint.
 */
export function pickChromaKey(colorHints?: string | string[]): ChromaKey {
  const hints = (Array.isArray(colorHints) ? colorHints : [colorHints]).filter(Boolean) as string[];
  const hues: number[] = [];
  for (const hint of hints) {
    for (const hex of hint.match(/#?[0-9a-f]{6}\b/gi) ?? []) {
      const hue = hexToHue(hex);
      if (hue != null) hues.push(hue);
    }
  }
  if (!hues.length) return DEFAULT_CHROMA;
  let best = DEFAULT_CHROMA;
  let bestDist = -1;
  for (const k of CHROMA_KEYS) {
    const dist = Math.min(...hues.map((h) => hueDistance(h, k.hue)));
    if (dist > bestDist) {
      bestDist = dist;
      best = k;
    }
  }
  return best;
}

/**
 * Shared chroma-transparency setup for generate + edit. Returns the prompt suffix that tells the
 * model to render on the chosen chroma field, and the post-process that keys it back out. A no-op
 * when transparency isn't wanted or the backend emits it natively (apikey).
 */
function chromaSetup(
  wantTransparent: boolean,
  backendName: string,
  colorHints?: string | string[],
): { promptSuffix: string; transform?: (b: Buffer) => Buffer } {
  if (!wantTransparent || backendName === "apikey") return { promptSuffix: "" };
  const key = pickChromaKey(colorHints);
  const promptSuffix =
    ` Render the subject fully isolated and centered on a completely solid, uniform chroma-key ${key.name}` +
    ` (${key.hex}) background — no shadows, no gradient, no reflections, no other elements, and do` +
    ` not use that ${key.name} anywhere in the subject itself.`;
  return { promptSuffix, transform: (b: Buffer) => removeBackground(b, { keyColor: key.rgb, tolerance: 70 }) };
}

function resolveBackendName(backend: string | undefined): string {
  return (backend || process.env.GPT_IMAGE_BACKEND || "subscription").toLowerCase();
}

/**
 * Resolve the proof-loop request for a call: explicit `proof` wins, otherwise it runs whenever the
 * image renders literal text (the model's weakest, most-publishable failure mode).
 */
function proofRequest(opts: StyleInput, chromaActive: boolean): SaveMeta["proof"] {
  const expectedText = opts.style?.text?.trim() || undefined;
  const wanted = opts.proof ?? Boolean(expectedText);
  if (!wanted) return undefined;
  return {
    expectedText,
    context: chromaActive
      ? "the subject is intentionally rendered on a solid uniform chroma-key background that will be removed afterwards"
      : undefined,
    maxAttempts: Math.max(1, Math.min(5, Number(process.env.GPT_IMAGE_PROOF_ATTEMPTS) || 3)),
  };
}

/** Text-to-image. Compose from subject + preset (+ modifiers + style overrides), or a raw prompt. */
export async function generateImage(rawOpts: StyleInput): Promise<GenerateOutput> {
  const opts = await resolveOpts(rawOpts); // apply project profile / --from sidecar beneath the call
  const series = Math.max(1, Math.min(10, opts.series ?? 1));
  if (series > 1) return generateSeries(opts, series);

  // Platform target: native size (explicit size still wins) + a safe-area composition constraint.
  const plat: PlatformTarget | undefined = opts.platform ? getPlatform(opts.platform) : undefined;

  // Brand palette: anchor colors to what the styleReference assets ACTUALLY contain, unless the
  // caller wrote an explicit color. Opt out via profile `autoPalette: false` / GPT_IMAGE_NO_AUTOPALETTE=1.
  // Extracted BEFORE compose so it joins the prompt canonically and steers the chroma-key choice.
  let palette: string[] = [];
  if (opts.styleReference?.length && !opts.style?.color && opts.autoPalette !== false && process.env.GPT_IMAGE_NO_AUTOPALETTE !== "1") {
    palette = await extractPalette(opts.styleReference).catch(() => []);
  }

  const extraClauses: string[] = [];
  if (plat) extraClauses.push(plat.clause);
  if (palette.length) extraClauses.push(`Anchor the color palette to the brand colors ${palette.join(", ")}`);

  const composed = build({
    subject: opts.subject,
    rawPrompt: opts.prompt,
    preset: opts.preset,
    modifiers: opts.modifiers,
    overrides: opts.style,
    extraClauses,
    size: opts.size ?? plat?.size,
    quality: opts.quality,
    format: opts.format,
    background: opts.transparent ? "transparent" : opts.background,
  });

  const wantTransparent = composed.background === "transparent";
  const backendName = resolveBackendName(opts.backend);
  // apikey supports native transparency; subscription does not, so render-on-chroma + key it out.
  const nativeTransparent = wantTransparent && backendName === "apikey";
  // The key must dodge EVERY color the prompt steers the subject toward (style color + palette).
  const chroma = chromaSetup(wantTransparent, backendName, [opts.style?.color ?? "", ...palette]);

  let inputImages: InputImage[] | undefined;
  let prompt = composed.prompt;
  if (chroma.promptSuffix) prompt += chroma.promptSuffix;
  if (opts.styleReference?.length) {
    // Skip (with a warning) any reference that can't be read — a typo in a brand profile's
    // styleReference must not break every generation in the project.
    const loaded: InputImage[] = [];
    for (const ref of opts.styleReference) {
      try {
        loaded.push((await readInputImage(ref)).image);
      } catch (e) {
        console.error(`[gpt-image] skipping style reference ${ref}: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (loaded.length) {
      inputImages = loaded;
      prompt = STYLE_REF_PREFIX + prompt;
    }
  }

  const input: GenerateInput = {
    prompt,
    size: composed.size,
    quality: composed.quality,
    format: wantTransparent ? "png" : composed.format, // alpha needs png
    background: nativeTransparent ? "transparent" : "auto",
    inputImages,
  };
  const out = await runAndSave(input, opts.outputPath, opts.backend, "img", {
    prompt,
    preset: composed.presetId,
    modifiers: composed.modifierIds,
    count: opts.count,
    operation: "generate",
    opts,
    refs: opts.styleReference,
    palette: palette.length ? palette : undefined,
    transform: chroma.transform,
    proof: proofRequest(opts, Boolean(chroma.transform)),
  });
  if (plat) {
    out.platform = plat.id;
    out.platformNote = plat.note;
  }
  if (palette.length) out.palette = palette;
  return out;
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
  let maskImage: InputImage | undefined;
  if (opts.maskPath) {
    const m = await readInputImage(opts.maskPath);
    const img = loaded[0]!.dim;
    if (img && m.dim && (img.width !== m.dim.width || img.height !== m.dim.height)) {
      throw new Error(
        `mask ${opts.maskPath} (${m.dim.width}x${m.dim.height}) must match the first image (${img.width}x${img.height}).`,
      );
    }
    maskImage = m.image;
  }

  const hasStyle = Boolean(opts.preset || opts.subject || opts.modifiers?.length || opts.style);
  const instruction = opts.instruction?.trim();
  if (!instruction && !hasStyle) {
    throw new Error("editImage requires `instruction` (what to change) or a preset/subject/style.");
  }

  // Platform target works on edits too (reframe an existing asset for a story/post).
  const plat: PlatformTarget | undefined = opts.platform ? getPlatform(opts.platform) : undefined;

  // If a style is requested, compose it; otherwise the instruction alone drives the edit.
  const composed = build({
    subject: opts.subject ?? "the result",
    rawPrompt: hasStyle ? undefined : instruction,
    preset: opts.preset,
    modifiers: opts.modifiers,
    overrides: opts.style,
    extraClauses: plat ? [plat.clause] : undefined,
    size: opts.size ?? plat?.size ?? sizeForAspect(loaded[0]!.dim),
    quality: opts.quality,
    format: opts.format,
    background: opts.transparent ? "transparent" : opts.background,
  });

  let prompt = composed.prompt;
  if (instruction && hasStyle) prompt = `${instruction}. Apply this to the reference image. ${composed.prompt}`;
  else if (instruction) prompt = instruction + EDIT_PRESERVE;

  // Edits need the same fake-transparency path as generate: without it, a
  // `transparent` edit on the subscription backend renders on a white field
  // that nothing keys out (the "white box" cutout bug).
  const wantTransparent = composed.background === "transparent";
  const backendName = resolveBackendName(opts.backend);
  const nativeTransparent = wantTransparent && backendName === "apikey";
  const chroma = chromaSetup(wantTransparent, backendName, opts.style?.color);
  if (chroma.promptSuffix) prompt += chroma.promptSuffix;

  const input: GenerateInput = {
    prompt,
    size: composed.size,
    quality: composed.quality,
    format: wantTransparent ? "png" : composed.format, // alpha needs png
    background: nativeTransparent ? "transparent" : "auto",
    inputImages,
    maskImage,
  };
  const out = await runAndSave(input, opts.outputPath, opts.backend, "edit", {
    prompt,
    preset: composed.presetId,
    modifiers: composed.modifierIds,
    count: opts.count,
    operation: "edit",
    opts,
    refs: opts.imagePaths,
    mask: opts.maskPath,
    transform: chroma.transform,
    proof: proofRequest(opts, Boolean(chroma.transform)),
  });
  if (plat) {
    out.platform = plat.id;
    out.platformNote = plat.note;
  }
  return out;
}

// The cutout instruction is deliberately fidelity-obsessed: use_model REGENERATES the subject
// (it is not a pixel-preserving keyer), so the prompt pins every attribute it can.
const CUTOUT_INSTRUCTION =
  "Reproduce ONLY the main subject of this image, pixel-faithful — identical shape, colors, " +
  "materials, texture, pose and fine detail; do not restyle or simplify it";

/**
 * Model-assisted background removal for busy/photographic backgrounds: re-render the subject on a
 * chroma field via an edit, then the existing keyer cuts it out. NOTE: this is a REGENERATION, not
 * a pixel-preserving cutout — fine text/logos on the subject may drift; the result note says so.
 */
export function modelAssistedCutout(imagePath: string, outputPath?: string, backend?: string): Promise<GenerateOutput> {
  return editImage({
    imagePaths: [imagePath],
    instruction: CUTOUT_INSTRUCTION,
    transparent: true,
    format: "png",
    outputPath,
    backend,
    proof: false,
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
  const loaded = loadProfile(profileStartDir(opts.outputPath) ?? dirname(resolve(process.cwd(), opts.imagePath)));
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
