// The prompt compiler: merges a subject + preset + modifiers + overrides into the single
// natural-language prompt gpt-image-1 responds to best, and resolves size/quality/format.
// Pure and dependency-free (takes already-resolved preset/modifier objects) so it's unit-testable.

import type { ImageBackground, ImageFormat, ImageQuality, ImageSize } from "../providers/types.js";
import type { Modifier, Preset, PromptDims } from "./types.js";

export interface PromptOverrides extends Partial<PromptDims> {
  /** Extra things to steer away from, merged with the preset's avoid list. */
  avoid?: string[];
  /** Literal text that should appear rendered in the image. */
  text?: string;
}

export interface ComposeInput {
  /** The thing to depict. Required unless `rawPrompt` is given. */
  subject?: string;
  /** A fully-formed prompt that bypasses dimension composition (power-user escape hatch). */
  rawPrompt?: string;
  preset?: Preset;
  modifiers?: Modifier[];
  overrides?: PromptOverrides;
  size?: ImageSize;
  quality?: ImageQuality;
  format?: ImageFormat;
  background?: ImageBackground;
}

export interface Composed {
  prompt: string;
  size: ImageSize;
  quality: ImageQuality;
  format: ImageFormat;
  background: ImageBackground;
  presetId?: string;
  modifierIds: string[];
}

const DEFAULTS = { size: "1024x1024" as ImageSize, quality: "auto" as ImageQuality, format: "png" as ImageFormat };

function cap(s: string): string {
  const t = s.trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

/** Strip a trailing period so clauses join cleanly, then we re-add sentence breaks. */
function clause(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.trim().replace(/\.\s*$/, "");
  return t || null;
}

function mergeDims(preset: Preset | undefined, modifiers: Modifier[], overrides: PromptOverrides | undefined): PromptDims {
  const out: PromptDims = { ...(preset?.dims ?? {}) };
  for (const m of modifiers) Object.assign(out, m.dims);
  if (overrides) {
    const { avoid: _a, text: _t, ...dimOverrides } = overrides;
    Object.assign(out, dimOverrides);
  }
  return out;
}

function mergeAvoid(preset: Preset | undefined, modifiers: Modifier[], overrides: PromptOverrides | undefined): string[] {
  const all = [...(preset?.avoid ?? []), ...modifiers.flatMap((m) => m.avoid ?? []), ...(overrides?.avoid ?? [])];
  return [...new Set(all.map((s) => s.trim()).filter(Boolean))];
}

export function compose(input: ComposeInput): Composed {
  const modifiers = input.modifiers ?? [];
  const dims = mergeDims(input.preset, modifiers, input.overrides);
  const avoid = mergeAvoid(input.preset, modifiers, input.overrides);
  const text = input.overrides?.text?.trim();

  const size = input.size ?? input.preset?.recommended.size ?? DEFAULTS.size;
  const quality = input.quality ?? input.preset?.recommended.quality ?? DEFAULTS.quality;
  let format = input.format ?? input.preset?.recommended.format ?? DEFAULTS.format;
  let background: ImageBackground = input.background ?? input.preset?.background ?? "auto";
  // Transparency needs alpha; silently promote jpeg → png so the request stays valid.
  if (background === "transparent" && format === "jpeg") format = "png";

  let prompt: string;
  if (input.rawPrompt?.trim()) {
    prompt = input.rawPrompt.trim();
  } else {
    const subject = input.subject?.trim();
    if (!subject) throw new Error("compose requires `subject` (or a `rawPrompt`).");

    // Lead sentence: medium + subject + subject detail.
    const lead = dims.medium ? `${cap(dims.medium)} of ${subject}` : cap(subject);
    const leadFull = clause(dims.subjectDetail) ? `${lead}, ${clause(dims.subjectDetail)}` : lead;

    // Remaining dimensions become their own clauses, in the canonical order.
    const tail = [
      clause(dims.composition),
      clause(dims.setting),
      clause(dims.lighting),
      clause(dims.camera),
      clause(dims.color),
      clause(dims.mood),
      clause(dims.detail),
    ].filter((c): c is string => Boolean(c));

    prompt = [cap(leadFull), ...tail.map(cap)].join(". ") + ".";
  }

  if (!/[.!?]$/.test(prompt.trim())) prompt = prompt.trim() + ".";
  if (text) prompt += ` The image includes the text "${text}", rendered clearly and legibly.`;
  if (avoid.length) prompt += ` Avoid: ${avoid.join(", ")}.`;

  return {
    prompt: prompt.replace(/\s+/g, " ").trim(),
    size,
    quality,
    format,
    background,
    presetId: input.preset?.id,
    modifierIds: modifiers.map((m) => m.id),
  };
}
