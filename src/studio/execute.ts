// Node executors. Provider work always goes through the existing generate/edit/upscale paths with
// the backend passed explicitly: "subscription" with image_model "auto" unless the slot carries an
// API render (renderer "api" on the node, or a finish node), then "apikey" with that render's model.
// Neither a project profile nor GPT_IMAGE_BACKEND can move a slot between the two, and there is no
// fallback in either direction. Heavy modules load lazily so read and edit commands stay fast.

import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import type { NodeEval, Slot } from "./evaluate.js";
import { shotToDims } from "./evaluate.js";
import type { GraphFile, GraphNode, StateFile } from "./types.js";

export interface ExecInput {
  project: string;
  dir: string;
  graph: GraphFile;
  state: StateFile;
  evals: Map<string, NodeEval>;
  node: GraphNode;
  slot: Slot;
  takeId: string;
  /** Absolute output path without extension, inside assets/. */
  outBase: string;
}
export interface ExecOutput {
  path: string;
  files?: string[];
  compiledPrompt?: string;
  revisedPrompt?: string;
  generations: number;
  warnings?: string[];
  kind?: "image" | "package";
  /** API slots: usage as the API reported it, summed over this slot's requests. */
  usage?: import("../pricing.js").ImageUsage;
  /** API slots: which source supplied the key (never the key). */
  keySource?: string;
}
export type Executor = (x: ExecInput) => Promise<ExecOutput>;
export type ExecutorKind = "generate" | "edit" | "process" | "handoff" | "implementation" | "finish";
export type Executors = Record<ExecutorKind, Executor>;

const BACKEND = "subscription";
const MODEL = "auto";

function lookArgs(slot: Slot) {
  const look = slot.look ?? {};
  const dims = { ...shotToDims(look.shot), ...(look.style ?? {}) };
  return {
    preset: look.preset,
    modifiers: look.modifiers,
    style: Object.keys(dims).length ? (dims as any) : undefined,
    brief: look.brief as any,
  };
}

const refArgs = (x: Pick<ExecInput, "dir" | "slot">) => x.slot.refs.map(r => ({ path: resolve(x.dir, r.asset), role: (r.role ?? "style") as any, ...(r.instruction ? { instruction: r.instruction } : {}) }));

/** "Change only the key light to: backlight", so a sweep varies one thing and holds the subject. */
export function sweepInstruction(dim: string, value: string): string {
  const name = dim === "preset" ? "overall style" : dim.split(".")[1]!.replace(/_/g, " ").replace(/^color/, "colour");
  return `Keep the subject, its shape, materials and position, and the composition exactly as in the image. Change only the ${name} to: ${value}`;
}

type PromptInput = Pick<ExecInput, "dir" | "node" | "slot"> & { project?: string };
/** Backend arguments for a slot: explicit both ways, never inferred. */
export function backendArgs(x: Pick<PromptInput, "slot" | "project">) {
  const r = x.slot.render;
  if (r?.renderer === "api") return { backend: "apikey", imageModel: r.model, complexity: r.complexity, keyProject: x.project };
  return { backend: BACKEND, imageModel: MODEL };
}
const common = (x: PromptInput) => {
  const s = x.node.settings as Record<string, any>;
  const r = x.slot.render;
  return { size: r ? r.size : s.size, quality: r?.quality ?? s.quality ?? "low", format: s.format ?? "png", transparent: s.transparent, platform: s.platform, proof: s.proof, ...backendArgs(x), count: 1 };
};

