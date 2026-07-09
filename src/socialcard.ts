// One-call premium social card: generate a TEXT-FREE plate with the model (steered to leave clean
// space exactly where the type will sit), then set the headline/subline/logo deterministically via
// the compositor. The model never touches a single glyph — spelling, fonts and the logo are exact
// by construction, so no proof-loop is needed.

import { extname } from "node:path";
import type { GenerateOutput } from "./generate.js";
import { generateImage } from "./generate.js";
import { getPlatform } from "./platforms.js";
import { composeOverlay, type LogoOverlay, type OverlayPosition, type TextBlock } from "./typeset.js";

export interface SocialCardInput {
  /** The headline copy — set verbatim by the compositor. */
  headline: string;
  /** One word/phrase of the headline inked in the accent color (the editorial accent). */
  accentWord?: string;
  /** Accent hex. Defaults to the brand palette's dominant color (style refs), else oxblood. */
  accentColor?: string;
  subline?: string;
  /** Where the headline block sits (default top-left); the plate's art is steered to the opposite zone. */
  headlinePosition?: OverlayPosition;
  headlineFont?: string;
  sublineFont?: string;
  headlineColor?: string;
  sublineColor?: string;
  uppercase?: boolean;
  logo?: LogoOverlay;
  /** Platform target (default instagram-feed): native size + safe areas for plate AND overlays. */
  platform?: string;
  /** What the plate depicts. Default: quiet premium material texture (social-bg-plate's language). */
  plateSubject?: string;
  /** Plate preset (default social-bg-plate; concept-hero for a photographic hero object). */
  platePreset?: string;
  styleReference?: string[];
  quality?: "auto" | "low" | "medium" | "high";
  outputPath?: string;
  backend?: string;
}

export interface SocialCardResult {
  path: string;
  platePath: string;
  width: number;
  height: number;
  palette?: string[];
  notes: string[];
}

const DEFAULT_ACCENT = "#8b0f24"; // wine ink — matches the social presets' art direction

/** Split a position keyword into vertical/horizontal halves ("center" → center/center). */
function splitPos(pos: OverlayPosition): [string, string] {
  const parts = pos.split("-");
  return parts.length === 2 ? (parts as [string, string]) : ["center", "center"];
}

/** Which third of the canvas the plate's art should occupy, given where the type will sit. */
function artZoneFor(pos: OverlayPosition): string {
  const [v, h] = splitPos(pos);
  const vOpp = v === "top" ? "lower" : v === "bottom" ? "upper" : "lower";
  const hOpp = h === "left" ? "right" : h === "right" ? "left" : "right";
  return `${vOpp} ${hOpp}`;
}

/** The subline sits in the vertical half opposite the headline (center headline → bottom). */
export function sublinePosFor(headlinePos: OverlayPosition): OverlayPosition {
  const [v, h] = splitPos(headlinePos);
  return `${v === "bottom" ? "top" : "bottom"}-${h}` as OverlayPosition;
}

/** Plate path for an outputPath: file → `<stem>-plate.png`; directory → timestamped inside it. */
export function platePathFor(outputPath: string | undefined): string | undefined {
  if (!outputPath || /[\\/]$/.test(outputPath)) return outputPath; // undefined/dir pass through
  const e = extname(outputPath);
  return `${e ? outputPath.slice(0, -e.length) : outputPath}-plate.png`;
}

export async function createSocialCard(input: SocialCardInput): Promise<SocialCardResult> {
  const platform = input.platform ?? "instagram-feed";
  getPlatform(platform); // validate BEFORE spending a generation on the plate
  const headlinePos = input.headlinePosition ?? "top-left";
  const zone = artZoneFor(headlinePos);

  // 1. The plate: text-free, art steered away from where the type will go.
  const plate: GenerateOutput = await generateImage({
    subject: input.plateSubject ?? "a quiet premium material study",
    preset: input.platePreset ?? "social-bg-plate",
    platform,
    styleReference: input.styleReference,
    style: {
      composition:
        `restrained art confined to the ${zone} third of the canvas; the ${headlinePos.replace("-", " ")} ` +
        `region and its surroundings stay completely clean, calm, empty — reserved for a headline overlay`,
    },
    quality: input.quality ?? "high",
    format: "png",
    proof: false, // the plate is text-free; the type never touches the model
    backend: input.backend,
    // Plate lands next to the final card so both stay inspectable/reusable.
    outputPath: platePathFor(input.outputPath),
  });

  // 2. The type + logo, deterministic.
  const accent = input.accentColor ?? plate.palette?.[0] ?? DEFAULT_ACCENT;
  const blocks: TextBlock[] = [
    {
      text: input.headline,
      position: headlinePos,
      fontFamily: input.headlineFont,
      fontWeight: 800,
      color: input.headlineColor ?? "#1c1917",
      accentWord: input.accentWord,
      accentColor: input.accentWord ? accent : undefined,
      uppercase: input.uppercase ?? true,
      letterSpacing: 1,
    },
  ];
  if (input.subline) {
    blocks.push({
      text: input.subline,
      position: sublinePosFor(headlinePos),
      fontFamily: input.sublineFont ?? input.headlineFont,
      fontWeight: 500,
      color: input.sublineColor ?? accent,
    });
  }

  // A directory-shaped outputPath belongs to the plate (timestamped inside); the final card then
  // derives its default `<plate>-final.png` next to it. A file path is used as-is (+ .png if bare).
  const isDir = input.outputPath ? /[\\/]$/.test(input.outputPath) : false;
  const finalPath = input.outputPath && !isDir ? (extname(input.outputPath) ? input.outputPath : `${input.outputPath}.png`) : undefined;
  const composed = await composeOverlay({
    imagePath: plate.path,
    blocks,
    logo: input.logo,
    platform,
    outputPath: finalPath,
  });

  return {
    path: composed.path,
    platePath: plate.path,
    width: composed.width,
    height: composed.height,
    palette: plate.palette,
    notes: composed.notes,
  };
}
