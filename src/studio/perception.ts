// Optional perception pack (phase 1c): small open models that measure what arithmetic cannot.
// It is never bundled and never loaded at MCP start. It is installed only by an explicit command
// (`gpt-image studio perception install --yes`, sizes shown first) into one folder per user,
// <home>/.gptimage/perception/ (GPT_IMAGE_STUDIO_HOME overrides home), and used only by the run
// worker. Model files are fetched at install time; at run time remote downloads are switched off,
// so nothing downloads silently. Without the pack every reading still works on plain measurements.
//
// Capabilities:
// - similarity: DINOv2-small image embeddings, cosine similarity between a take and its anchor: a
//   number for "same subject, same shape" where the local reading can only compare colour and tone.
//   DreamBooth uses a DINO score as its subject-fidelity measure.
// - mask: U-2-Netp salient-foreground mask: where the subject sits, how much frame it takes, whether
//   it touches an edge. Withheld (subject "unclear") on layouts and full-bleed scenes.
// Depth (Depth Anything V2) and OCR (tesseract.js) from the plan were measured on real images on
// 2026-11-28 and left out; docs/STUDIO.md "Perception pack" has the evidence.

import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { userHome } from "./memory.js";
import type { Reading } from "./types.js";

export const PERCEPTION_SCHEMA = "gpt-image-studio/perception@1";

/** Pinned versions. The runtime is at least two weeks old when pinned; the model at a commit. */
export const RUNTIME = { name: "@huggingface/transformers", version: "4.3.2", licence: "Apache-2.0" } as const;
export const MODELS = {
  similarity: {
    id: "onnx-community/dinov2-small",
    revision: "8b1f705a3a7f6f062f6bdd21986c1583d3ef105d",
    dtype: "q8" as const, // onnx/model_quantized.onnx
    mb: 24.4,
    licence: "Apache-2.0, from the facebook/dinov2-small model card (the ONNX conversion carries no licence tag of its own)",
  },
  mask: {
    // U-2-Netp (xuebinqin/U-2-Net). transformers.js 4.3 has no u2net model type, so the ONNX file runs
    // directly on onnxruntime-node (installed with the runtime). Fetched by file and checked by hash.
    id: "BritishWerewolf/U-2-Netp",
    revision: "7112208dbac3a3642496c8d54e2f0f9bb3dc1dc8",
    file: "onnx/model.onnx",
    sha256: "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8",
    mb: 4.6,
    licence: "Apache-2.0 (model card; U-2-Net itself is Apache-2.0)",
  },
} as const;
export type Capability = keyof typeof MODELS;

/** Approximate unpacked sizes (npm registry, 2026-11-28), shown before installing. */
const DOWNLOADS = [
  ["@huggingface/transformers 4.3.2", 10],
  ["onnxruntime-node 1.30 (native runtime, all platforms)", 308],
  ["onnxruntime-web (a dependency of transformers)", 151],
  ["sharp and small dependencies", 20],
  [`${MODELS.similarity.id} (quantized ONNX)`, MODELS.similarity.mb],
  [`${MODELS.mask.id} (subject mask)`, MODELS.mask.mb],
] as const;

export function perceptionDir(): string { return join(userHome(), ".gptimage", "perception"); }
const manifestPath = () => join(perceptionDir(), "perception.json");

interface Manifest { schema: typeof PERCEPTION_SCHEMA; runtime: string; models: Record<string, { id: string; revision: string; installed: string }> }

/** Cheap: the worker checks this before loading anything. */
export function perceptionInstalled(cap: Capability = "similarity"): boolean {
  try {
    const m = JSON.parse(readFileSync(manifestPath(), "utf8")) as Manifest;
    return m.runtime === `${RUNTIME.name}@${RUNTIME.version}` && m.models[cap]?.revision === MODELS[cap].revision;
  } catch { return false; }
}

