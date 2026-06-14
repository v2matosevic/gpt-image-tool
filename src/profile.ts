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
  /** Path(s) to a logo/hero/brand image; every generation matches its look (strongest anchor). */
  styleReference?: string[];
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

/**
 * Locate the active profile: explicit env path, then walk up from `startDir` (where the asset is
 * being written — this is what makes a long-lived, user-scoped MCP server find the RIGHT project's
 * profile rather than its launch directory), then CLAUDE_PROJECT_DIR, then cwd.
 */
export function findProfilePath(startDir?: string): string | null {
  const explicit = process.env.GPT_IMAGE_PROFILE?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  const roots = [startDir, process.env.CLAUDE_PROJECT_DIR?.trim(), process.cwd()].filter(Boolean) as string[];
  for (const root of roots) {
    const found = findUp(PROFILE_FILENAME, root);
    if (found) return found;
  }
  return null;
}

/**
 * Discover + parse the project profile for a context (the directory the asset is being written to).
 * Re-read every call — deliberately NOT cached: a few `existsSync` + a tiny `readFileSync` is
 * sub-millisecond next to a multi-second generation, and it means a long-lived MCP server always
 * sees the right project's *current* profile (no stale entry, no unbounded cache to leak). Returns
 * null if none / unreadable.
 */
export function loadProfile(startDir?: string): { path: string; profile: BrandProfile } | null {
  const path = findProfilePath(startDir);
  if (!path) return null;
  try {
    return { path, profile: JSON.parse(readFileSync(path, "utf8")) as BrandProfile };
  } catch (e) {
    // Surface to stderr but don't fail generation over a malformed profile.
    console.error(`[gpt-image] ignoring malformed ${PROFILE_FILENAME} at ${path}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** Kept for test compatibility — there is no longer a cache to reset. */
export function resetProfileCache(): void {}
