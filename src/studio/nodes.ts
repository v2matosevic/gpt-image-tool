// Node types: handles, settings schemas and the documentation studio_guide renders from them, so
// the guide can never drift from what validation accepts.

import { z } from "zod";
import { MODIFIER_IDS, PRESET_IDS } from "../presets/index.js";
import { PLATFORM_IDS } from "../platforms.js";
import { creativeBriefSchema } from "../brief.js";
import type { HandleType, Issue, NodeType } from "./types.js";

export interface HandleSpec { name: string; type: HandleType; multi: boolean; doc: string }
export interface NodeSpec {
  type: NodeType;
  summary: string;
  inputs: HandleSpec[];
  outputs: HandleSpec[];
  settings: z.ZodObject<any>;
  docs: Record<string, string>;
  /** The long text field prompt_edit changes by default. */
  textField?: string;
  /** Kinds of work a run does for this node. */
  work: "none" | "local" | "provider" | ((settings: Record<string, unknown>) => "local" | "provider");
}

export const SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536", "1024x1280", "1280x1024", "2048x2048", "2048x1152", "1152x2048"] as const;
/** Subscription only: xhigh and max need an explicitly selected API renderer, which Studio never uses. */
export const QUALITIES = ["low", "medium", "high", "auto"] as const;
export const ROLES = ["subject", "style", "photography", "texture", "composition", "palette", "logo"] as const;
export const PROCESS_OPS = ["remove-background", "upscale", "strip-metadata", "web-export"] as const;
export const STAGES = ["concept", "sketch", "art", "final"] as const;
export const MAX_SLOTS = 40;

const text = z.string().trim().min(1).max(8000);
const short = z.string().trim().min(1).max(400);
const preset = z.string().refine(v => PRESET_IDS.includes(v), v => ({ message: `unknown preset "${v}"${near(v, PRESET_IDS)}` }));
const modifiers = z.array(z.string().refine(v => MODIFIER_IDS.includes(v), v => ({ message: `unknown modifier "${v}"${near(v, MODIFIER_IDS)}` }))).max(12);
const platform = z.string().refine(v => PLATFORM_IDS.includes(v), v => ({ message: `unknown platform "${v}". Platforms: ${PLATFORM_IDS.join(", ")}` }));

export const styleDimsSchema = z.object({
  medium: short, composition: short, subjectDetail: short, setting: short, lighting: short, camera: short,
  color: short, mood: short, detail: short, avoid: z.array(short).max(20), text: z.string().max(400),
}).partial().strict();

/** Shot language: named dimensions that compile onto the preset compiler's prompt dimensions. */
export const SHOT_DIMENSIONS = {
  size: "Shot size: extreme wide, wide, full, medium, close-up, extreme close-up, macro.",
  angle: "Camera angle: eye level, low angle, high angle, overhead, worm's-eye, dutch tilt.",
  lens: "Focal length, e.g. 24mm, 50mm, 85mm, 135mm.",
  aperture: "Aperture and depth of field, e.g. f/1.4 shallow, f/8 deep.",
  key_light: "Key light direction, e.g. from camera left at 45 degrees, top light, backlight.",
  light_ratio: "Key-to-fill contrast, e.g. 2:1 gentle, 8:1 dramatic.",
  light_quality: "Hard or soft light, and its size.",
  light_source: "The motivated source: window, practical lamp, overcast sky, neon sign.",
  palette: "The colours present, e.g. muted sage and cream.",
  color_scheme: "Colour relationship: monochrome, analogous, complementary teal-orange, triadic.",
  time: "Time of day or era: blue hour, noon, golden hour, 1970s.",
  atmosphere: "Air and weather: haze, fog, dust in light shafts, crisp and clear.",
  foreground: "What sits in the foreground layer.",
  midground: "What sits in the midground layer.",
  background: "What sits in the background layer.",
  device: "Composition device: rule of thirds, centred symmetry, leading lines, frame within a frame.",
  medium: "Medium: 35mm film photograph, gouache painting, 3D render, ink line art.",
  texture: "Surface and grain: fine film grain, visible brush strokes, clean vector.",
  grade: "Colour grade: low-contrast pastel, bleach bypass, warm print.",
} as const;
export type ShotKey = keyof typeof SHOT_DIMENSIONS;
export const shotSchema = z.object(Object.fromEntries(Object.keys(SHOT_DIMENSIONS).map(k => [k, short])) as Record<ShotKey, typeof short>).partial().strict();

