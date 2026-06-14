// Aggregates every preset + modifier into lookup tables. Adding a style = add it to a lib/* file.

import type { Modifier, Preset, PresetCategory } from "./types.js";
import { photography } from "./lib/photography.js";
import { illustration } from "./lib/illustration.js";
import { design } from "./lib/design.js";
import { render3d } from "./lib/render3d.js";
import { specialized } from "./lib/specialized.js";
import { webdev } from "./lib/webdev.js";
import { modifiers as MODIFIER_LIST } from "./lib/modifiers.js";

export const ALL_PRESETS: Preset[] = [
  ...photography,
  ...illustration,
  ...design,
  ...render3d,
  ...specialized,
  ...webdev,
];

export const ALL_MODIFIERS: Modifier[] = MODIFIER_LIST;

export const CATEGORIES: PresetCategory[] = ["photography", "illustration", "design", "render3d", "specialized", "webdev"];

function indexBy<T extends { id: string }>(items: T[], label: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const it of items) {
    if (map.has(it.id)) throw new Error(`Duplicate ${label} id: "${it.id}"`);
    map.set(it.id, it);
  }
  return map;
}

const PRESET_BY_ID = indexBy(ALL_PRESETS, "preset");
const MODIFIER_BY_ID = indexBy(ALL_MODIFIERS, "modifier");

export const PRESET_IDS: string[] = ALL_PRESETS.map((p) => p.id);
export const MODIFIER_IDS: string[] = ALL_MODIFIERS.map((m) => m.id);

export function getPreset(id: string): Preset | undefined {
  return PRESET_BY_ID.get(id);
}

export function getModifier(id: string): Modifier | undefined {
  return MODIFIER_BY_ID.get(id);
}

export function listPresets(category?: PresetCategory): Preset[] {
  return category ? ALL_PRESETS.filter((p) => p.category === category) : ALL_PRESETS;
}