export async function perceptionStatus(): Promise<string> {
  const dir = perceptionDir();
  if (!existsSync(manifestPath())) return `Perception pack: not installed (would go to ${dir}).\n${installPlan()}`;
  const m = JSON.parse(await readFile(manifestPath(), "utf8")) as Manifest;
  const lines = [`Perception pack in ${dir}: runtime ${m.runtime}.`];
  for (const [cap, spec] of Object.entries(MODELS)) {
    const have = m.models[cap];
    lines.push(`  ${cap}: ${have ? `${have.id}@${have.revision.slice(0, 7)} (installed ${have.installed.slice(0, 10)})${have.revision === spec.revision ? "" : `; this version expects @${spec.revision.slice(0, 7)}, reinstall`}` : "not installed; gpt-image studio perception install --yes adds it"}`);
  }
  if (m.runtime !== `${RUNTIME.name}@${RUNTIME.version}`) lines.push(`This version expects ${RUNTIME.name}@${RUNTIME.version}; run gpt-image studio perception install --yes.`);
  return lines.join("\n");
}

export function installPlan(): string {
  const total = DOWNLOADS.reduce((a, [, mb]) => a + mb, 0);
  return [
    `Installing downloads about ${Math.round(total)} MB into ${perceptionDir()} (one folder per user, not a global npm install):`,
    ...DOWNLOADS.map(([what, mb]) => `  ${String(Math.round(mb)).padStart(4)} MB  ${what}`),
    `Licences: runtime ${RUNTIME.licence}; onnxruntime MIT; ${MODELS.similarity.id}: ${MODELS.similarity.licence}; ${MODELS.mask.id}: ${MODELS.mask.licence}.`,
    "It adds to run readings: similarity to the anchor, and where the subject is and how much frame it takes. Nothing changes without it.",
    "Install with: gpt-image studio perception install --yes",
  ].join("\n");
}

/** Install the runtime with npm into the pack folder, then fetch the pinned model once. */
export async function installPerception(opts: { yes?: boolean; log?: (s: string) => void } = {}): Promise<string> {
  if (!opts.yes) return installPlan();
  const log = opts.log ?? (() => {});
  const dir = perceptionDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "gpt-image-perception", private: true, description: "Optional perception pack for gpt-image-tool Studio", dependencies: { [RUNTIME.name]: RUNTIME.version } }, null, 2) + "\n");
  log(`npm install ${RUNTIME.name}@${RUNTIME.version} in ${dir} ...`);
  const npm = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund", "--omit=dev"], { cwd: dir, stdio: ["ignore", "inherit", "inherit"], shell: process.platform === "win32" });
  if (npm.status !== 0) throw new Error(`npm install failed in ${dir} (exit ${npm.status}). Nothing else was changed.`);
  const tf = await loadRuntime(true);
  const models: Manifest["models"] = {};
  for (const [cap, spec] of Object.entries(MODELS) as Array<[Capability, any]>) {
    log(`Fetching ${spec.id}@${spec.revision.slice(0, 7)} ...`);
    if (cap === "similarity") await tf.pipeline("image-feature-extraction", spec.id, { revision: spec.revision, dtype: spec.dtype });
    else await fetchFile(spec.id, spec.revision, spec.file, spec.sha256);
    models[cap] = { id: spec.id, revision: spec.revision, installed: new Date().toISOString() };
  }
  const manifest: Manifest = { schema: PERCEPTION_SCHEMA, runtime: `${RUNTIME.name}@${RUNTIME.version}`, models };
  await writeFile(manifestPath(), JSON.stringify(manifest, null, 2) + "\n");
  pipe = undefined;
  return `Installed.\n${await perceptionStatus()}`;
}

let runtime: any;
/** Load transformers from the pack folder. Remote fetches only during install. */
async function loadRuntime(allowRemote = false): Promise<any> {
  if (!runtime) {
    const req = createRequire(join(perceptionDir(), "package.json"));
    let entry: string;
    try { entry = req.resolve(RUNTIME.name); } catch { throw new Error(`The perception pack is not installed in ${perceptionDir()}. See gpt-image studio perception.`); }
    runtime = await import(pathToFileURL(entry).href);
  }
  // Install fetches into cacheDir as <id>/<revision>/; runs read that folder as a local model.
  runtime.env.cacheDir = join(perceptionDir(), "models");
  runtime.env.localModelPath = join(perceptionDir(), "models");
  runtime.env.allowLocalModels = !allowRemote;
  runtime.env.allowRemoteModels = allowRemote;
  return runtime;
}

