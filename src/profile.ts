// Project brand profile: a `.gptimage.json` at the project root supplies defaults (preset, brand
// palette, global avoid list, output dir, …) so every asset for a project stays on-brand without
// re-specifying. Per-call arguments always override the profile.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import type { ImageBackground, ImageFormat, ImageQuality, ImageSize } from "./providers/types.js";

export const PROFILE_FILENAME = ".gptimage.json";

export interface ProfileStyle {
  medium?: string;
  composition?: string;
  subjectDetail?: string;
  setting?: string;
  lighting?: string;
  camera?: string;
  color?: string;
  mood?: string;
  detail?: string;
  avoid?: string[];
  text?: string;
}

export interface BrandProfile {
  preset?: string;
  modifiers?: string[];
  style?: ProfileStyle;
  size?: ImageSize;
  quality?: ImageQuality;
  format?: ImageFormat;
  background?: ImageBackground;
  /** Default directory to drop generated assets into. */
  outputDir?: string;
  backend?: string;
}

function findUp(filename: string, start: string): string | null {
  let dir = start;
  for (;;) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || parsePath(dir).root === dir) return null;
    dir = parent;
  }
}

/** Locate the active profile: explicit env path, then walk up from CLAUDE_PROJECT_DIR, then cwd. */
export function findProfilePath(): string | null {
  const explicit = process.env.GPT_IMAGE_PROFILE?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  const roots = [process.env.CLAUDE_PROJECT_DIR?.trim(), process.cwd()].filter(Boolean) as string[];
  for (const root of roots) {
    const found = findUp(PROFILE_FILENAME, root);
    if (found) return found;
  }
  return null;
}

let cache: { path: string; profile: BrandProfile } | null | undefined;

/** Load + parse the project profile (cached per process). Returns null if none / unreadable. */
export function loadProfile(): { path: string; profile: BrandProfile } | null {
  if (cache !== undefined) return cache;
  const path = findProfilePath();
  if (!path) return (cache = null);
  try {
    const profile = JSON.parse(readFileSync(path, "utf8")) as BrandProfile;
    return (cache = { path, profile });
  } catch (e) {
    // Surface to stderr but don't fail generation over a malformed profile.
    console.error(`[gpt-image] ignoring malformed ${PROFILE_FILENAME} at ${path}: ${e instanceof Error ? e.message : e}`);
    return (cache = null);
  }
}

/** Test seam: drop the cached profile. */
export function resetProfileCache(): void {
  cache = undefined;
}