const lookFields = {
  preset, modifiers, style: styleDimsSchema, shot: shotSchema, brief: creativeBriefSchema,
};
const lookDocs = {
  preset: "Preset id from list_image_presets (e.g. product-studio, hero-3d).",
  modifiers: "Modifier ids layered on the preset.",
  style: "Prompt dimensions: medium, composition, subjectDetail, setting, lighting, camera, color, mood, detail, avoid[], text (literal lettering).",
  shot: "Shot language (see the shot section): size, angle, lens, aperture, key_light, light_ratio, light_quality, light_source, palette, color_scheme, time, atmosphere, foreground, midground, background, device, medium, texture, grade.",
  brief: "Creative brief: purpose, audience, brandName, direction, composition, palette[#hex], mustInclude[], avoid[], preserve[].",
};
export const STYLE_DIMS = ["medium", "composition", "subjectDetail", "setting", "lighting", "camera", "color", "mood", "detail"] as const;
export const SWEEP_DIMS = ["preset", ...STYLE_DIMS.map(d => `style.${d}`), ...Object.keys(SHOT_DIMENSIONS).map(d => `shot.${d}`)];
const sweep = z.object({
  dim: z.string().refine(v => SWEEP_DIMS.includes(v), v => ({ message: `cannot sweep "${v}"${closest(v, SWEEP_DIMS) ? `. Did you mean "${closest(v, SWEEP_DIMS)}"?` : ""} Sweepable: ${SWEEP_DIMS.join(", ")}` })),
  values: z.array(short).min(2).max(8),
}).strict();
const renderFields = {
  size: z.enum(SIZES), quality: z.enum(QUALITIES), format: z.enum(["png", "jpeg", "webp"]),
  transparent: z.boolean(), platform, takes: z.number().int().min(1).max(4),
  reference_role: z.enum(ROLES), proof: z.boolean(), sweep,
};
const renderDocs = {
  size: `One of ${SIZES.join(", ")}. Default: the preset's size, else 1024x1024.`,
  quality: "low (default, drafts), medium, high (finals; the highest the subscription accepts here). xhigh/max are API-only and refused.",
  format: "png (default), jpeg or webp.",
  transparent: "Transparent background (local chroma key on the subscription).",
  platform: "Platform target: native size and safe-area composition.",
  takes: "Images per fan-out slot, 1-4 (default 1). Raising it only renders the missing takes.",
  sweep: 'Vary one look dimension, one slot per value, everything else fixed: {dim:"shot.key_light", values:["from camera left","backlight","top light"]}. dim is preset, style.<dimension> or shot.<dimension>. Needs a single prompt (not a list); 2-8 values. The run sheet is labelled by value.',
  reference_role: `Role for connected reference images that do not carry their own: ${ROLES.join(", ")} (default style).`,
  proof: "Vision proofread of rendered lettering (default on when style.text is set).",
};

const IMG = "image" as const;
const h = (name: string, type: HandleType, multi: boolean, doc: string): HandleSpec => ({ name, type, multi, doc });

