// Social/web platform targets: each maps to the nearest NATIVE model size (never a post-crop) plus
// a safe-area composition clause appended to the prompt, so critical content isn't hidden under
// platform UI (story progress bars, TikTok action rail, YT timestamp) or lost to grid crops.

import type { ImageSize } from "./providers/types.js";

export interface SafeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PlatformTarget {
  id: string;
  title: string;
  size: ImageSize;
  /** Appended to the compiled prompt as a hard composition constraint. */
  clause: string;
  /** Human note surfaced in the tool result (what to check before publishing). */
  note: string;
  /** Fraction of each edge covered by platform UI — the compositor keeps overlays out of it. */
  safeInsets?: Partial<SafeInsets>;
}

export const PLATFORMS: PlatformTarget[] = [
  {
    id: "instagram-feed",
    title: "Instagram / Facebook feed post (4:5)",
    size: "1024x1280",
    clause:
      "Compose for a 4:5 Instagram feed post: keep all text and critical elements comfortably inside " +
      "the central area, and keep the middle square of the frame self-sufficient (the profile grid " +
      "shows a center 1:1 crop).",
    note: "Feed shows 4:5; the profile grid center-crops to 1:1 — check both.",
  },
  {
    id: "instagram-story",
    title: "Instagram Story / Reel (9:16)",
    size: "1152x2048",
    clause:
      "Compose for a 9:16 Instagram story: the top 10% and bottom 12% of the frame are covered by " +
      "platform UI, so keep ALL text, faces and critical elements inside the central 78% vertical band.",
    note: "Top ~10% (username bar) and bottom ~12% (reply box) are covered by UI.",
    safeInsets: { top: 0.1, bottom: 0.12 },
  },
  {
    id: "tiktok",
    title: "TikTok (9:16)",
    size: "1152x2048",
    clause:
      "Compose for a 9:16 TikTok frame: the right 14% (action rail), bottom 18% (caption block) and " +
      "top 8% are covered by platform UI — keep all text and critical elements in the safe center-left zone.",
    note: "Right ~14% action rail + bottom ~18% caption are covered by UI.",
    safeInsets: { top: 0.08, right: 0.14, bottom: 0.18 },
  },
  {
    id: "x-post",
    title: "X / Twitter post (16:9)",
    size: "2048x1152",
    clause:
      "Compose for a 16:9 X (Twitter) timeline card: strong focal point readable at small size, " +
      "text large and inside the central 90% of the frame.",
    note: "Timeline may slightly round corners; keep content off the extreme edges.",
  },
  {
    id: "linkedin-post",
    title: "LinkedIn feed post (4:5 portrait)",
    size: "1024x1280",
    clause:
      "Compose for a 4:5 LinkedIn feed image: professional, generous margins, all text comfortably " +
      "inside the central area and legible on a phone at feed size.",
    note: "4:5 portrait takes the most LinkedIn feed real estate; check phone legibility.",
  },
  {
    id: "og-card",
    title: "Open Graph / link-preview card (16:9)",
    size: "2048x1152",
    clause:
      "Compose for a link-preview (Open Graph) card that will be center-cropped to 1.91:1: keep all " +
      "text and critical elements inside the central 84% vertical band, bold and legible at thumbnail size.",
    note: "Most platforms crop OG to 1.91:1 — run export_web_assets kind:'og' for exact sizes.",
  },
  {
    id: "youtube-thumbnail",
    title: "YouTube thumbnail (16:9)",
    size: "2048x1152",
    clause:
      "Compose as a YouTube thumbnail: one dominant focal element, very large high-contrast type if " +
      "any, and keep the bottom-right corner clear (the duration badge covers it).",
    note: "Bottom-right corner is covered by the duration badge.",
    safeInsets: { right: 0.05, bottom: 0.12 },
  },
  {
    id: "pinterest-pin",
    title: "Pinterest pin (2:3)",
    size: "1024x1536",
    clause:
      "Compose for a 2:3 Pinterest pin: vertical flow, all text inside the central area, and keep the " +
      "bottom-right corner clear of critical content.",
    note: "2:3 is Pinterest's preferred ratio; bottom-right gets a visit icon overlay.",
    safeInsets: { right: 0.08, bottom: 0.08 },
  },
];

const BY_ID = new Map(PLATFORMS.map((p) => [p.id, p]));
export const PLATFORM_IDS: string[] = PLATFORMS.map((p) => p.id);

export function getPlatform(id: string): PlatformTarget {
  const p = BY_ID.get(id.trim().toLowerCase());
  if (!p) throw new Error(`Unknown platform "${id}". Available: ${PLATFORM_IDS.join(", ")}`);
  return p;
}
