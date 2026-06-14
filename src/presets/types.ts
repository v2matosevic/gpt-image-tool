// The preset / prompt-compiler data model. A preset is a curated bundle of prompt "dimensions"
// for a use case (e.g. product studio shot); the compiler weaves a subject + overrides + modifiers
// into the natural-language prose that gpt-image-1 responds to best.

import type { ImageBackground, ImageFormat, ImageQuality, ImageSize } from "../providers/types.js";

export type PresetCategory =
  | "photography"
  | "illustration"
  | "design"
  | "render3d"
  | "specialized";

/**
 * Orthogonal dimensions of an image brief, composed in a fixed optimal order. Every field is a
 * short natural-language phrase (not keyword soup) — gpt-image-1 follows prose instructions.
 */
export interface PromptDims {
  /** The form: "professional product photograph", "flat vector illustration", "isometric 3D render". */
  medium?: string;
  /** Framing / angle / layout: "centered hero shot, slight high angle", "flat-lay, top-down". */
  composition?: string;
  /** Material / finish / wardrobe applied to the subject: "brushed aluminium, matte finish". */
  subjectDetail?: string;
  /** Background / environment: "seamless light-grey studio backdrop". */
  setting?: string;
  /** Lighting: "soft three-point studio lighting, large softbox key, subtle rim light". */
  lighting?: string;
  /** Camera / lens / film, mostly for photography: "100mm macro, f/8, tack-sharp". */
  camera?: string;
  /** Color palette / grade: "muted earthy palette, warm grade". */
  color?: string;
  /** Atmosphere / feel: "premium, clean, commercial". */
  mood?: string;
  /** Quality / detail tags: "ultra-detailed, crisp textures, no noise". */
  detail?: string;
}

/** Ordered keys for composition. Subject is injected after `medium`. */
export const DIM_ORDER: (keyof PromptDims)[] = [
  "medium",
  "composition",
  "subjectDetail",
  "setting",
  "lighting",
  "camera",
  "color",
  "mood",
  "detail",
];

export interface Preset {
  id: string;
  category: PresetCategory;
  title: string;
  description: string;
  recommended: { size: ImageSize; quality: ImageQuality; format: ImageFormat };
  /** Default alpha handling for this style (e.g. logos/stickers → "transparent"). */
  background?: ImageBackground;
  dims: PromptDims;
  /** Things to steer away from; emitted as an "Avoid: …" clause. */
  avoid?: string[];
}

export type ModifierKind = "lighting" | "mood" | "color" | "quality" | "angle";

/** A composable overlay (e.g. "golden-hour" lighting) that merges its dims onto any preset. */
export interface Modifier {
  id: string;
  kind: ModifierKind;
  title: string;
  dims: Partial<PromptDims>;
  avoid?: string[];
}