export const NODE_SPECS: Record<NodeType, NodeSpec> = {
  prompt: {
    type: "prompt", summary: "A piece of text: a subject, an instruction, or a multi-line list source.",
    inputs: [], outputs: [h("text", "text", true, "The text.")],
    settings: z.object({ text }).strict(), docs: { text: "The text (required)." }, textField: "text", work: "none",
  },
  style: {
    type: "style", summary: "A reusable look: preset, modifiers, prompt dimensions, shot language, brief. Node settings on a generator win over it.",
    inputs: [], outputs: [h("style", "style", true, "The look.")],
    settings: z.object(lookFields).partial().strict(), docs: lookDocs, work: "none",
  },
  list: {
    type: "list", summary: "Fans out: each item becomes its own slot downstream. With a connected text, each item fills {{item}} in it (or is appended).",
    inputs: [h("text", "text", false, "Optional template, or the text to split when items is not set.")],
    outputs: [h("items", "text", true, "One text per item.")],
    settings: z.object({ items: z.array(short).min(1).max(MAX_SLOTS), split: z.enum(["lines", "commas"]) }).partial().strict(),
    docs: { items: "The items (1-40). Omit to split the connected text instead.", split: "How to split connected text when items is omitted: lines (default) or commas." },
    work: "none",
  },
  reference: {
    type: "reference", summary: "An existing image brought into the graph. The file is copied into assets/ so the graph stays portable.",
    inputs: [], outputs: [h("image", IMG, true, "The imported image.")],
    settings: z.object({ path: z.string().trim().min(1), role: z.enum(ROLES), instruction: short }).partial({ role: true, instruction: true }).strict(),
    docs: { path: "Image file: project-relative or absolute. Files outside the project are copied in.", role: `How generators use it: ${ROLES.join(", ")} (default style).`, instruction: "Extra instruction for this reference." },
    work: "local",
  },
  generate: {
    type: "generate", summary: "Text to image through the subscription. One slot per incoming list item, times takes.",
    inputs: [h("prompt", "text", false, "The subject text (or connect a list to fan out)."), h("style", "style", false, "A style node."), h("references", IMG, true, "Reference images (max 16).")],
    outputs: [h("image", IMG, true, "The selected take of each slot.")],
    settings: z.object({ prompt: text, ...lookFields, ...renderFields }).partial().strict(),
    docs: { prompt: "Subject text when no prompt is connected.", ...lookDocs, ...renderDocs }, textField: "prompt", work: "provider",
  },
  edit: {
    type: "edit", summary: "Image to image through the subscription. Edits each incoming image (or each instruction item).",
    inputs: [h("image", IMG, true, "Image(s) to edit; each is edited separately."), h("prompt", "text", false, "The instruction (or a list to fan out)."),
      h("references", IMG, true, "Extra reference images."), h("mask", IMG, false, "PNG mask, same size: transparent = regenerate here.")],
    outputs: [h("image", IMG, true, "The selected take of each slot.")],
    settings: z.object({ instruction: text, ...lookFields, ...renderFields, preserve_unmasked: z.boolean() }).partial().strict(),
    docs: { instruction: "What to change when no prompt is connected.", ...lookDocs, ...renderDocs, preserve_unmasked: "With a mask, keep opaque-mask pixels exactly (default true)." },
    textField: "instruction", work: "provider",
  },
  process: {
    type: "process", summary: "Post-process each incoming image: remove-background, upscale, strip-metadata, web-export.",
    inputs: [h("image", IMG, true, "Image(s) to process.")], outputs: [h("image", IMG, true, "The processed image(s).")],
    settings: z.object({ op: z.enum(PROCESS_OPS), tolerance: z.number().int().min(0).max(180), use_model: z.boolean(), guidance: short, quality: z.enum(QUALITIES), kind: z.enum(["favicon", "og", "hero", "appicon"]) }).partial({ tolerance: true, use_model: true, guidance: true, quality: true, kind: true }).strict(),
    docs: { op: `${PROCESS_OPS.join(" | ")} (required). upscale and remove-background with use_model spend a generation; the rest are local.`, tolerance: "remove-background keyer tolerance 0-180 (default 28).", use_model: "remove-background: re-render the subject on chroma via the model (regenerates detail).", guidance: "upscale: extra guidance.", quality: "upscale quality (default high).", kind: "web-export set: favicon, og, hero, appicon (default og)." },
    work: s => (s.op === "upscale" || (s.op === "remove-background" && s.use_model) ? "provider" : "local"),
  },
  gallery: {
    type: "gallery", summary: "Collects images for review. Picks narrow what it passes on; unpicked, it passes everything.",
    inputs: [h("images", IMG, true, "Images to collect.")], outputs: [h("images", IMG, true, "Picked images, or all collected.")],
    settings: z.object({}).strict(), docs: {}, work: "none",
  },
  handoff: {
    type: "handoff", summary: "Turns approved images into a build package for a coding agent: handoff.md, mocks, measured colours, cut-outs, lineage.",
    inputs: [h("images", IMG, true, "Candidate images; only approved ones are packaged."), h("brief", "text", false, "Optional intent text.")],
    outputs: [h("package", "package", true, "The package.")],
    settings: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), intent: text, target: short, must_match: z.array(short).max(20), flexible: z.array(short).max(20) }).partial().strict(),
    docs: { name: "Package folder name under handoff/ (default: node id).", intent: "What is being built and why (or connect a brief).", target: "What it becomes, e.g. \"Next.js landing hero, 1440px\".", must_match: "What the build must match.", flexible: "What the build may change." },
    textField: "intent", work: "local",
  },
  implementation: {
    type: "implementation", summary: "A screenshot of the coded result, tied to a handoff. Running it writes a side-by-side comparison sheet.",
    inputs: [h("handoff", "package", false, "The handoff it implements.")], outputs: [h("image", IMG, true, "The screenshot.")],
    settings: z.object({ screenshot: z.string().trim().min(1), viewport: short }).partial().strict(),
    docs: { screenshot: "Screenshot file (PNG), project-relative or absolute.", viewport: "Viewport it was taken at, e.g. 1440x900." },
    work: "local",
  },
  canon: {
    type: "canon", summary: "A named character, place, product or look from the project canon (_canon/), usable from any graph. Connect it to a generator's or edit's references: its images go in with their roles and its locked description is added to the prompt word for word.",
    inputs: [], outputs: [h("image", IMG, true, "The entry's reference images.")],
    settings: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), project: z.string().trim().min(1) }).partial({ project: true }).strict(),
    docs: { name: "Canon entry name (save one with the canon_save op).", project: "Another project to read the entry from, relative to this one or absolute (stored relative). Default: this project." },
    work: "local",
  },
  note: {
    type: "note", summary: "A comment or feedback attached to a node (settings.on), with author. Not part of the data flow.",
    inputs: [], outputs: [],
    settings: z.object({ text, on: z.string(), author: short, resolved: z.boolean() }).partial({ on: true, author: true, resolved: true }).strict(),
    docs: { text: "The note.", on: "Node id it is about.", author: "Who wrote it.", resolved: "Mark addressed." },
    textField: "text", work: "none",
  },
};