let pipe: Promise<any> | undefined;
async function embed(path: string): Promise<Float32Array> {
  const tf = await loadRuntime(false);
  const spec = MODELS.similarity;
  pipe ??= tf.pipeline("image-feature-extraction", `${spec.id}/${spec.revision}`, { dtype: spec.dtype });
  const extractor = await pipe;
  const image = await tf.RawImage.read(path);
  // DINOv2: the CLS token of the last hidden state is the image embedding.
  const out = await extractor(image);
  const [, tokens, dim] = out.dims as number[];
  const data = out.data as Float32Array;
  return tokens ? data.slice(0, dim) : data;
}

const cosine = (a: Float32Array, b: Float32Array) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return dot / Math.sqrt(na * nb);
};

/** Cosine similarity of DINOv2 embeddings, as a perception reading. Throws if the pack is missing. */
export async function similarityReading(path: string, anchorPath: string, anchorRef: string): Promise<Reading> {
  const [a, b] = await Promise.all([embed(path), embed(anchorPath)]);
  const spec = MODELS.similarity;
  return { version: 1, source: `${spec.id}@${spec.revision.slice(0, 12)}`, runtime: `${RUNTIME.name}@${RUNTIME.version}`, to: anchorRef, cosine: Math.round(cosine(a, b) * 1000) / 1000 };
}

/** Fetch one model file at a pinned revision into models/<id>/<revision>/<file>, checking its hash. */
async function fetchFile(id: string, revision: string, file: string, sha256: string): Promise<string> {
  const dest = join(perceptionDir(), "models", id, revision, file);
  const { createHash } = await import("node:crypto");
  if (existsSync(dest) && createHash("sha256").update(readFileSync(dest)).digest("hex") === sha256) return dest;
  const res = await fetch(`https://huggingface.co/${id}/resolve/${revision}/${file}`);
  if (!res.ok) throw new Error(`Download of ${id}/${file} failed: HTTP ${res.status}.`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== sha256) throw new Error(`${id}/${file} has sha256 ${got}, expected ${sha256}; not installed.`);
  await mkdir(join(dest, ".."), { recursive: true });
  await writeFile(dest, buf);
  return dest;
}

let ort: any;
async function loadOrt(): Promise<any> {
  if (!ort) {
    // onnxruntime-node is a dependency of the runtime package; resolve it from there.
    const fromRuntime = createRequire(createRequire(join(perceptionDir(), "package.json")).resolve(RUNTIME.name));
    ort = fromRuntime("onnxruntime-node");
  }
  return ort;
}

let maskSession: Promise<any> | undefined;
/** U-2-Netp saliency, 0..1 per pixel of the source image (nearest-neighbour upsampled). */
export async function subjectMask(path: string): Promise<{ width: number; height: number; prob: Float32Array }> {
  const spec = MODELS.mask;
  const model = join(perceptionDir(), "models", spec.id, spec.revision, spec.file);
  if (!existsSync(model)) throw new Error(`The perception pack has no ${spec.id} model in ${perceptionDir()}.`);
  const o = await loadOrt();
  maskSession ??= o.InferenceSession.create(model);
  const session = await maskSession;
  const { resizeRGBA } = await import("../imageops.js");
  // Decode with the pack's reader (sharp): it reads palette and 16-bit PNGs, JPEG and WebP.
  const raw0 = (await (await loadRuntime(false)).RawImage.read(path)).rgba();
  const src = { width: raw0.width as number, height: raw0.height as number, data: Buffer.from(raw0.data.buffer, raw0.data.byteOffset, raw0.data.byteLength) };
  // Preprocessing from the model's preprocessor_config: longest edge 320, pad to 320x320, ImageNet norm.
  const S = 320, scale = S / Math.max(src.width, src.height);
  const w = Math.max(1, Math.round(src.width * scale)), h = Math.max(1, Math.round(src.height * scale));
  const small = resizeRGBA(src, w, h);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const input = new Float32Array(3 * S * S);
  for (let c = 0; c < 3; c++) input.fill(-mean[c]! / std[c]!, c * S * S, (c + 1) * S * S);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) input[c * S * S + y * S + x] = (small.data[i + c]! / 255 - mean[c]!) / std[c]!;
  }
  const out = await session.run({ [session.inputNames[0]]: new o.Tensor("float32", input, [1, 3, S, S]) });
  const raw = out[session.outputNames[0]].data as Float32Array;
  // Normalise to 0..1 over the unpadded area, as rembg does.
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = raw[y * S + x]!; if (v < lo) lo = v; if (v > hi) hi = v; }
  const prob = new Float32Array(src.width * src.height);
  for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
    const sx = Math.min(w - 1, Math.floor(x * scale)), sy = Math.min(h - 1, Math.floor(y * scale));
    prob[y * src.width + x] = hi > lo ? (raw[sy * S + sx]! - lo) / (hi - lo) : 0;
  }
  return { width: src.width, height: src.height, prob };
}