/** A sweep slot with an anchor: an edit of the anchor that changes only the swept dimension. */
function sweepEditArgs(x: PromptInput) {
  const sw = x.slot.sweep!;
  return { imagePaths: [resolve(x.dir, sw.anchor!.asset)], instruction: sweepInstruction(sw.dim, sw.value), ...lookArgs(x.slot),
    references: refArgs(x).filter(r => r.path !== resolve(x.dir, sw.anchor!.asset)), ...common(x) };
}
function generateArgs(x: PromptInput) {
  return { subject: x.slot.text, ...lookArgs(x.slot), references: refArgs(x), ...common(x), contactSheet: false };
}
function editArgs(x: PromptInput) {
  const s = x.node.settings as Record<string, any>;
  return {
    imagePaths: [resolve(x.dir, x.slot.image!.asset)], ...lookArgs(x.slot), references: refArgs(x),
    instruction: x.slot.sweep ? [x.slot.text, sweepInstruction(x.slot.sweep.dim, x.slot.sweep.value)].filter(Boolean).join(". ") : x.slot.text || undefined,
    maskPath: x.slot.mask ? resolve(x.dir, x.slot.mask.asset) : undefined, preserveUnmasked: s.preserve_unmasked, ...common(x),
  };
}

/** The prompt a provider slot would send, compiled offline (no provider call). For dry runs. */
export async function previewPrompt(x: PromptInput): Promise<string | undefined> {
  const { previewImageRequest, previewEditPrompt } = await import("../generate.js");
  if (x.node.type === "generate") {
    if (x.slot.sweep?.anchor) return previewEditPrompt(sweepEditArgs(x));
    return (await previewImageRequest(generateArgs(x))).compiledPrompt;
  }
  if (x.node.type === "edit" && x.slot.image) return previewEditPrompt(editArgs(x));
  if (x.node.type === "finish" && x.slot.image) return previewEditPrompt(finishArgs(x));
  return undefined;
}

const result = (out: Awaited<ReturnType<typeof import("../generate.js").generateImage>>): ExecOutput =>
  ({ path: out.path, compiledPrompt: out.prompt, revisedPrompt: out.revisedPrompt, generations: out.requests ?? out.proof?.attempts ?? 1, warnings: out.qa?.warnings,
    ...(out.usage ? { usage: out.usage } : {}), ...(out.keySource ? { keySource: out.keySource } : {}) });

/** The ladder's preserving instruction (bench/api-2.6-test: a final made from the draft image keeps
 *  the subject; one made from the prompt alone does not). Extra direction is appended, never
 *  substituted. */
export const FINISH_INSTRUCTION =
  "Re-render this exact image at final production quality and a higher resolution. Keep the composition, framing, camera angle, " +
  "subject, its shape and proportions, every colour, the lighting direction and the background exactly as they are. " +
  "Improve only fine detail, material realism, edge sharpness and clean tonal gradation. Do not add, remove, move or restyle anything.";

function finishArgs(x: PromptInput) {
  const s = x.node.settings as Record<string, any>;
  const r = x.slot.render!;
  return {
    imagePaths: [resolve(x.dir, x.slot.image!.asset)],
    instruction: s.instruction ? `${FINISH_INSTRUCTION} ${s.instruction}` : FINISH_INSTRUCTION,
    size: r.size as any, quality: r.quality as any, format: s.format ?? "png", proof: false, ...backendArgs(x), count: 1,
  };
}

async function execFinish(x: ExecInput): Promise<ExecOutput> {
  const { editImage } = await import("../generate.js");
  return result(await editImage({ ...finishArgs(x), outputPath: `${x.outBase}.png` }));
}

async function execGenerate(x: ExecInput): Promise<ExecOutput> {
  const { generateImage, editImage } = await import("../generate.js");
  if (x.slot.sweep?.anchor) return result(await editImage({ ...sweepEditArgs(x), outputPath: `${x.outBase}.png` }));
  return result(await generateImage({ ...generateArgs(x), outputPath: `${x.outBase}.png` }));
}

async function execEdit(x: ExecInput): Promise<ExecOutput> {
  const { editImage } = await import("../generate.js");
  return result(await editImage({ ...editArgs(x), outputPath: `${x.outBase}.png` }));
}