export const NODE_TYPES = Object.keys(NODE_SPECS) as NodeType[];

export function workOf(type: NodeType, settings: Record<string, unknown>): "none" | "local" | "provider" {
  const w = NODE_SPECS[type].work;
  return typeof w === "function" ? w(settings) : w;
}

// ---------------------------------------------------------------- suggestions + validation

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length]![b.length]!;
}

export function closest(value: string, pool: readonly string[]): string | undefined {
  let best: string | undefined, bestD = Infinity;
  for (const p of pool) {
    const dd = p.includes(value) || value.includes(p) ? 1 : distance(value.toLowerCase(), p.toLowerCase());
    if (dd < bestD) { bestD = dd; best = p; }
  }
  return best && bestD <= Math.max(2, Math.floor(value.length / 3)) ? best : undefined;
}

function near(v: string, pool: readonly string[]): string {
  const c = closest(v, pool);
  return c ? `. Did you mean "${c}"?` : ". See list_image_presets for valid ids.";
}

export function typeIssue(type: string, path: string): Issue | null {
  if ((NODE_TYPES as string[]).includes(type)) return null;
  const c = closest(type, NODE_TYPES);
  return { path, message: `unknown node type "${type}"`, fix: `${c ? `Did you mean "${c}"? ` : ""}Types: ${NODE_TYPES.join(", ")}.` };
}

function nestedKeys(parent: string): string[] {
  if (parent === "shot") return Object.keys(SHOT_DIMENSIONS);
  if (parent === "style") return [...STYLE_DIMS];
  if (parent === "brief") return Object.keys((creativeBriefSchema as unknown as { shape?: object }).shape ?? {});
  return [];
}

/** Validate settings strictly, translating zod errors into messages that name the fix. */
export function validateSettings(type: NodeType, settings: unknown, path: string): Issue[] {
  const spec = NODE_SPECS[type];
  const parsed = spec.settings.safeParse(settings ?? {});
  if (parsed.success) return [];
  const valid = Object.keys(spec.docs);
  return parsed.error.issues.map(i => {
    const at = [path, ...i.path].join(".");
    if (i.code === "unrecognized_keys" && i.path.length) {
      // A typo inside shot/style/brief: name the bad key and list that object's own keys.
      const parent = String(i.path[0]);
      const keys = nestedKeys(parent);
      const sugg = i.keys.map(k => [k, closest(k, keys)] as const).filter(([, c]) => c).map(([k, c]) => `Did you mean "${parent}.${c}" (not "${k}")? `).join("");
      return { path: at, message: `unknown ${parent} key${i.keys.length > 1 ? "s" : ""} ${i.keys.map(k => `"${parent}.${k}"`).join(", ")}`,
        fix: `${sugg}${parent === "shot" ? "Shot dimensions" : `Valid ${parent} keys`}: ${keys.join(", ")}.` };
    }
    if (i.code === "unrecognized_keys") {
      return { path: at, message: `unknown setting${i.keys.length > 1 ? "s" : ""} ${i.keys.map(k => `"${k}"`).join(", ")} for ${type}`,
        fix: `${i.keys.map(k => closest(k, valid)).filter(Boolean).map(c => `Did you mean "${c}"? `).join("")}Valid ${type} settings: ${valid.join(", ") || "(none)"}.` };
    }
    if (i.code === "invalid_enum_value") return { path: at, message: `invalid value ${JSON.stringify(i.received)}`, fix: `Use one of: ${i.options.join(", ")}.` };
    if (i.code === "invalid_type" && i.received === "undefined") return { path: at, message: `missing required setting "${i.path.join(".")}"`, fix: spec.docs[String(i.path[0])] ?? "" };
    return { path: at, message: i.message, fix: spec.docs[String(i.path[0])] };
  });
}
