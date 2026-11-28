// Optional perception pack (phase 1c): small open models that measure what arithmetic cannot.
// It is never bundled and never loaded at MCP start. It is installed only by an explicit command
// (`gpt-image studio perception install --yes`, sizes shown first) into one folder per user,
// <home>/.gptimage/perception/ (GPT_IMAGE_STUDIO_HOME overrides home), and used only by the run
// worker. Model files are fetched at install time; at run time remote downloads are switched off,
// so nothing downloads silently. Without the pack every reading still works on plain measurements.
//
// Capability so far: similarity. DINOv2-small image embeddings, cosine similarity between a take
// and its anchor: a number for "same subject, same look" where the local reading can only compare
// colour and tone. DreamBooth uses a DINO score as its subject-fidelity measure.

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
} as const;
export type Capability = keyof typeof MODELS;

/** Approximate unpacked sizes (npm registry, 2026-11-28), shown before installing. */
const DOWNLOADS = [
  ["@huggingface/transformers 4.3.2", 10],
  ["onnxruntime-node 1.30 (native runtime, all platforms)", 308],
  ["onnxruntime-web (a dependency of transformers)", 151],
  ["sharp and small dependencies", 20],
  [`${MODELS.similarity.id} (quantized ONNX)`, MODELS.similarity.mb],
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
    lines.push(`  ${cap}: ${have ? `${have.id}@${have.revision.slice(0, 7)} (installed ${have.installed.slice(0, 10)})${have.revision === spec.revision ? "" : `; this version expects @${spec.revision.slice(0, 7)}, reinstall`}` : "not installed"}`);
  }
  if (m.runtime !== `${RUNTIME.name}@${RUNTIME.version}`) lines.push(`This version expects ${RUNTIME.name}@${RUNTIME.version}; run gpt-image studio perception install --yes.`);
  return lines.join("\n");
}

export function installPlan(): string {
  const total = DOWNLOADS.reduce((a, [, mb]) => a + mb, 0);
  return [
    `Installing downloads about ${Math.round(total)} MB into ${perceptionDir()} (one folder per user, not a global npm install):`,
    ...DOWNLOADS.map(([what, mb]) => `  ${String(Math.round(mb)).padStart(4)} MB  ${what}`),
    `Licences: runtime ${RUNTIME.licence}; onnxruntime MIT; ${MODELS.similarity.id}: ${MODELS.similarity.licence}.`,
    "It adds a similarity number between a take and its anchor to run readings. Nothing changes without it.",
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
  for (const [cap, spec] of Object.entries(MODELS)) {
    log(`Fetching ${spec.id}@${spec.revision.slice(0, 7)} ...`);
    await tf.pipeline("image-feature-extraction", spec.id, { revision: spec.revision, dtype: spec.dtype });
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
