// Public surface for the preset engine: resolve ids → objects, compile a prompt, and produce the
// catalog the MCP `list_image_presets` tool returns.

import type { ImageBackground, ImageFormat, ImageQuality, ImageSize } from "../providers/types.js";
import { compose, type Composed, type PromptOverrides } from "./compile.js";
import { ALL_MODIFIERS, ALL_PRESETS, CATEGORIES, getModifier, getPreset, listPresets, MODIFIER_IDS, PRESET_IDS } from "./registry.js";
import type { Modifier, Preset, PresetCategory } from "./types.js";

export { ALL_PRESETS, ALL_MODIFIERS, CATEGORIES, getPreset, getModifier, listPresets, MODIFIER_IDS, PRESET_IDS };
export type { Preset, Modifier, PresetCategory, Composed, PromptOverrides };

export interface BuildRequest {
  subject?: string;
  rawPrompt?: string;
  preset?: string;
  modifiers?: string[];
  overrides?: PromptOverrides;
  size?: ImageSize;
  quality?: ImageQuality;
  format?: ImageFormat;
  background?: ImageBackground;
}

function suggest(id: string, pool: string[]): string {
  const near = pool.filter((p) => p.includes(id) || id.includes(p)).slice(0, 5);
  return near.length ? ` Did you mean: ${near.join(", ")}?` : ` Available: ${pool.slice(0, 12).join(", ")}…`;
}

/** Resolve preset/modifier ids and compile the final prompt + settings. Throws on unknown ids. */
export function build(req: BuildRequest): Composed {
  let preset: Preset | undefined;
  if (req.preset) {
    preset = getPreset(req.preset);
    if (!preset) throw new Error(`Unknown preset "${req.preset}".${suggest(req.preset, ALL_PRESETS.map((p) => p.id))}`);
  }
  const modifiers: Modifier[] = [];
  for (const mid of req.modifiers ?? []) {
    const m = getModifier(mid);
    if (!m) throw new Error(`Unknown modifier "${mid}".${suggest(mid, ALL_MODIFIERS.map((x) => x.id))}`);
    modifiers.push(m);
  }
  return compose({
    subject: req.subject,
    rawPrompt: req.rawPrompt,
    preset,
    modifiers,
    overrides: req.overrides,
    size: req.size,
    quality: req.quality,
    format: req.format,
    background: req.background,
  });
}

export interface CatalogEntry {
  id: string;
  category: PresetCategory;
  title: string;
  description: string;
  recommended: Preset["recommended"];
  tunable: string[];
}

const TUNABLE = ["medium", "composition", "subjectDetail", "setting", "lighting", "camera", "color", "mood", "detail"];

/** The structured catalog for `list_image_presets`: presets grouped + the modifier list. */
export function catalog(category?: PresetCategory): {
  presets: CatalogEntry[];
  modifiers: { id: string; kind: string; title: string }[];
  categories: PresetCategory[];
  usage: string;
} {
  const presets = listPresets(category).map((p) => ({
    id: p.id,
    category: p.category,
    title: p.title,
    description: p.description,
    recommended: p.recommended,
    tunable: TUNABLE,
  }));
  return {
    presets,
    modifiers: ALL_MODIFIERS.map((m) => ({ id: m.id, kind: m.kind, title: m.title })),
    categories: CATEGORIES,
    usage:
      "Call generate_image with { subject, preset, modifiers?, style? }. `subject` is what to depict; " +
      "`preset` picks a curated style; `modifiers` layer lighting/mood/color/quality/angle; `style` overrides " +
      "any individual dimension (e.g. {\"setting\":\"dark walnut table\"}). Omit preset and pass a raw `prompt` for full manual control.",
  };
}
