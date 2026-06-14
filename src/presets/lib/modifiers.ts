import type { Modifier } from "../types.js";

// Composable overlays. Each merges its dims onto the chosen preset (modifiers apply in order,
// after the preset and before explicit overrides). Orthogonal to style — layer freely.
export const modifiers: Modifier[] = [
  // --- lighting ---
  { id: "golden-hour", kind: "lighting", title: "Golden hour", dims: { lighting: "warm golden-hour sunlight, long soft shadows, gentle lens flare" } },
  { id: "blue-hour", kind: "lighting", title: "Blue hour", dims: { lighting: "cool blue-hour twilight, soft ambient glow, balanced artificial accents" } },
  { id: "studio-softbox", kind: "lighting", title: "Studio softbox", dims: { lighting: "controlled studio softbox lighting, soft even key with subtle fill and rim" } },
  { id: "dramatic-rim", kind: "lighting", title: "Dramatic rim light", dims: { lighting: "low-key dramatic lighting, strong rim light separating the subject from a dark background" } },
  { id: "neon", kind: "lighting", title: "Neon glow", dims: { lighting: "vivid neon lighting with colorful glow and reflections" } },
  { id: "backlit", kind: "lighting", title: "Backlit / silhouette", dims: { lighting: "strong backlight creating a glowing rim and atmospheric haze" } },

  // --- mood / atmosphere ---
  { id: "cinematic", kind: "mood", title: "Cinematic", dims: { mood: "cinematic and dramatic", color: "filmic color grade with rich contrast", detail: "anamorphic depth, subtle film grain, shallow focus" } },
  { id: "minimal", kind: "mood", title: "Minimal / clean", dims: { mood: "calm, minimal and uncluttered", setting: "simple clean background with generous negative space" } },
  { id: "moody-dark", kind: "mood", title: "Moody / dark", dims: { mood: "moody, atmospheric and intimate", lighting: "low-key shadowy lighting with selective highlights" } },
  { id: "vibrant", kind: "mood", title: "Vibrant / energetic", dims: { mood: "bright, energetic and lively", color: "vivid saturated punchy colors" } },
  { id: "dreamy", kind: "mood", title: "Dreamy / ethereal", dims: { mood: "soft, dreamy and ethereal", lighting: "hazy diffused glow, soft bloom", detail: "gentle soft focus, delicate atmosphere" } },

  // --- color grade ---
  { id: "warm-grade", kind: "color", title: "Warm grade", dims: { color: "warm color grade, golden tones, cozy palette" } },
  { id: "cool-grade", kind: "color", title: "Cool grade", dims: { color: "cool color grade, blue-teal tones, crisp palette" } },
  { id: "pastel", kind: "color", title: "Pastel palette", dims: { color: "soft pastel palette, gentle desaturated tones" } },
  { id: "monochrome", kind: "color", title: "Monochrome / B&W", dims: { color: "black-and-white monochrome with rich tonal range and deep contrast" } },
  { id: "high-contrast", kind: "color", title: "High contrast", dims: { color: "bold high-contrast color, deep blacks and bright highlights" } },
  { id: "muted-earthy", kind: "color", title: "Muted earthy", dims: { color: "muted earthy palette, natural desaturated tones" } },

  // --- quality boosters ---
  { id: "ultra-detail", kind: "quality", title: "Ultra detail", dims: { detail: "extremely high detail, intricate textures, razor-sharp focus, pristine quality" } },
  { id: "photoreal", kind: "quality", title: "Photoreal", dims: { medium: "photorealistic image", detail: "lifelike photorealistic detail, accurate materials and lighting, indistinguishable from a real photo" } },

  // --- angle / framing ---
  { id: "closeup", kind: "angle", title: "Close-up", dims: { composition: "tight close-up framing, subject fills the frame" } },
  { id: "wide-shot", kind: "angle", title: "Wide shot", dims: { composition: "wide establishing shot with context and depth" } },
  { id: "top-down", kind: "angle", title: "Top-down", dims: { composition: "perfectly top-down overhead view" } },
  { id: "low-angle", kind: "angle", title: "Low / hero angle", dims: { composition: "low heroic camera angle looking up at the subject for a powerful feel" } },
];
