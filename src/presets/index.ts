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

// A concise how-to-use-this-well guide so a fresh agent uses the toolset expertly.
const PLAYBOOK = [
  "Pick a preset from this catalog that matches the goal, then call generate_image with { subject, preset }. Add `modifiers` (lighting/mood/color/angle) and `style` (override any single dimension) to fine-tune.",
  "Transparent assets (logos, icons, stickers, 3D hero elements): set transparent:true (or use a preset whose background is transparent). Output is a real RGBA PNG that composites onto any page.",
  "Consistency: drop a .gptimage.json brand profile at the project root (preset, brand color/style, styleReference to a logo/hero image, outputDir) — every generation inherits it. Or pass style_reference per call to match an existing image. Use `series: N` for a coherent set (vs `count: N` for independent variations).",
  "Web deliverables: use export_web_assets({ image_path | <generate>, kind }) to slice one image into favicons (16-512 + .ico), OG/social cards (1200x630…), responsive hero widths, or app-icon sets — correctly sized & cropped. Generate the source at high quality first (2K), then export.",
  "Edit/iterate: edit_image to change an existing image (instruction; add mask_path for inpainting a region). upscale_image to enhance to ~2K. remove_background to cut out any image (best on clean backgrounds). from_image reloads a prior image's settings to reproduce or tweak it.",
  "Quality: prefer specific direction over generic words (the presets already do this). For text in an image use the `style.text` field (quoted, rendered verbatim) — the vision proof-loop then auto-verifies spelling/diacritics and regenerates with feedback; read the ✓/✗ verdict in the result. Set GPT_IMAGE_INLINE=1 to also receive the image inline so you can see and judge it.",
  "Platform posts: pass `platform` (instagram-feed/-story, tiktok, x-post, linkedin-post, og-card, youtube-thumbnail, pinterest-pin) instead of size — native resolution + composition kept out of the platform's UI safe areas.",
  "Text that must be EXACT (long copy, logos, heavy diacritics): generate a text-free plate (social-bg-plate or concept-hero preset), then compose_overlay sets the headline in a real font and places the real logo file — correct by construction, no proofing needed.",
];

/** The structured catalog for `list_image_presets`: presets grouped + the modifier list. */
export function catalog(category?: PresetCategory): {
  presets: CatalogEntry[];
  modifiers: { id: string; kind: string; title: string }[];
  categories: PresetCategory[];
  usage: string;
  playbook: string[];
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
    playbook: PLAYBOOK,
  };
}