/** Where the subject is and how much frame it takes, from the U-2-Netp mask (threshold 0.5). */
export async function maskReading(path: string): Promise<Reading> {
  const { width: W, height: H, prob } = await subjectMask(path);
  let n = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = -1, y1 = -1, soft = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = prob[y * W + x]!;
    if (v > 0.2 && v < 0.8) soft++;
    if (v < 0.5) continue;
    n++; sx += x; sy += y;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const spec = MODELS.mask;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const base = { version: 1, source: `${spec.id}@${spec.revision.slice(0, 12)}`, runtime: "onnxruntime-node (via the pack)" };
  if (!n) return { ...base, subject: "none", coverage: 0 };
  const touches = [y0 === 0 && "top", x1 === W - 1 && "right", y1 === H - 1 && "bottom", x0 === 0 && "left"].filter(Boolean) as string[];
  const coverage = r3(n / (W * H));
  // U-2-Netp finds salient foreground, not "the subject". Measured 2026-11-28: tight on products,
  // characters and flat mascots; on layouts and screenshots it marks large panels touching the frame,
  // and its own uncertainty stays low there, so those numbers are withheld rather than reported.
  if (touches.length >= 2 || coverage > 0.5) {
    return { ...base, subject: "unclear", coverage, touches, note: "The salient area touches two or more edges or covers over half the frame (a layout, a screenshot, a full-bleed scene): no single subject to measure." };
  }
  const parts = maskParts(prob, W, H);
  return {
    // One connected region can still be a group of touching objects (a shelf of cups and a teapot).
    ...base, subject: parts > 1 ? "several-regions" : "one-region", parts,
    coverage,
    bbox: { x: r3(x0 / W), y: r3(y0 / H), w: r3((x1 - x0 + 1) / W), h: r3((y1 - y0 + 1) / H) },
    centroid: { x: r3(sx / n / W), y: r3(sy / n / H) },
    touches,
    /** Share of pixels the model is unsure about (0.2-0.8): high means no clear subject. */
    uncertain: r3(soft / (W * H)),
  };
}

/** Separate salient pieces of at least 1% of the frame, on a grid of at most 96 px. */
function maskParts(prob: Float32Array, W: number, H: number): number {
  const k = Math.max(1, Math.ceil(Math.max(W, H) / 96));
  const gw = Math.ceil(W / k), gh = Math.ceil(H / k);
  const on = new Uint8Array(gw * gh);
  for (let y = 0; y < H; y += k) for (let x = 0; x < W; x += k) if (prob[y * W + x]! >= 0.5) on[Math.floor(y / k) * gw + Math.floor(x / k)] = 1;
  const seen = new Uint8Array(gw * gh);
  let parts = 0;
  for (let i = 0; i < on.length; i++) {
    if (!on[i] || seen[i]) continue;
    let size = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop()!; size++;
      const cx = c % gw, cy = (c - cx) / gw;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const j = ny * gw + nx;
        if (on[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (size >= 0.01 * gw * gh) parts++;
  }
  return parts;
}

