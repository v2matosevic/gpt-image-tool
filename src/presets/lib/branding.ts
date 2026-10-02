import type { Preset } from "../types.js";

const logo = (id: string, title: string, medium: string, composition: string, text = false): Preset => ({
  id, category: "branding", title,
  description: `${title} raster concept. Approved artwork or font outlines supply the final vector master.`,
  recommended: { size: "1024x1024", quality: "high", format: "png" }, background: "transparent",
  dims: { medium, composition, color: "one or two flat solid brand colors; a distinct silhouette that also works in one ink",
    setting: "isolated artwork, no mockup, no presentation page, generous clear space",
    detail: "economical shapes, balanced negative space, deliberate optical corrections, legible at small sizes" },
  avoid: ["gradients", "3D bevels", "shadows", "photographic scenery", "stock symbols", "watermarks", ...(text ? [] : ["lettering", "text"])],
});

export const branding: Preset[] = [
  logo("logo-wordmark", "Wordmark", "a custom typographic wordmark concept with deliberate letterforms and spacing", "a single horizontal wordmark; no symbol, no slogan, no alternatives on the same canvas", true),
  logo("logo-monogram", "Monogram", "an original monogram using the requested initials, built from simple interlocking letterforms", "one compact, optically balanced monogram with open counters", true),
  logo("logo-emblem", "Emblem", "a restrained emblem identity concept with a simple central motif and a purposeful enclosing shape", "a single compact emblem, only the requested short wording, no microtext", true),
  logo("logo-combination", "Combination mark", "a coordinated symbol and wordmark logo concept", "one horizontal lockup, symbol left and wordmark right with clear separation; no repeated versions", true),
  logo("logo-mascot", "Mascot logo", "a distinctive character brand mark reduced to bold flat shapes", "one expressive mascot silhouette, readable at thumbnail size, limited internal detail"),
  {
    id: "brand-material", category: "branding", title: "Brand material study", description: "Text-free material and light direction for a branding mood board.",
    recommended: { size: "1536x1024", quality: "high", format: "png" },
    dims: { medium: "editorial material study", composition: "asymmetric tactile close-up with a calm area of negative space",
      lighting: "soft directional daylight with believable material response", color: "a restrained brand palette", detail: "specific physical texture, subtle irregularity, economical composition" },
    avoid: ["lettering", "logos", "watermarks", "collage labels", "plastic sheen", "unmotivated decorative objects"],
  },
  {
    id: "brand-pattern", category: "branding", title: "Brand pattern", description: "A repeat-inspired raster pattern concept; seamless tiling must be checked separately.",
    recommended: { size: "1024x1024", quality: "high", format: "png" },
    dims: { medium: "a graphic identity pattern system", composition: "a deliberate rhythm of a few original motifs with measured variation and breathing room",
      color: "two flat brand colors", detail: "simple motifs, consistent visual weight, avoid a dense wallpaper effect" },
    avoid: ["lettering", "logos", "watermarks", "shadows", "gradients"],
  },
];