async function execProcess(x: ExecInput): Promise<ExecOutput> {
  const s = x.node.settings as Record<string, any>;
  const src = resolve(x.dir, x.slot.image!.asset);
  switch (s.op) {
    case "remove-background": {
      const out = `${x.outBase}.png`;
      if (s.use_model) {
        const { editImage, CUTOUT_INSTRUCTION } = await import("../generate.js");
        const b = backendArgs(x);
        // modelAssistedCutout, with the key folder and complexity passed through for API slots.
        const r = await editImage({ imagePaths: [src], instruction: CUTOUT_INSTRUCTION, transparent: true, format: "png", outputPath: out, proof: false, ...b, ...(x.slot.render?.quality ? { quality: x.slot.render.quality as any } : {}) });
        return { ...result(r), warnings: ["Model-assisted cutout regenerates the subject; compare fine detail with the original."] };
      }
      const { removeBackgroundFile } = await import("../imageops.js");
      await removeBackgroundFile(src, out, s.tolerance != null ? { tolerance: s.tolerance } : undefined);
      return { path: out, generations: 0 };
    }
    case "upscale": {
      const { upscaleImage } = await import("../generate.js");
      const rr = x.slot.render;
      const r = await upscaleImage({ imagePath: src, guidance: s.guidance, quality: (rr?.quality ?? s.quality ?? "high") as any, ...(rr?.size ? { size: rr.size as any } : {}), outputPath: `${x.outBase}.png`, ...backendArgs(x) });
      return { ...result(r), compiledPrompt: r.prompt };
    }
    case "strip-metadata": {
      const { stripImageMetadata } = await import("../metastrip.js");
      const out = `${x.outBase}${extname(src)}`;
      await writeFile(out, stripImageMetadata(await readFile(src)));
      return { path: out, generations: 0 };
    }
    case "web-export": {
      const { exportWebAssets } = await import("../webassets.js");
      const res = await exportWebAssets({ sourcePath: src, kind: s.kind ?? "og", outDir: `${x.outBase}-web` });
      const images = res.files.filter(f => /\.(png|jpe?g|webp)$/i.test(f.path)).sort((a, b) => b.width * b.height - a.width * a.height);
      return { path: images[0]!.path, files: res.files.map(f => f.path), generations: 0, warnings: res.notes.length ? res.notes : undefined };
    }
  }
  throw new Error(`process op ${s.op} is not supported`);
}

async function execImplementation(x: ExecInput): Promise<ExecOutput> {
  const shot = resolve(x.project, x.slot.screenshot!.rel);
  const ext = extname(shot).toLowerCase() || ".png";
  const copy = `${x.outBase}${ext}`;
  await mkdir(join(x.dir, "assets"), { recursive: true });
  await copyFile(shot, copy);
  const { compareSheet, packageManifest } = await import("./handoff.js");
  const manifest = await packageManifest(x.dir, x.slot.pkg!.asset);
  const mock = manifest?.mocks?.[0];
  const files: string[] = [];
  const warnings: string[] = [];
  if (mock) {
    const sheet = `${x.outBase}-compare.png`;
    try {
      await compareSheet(resolve(dirname(resolve(x.dir, x.slot.pkg!.asset)), mock.file), copy, sheet, { left: `mock (${mock.from})`, right: `build (${x.node.id}/${x.takeId})` });
      files.push(sheet);
    } catch (e) {
      warnings.push(`Comparison sheet failed: ${e instanceof Error ? e.message : e}`);
    }
  } else warnings.push("The handoff package has no mock image to compare against.");
  return { path: copy, files, generations: 0, warnings: warnings.length ? warnings : undefined };
}

async function execHandoff(x: ExecInput): Promise<ExecOutput> {
  const { writeHandoff } = await import("./handoff.js");
  return writeHandoff(x);
}

export const realExecutors: Executors = { generate: execGenerate, edit: execEdit, process: execProcess, handoff: execHandoff, implementation: execImplementation, finish: execFinish };
