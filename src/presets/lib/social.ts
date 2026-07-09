import type { Preset } from "../types.js";

// Premium social-media design presets. The bar is agency/editorial, NOT flat minimal text cards.
// They bake the principles that separate premium from slop: REAL material, directional light, depth,
// bold scale, one inked accent, film grain. The CALLER supplies the copy (subject / style.text /
// prompt) and the brand palette (per-project .gptimage.json). Always proof in-image text.
export const social: Preset[] = [
  {
    id: "social-type-led",
    category: "social",
    title: "Type-led editorial / letterpress card",
    description:
      "Bold oversized typography letterpress-debossed into real material. Editorial, tactile, expensive. The caller passes the headline + which word is the accent. Proof the spelling. For a coherent carousel, pass the cover as style_reference on later slides.",
    recommended: { size: "1024x1536", quality: "high", format: "png" },
    background: "opaque",
    dims: {
      medium:
        "a premium editorial design where bold oversized typography is letterpress-debossed into a real tactile surface, art direction at the level of a high-end design annual or an Aesop / Kinfolk campaign — NOT a flat digital template",
      composition:
        "a confident modern grotesque set large and tight across the upper two-thirds on an intentional asymmetric typographic grid, one decisive word inked in the accent color, a thin rule and a small refined wordmark area in the lower third",
      setting: "a warm off-white fine-art cotton-paper surface with real visible paper fibre texture",
      lighting:
        "soft natural side-light raking across the surface, casting true soft shadow inside the debossed letter impressions for real depth and dimensionality",
      color: "a tightly capped palette, near-black wine-ink type with one decisive saturated accent word",
      mood: "editorial, expensive, confident, museum-quality print",
      detail:
        "fine film grain, tactile dimensional material, crisp perfectly-legible correctly-spelled VERBATIM type rendered exactly with no extra or duplicated words",
    },
    avoid: ["flat digital template", "generic minimal text card", "clip-art", "garbled or misspelled text", "duplicate or extra words", "watermark"],
  },
  {
    id: "social-image-led",
    category: "social",
    title: "Image-led campaign card",
    description:
      "Campaign-grade art-directed photography carries the slide; a restrained bold type lockup sits in the negative space. Perfume/spirits-ad quality. The caller supplies the hero metaphor + headline.",
    recommended: { size: "1024x1536", quality: "high", format: "png" },
    background: "opaque",
    dims: {
      medium:
        "campaign-grade art-directed product photography of a single real hero object or material metaphor, the quality of a perfume or spirits advertisement — NOT an illustration, NOT 3D render",
      composition:
        "one hero subject placed with decisive asymmetry, leaving a clean negative-space zone for a restrained bold type lockup with a thin accent rule",
      setting: "a clean real surface with genuine material, texture, and true reflection",
      lighting: "dramatic directional editorial product-photography lighting, real shadow, shallow depth of field",
      camera: "macro or 50-100mm lens, shallow depth of field, fine film grain",
      color: "a muted true-to-life palette with one restrained saturated accent",
      mood: "campaign, editorial, expensive, gallery-grade",
      detail: "true material texture, real reflection, genuine photographic realism",
    },
    avoid: ["flat vector", "clip-art", "plastic CGI sheen", "fake glossy premium gloss", "volumetric glow", "lens flare", "garbled text", "watermark"],
  },
  {
    id: "concept-hero",
    category: "social",
    title: "Editorial concept hero (textless metaphor)",
    description:
      "A single art-directed real-photography hero object as a metaphor, with empty space for an optional overlay. gpt-image's sweet spot: no brand assets, no risky text.",
    recommended: { size: "1024x1536", quality: "high", format: "png" },
    background: "opaque",
    dims: {
      medium: "an editorial concept hero, real product-photography of a single tangible object, NOT an illustration and NOT 3D render",
      composition: "one hero object off-center (rule of thirds), roughly half the frame calm negative space for an optional overlay",
      setting: "a clean seamless studio paper sweep, true material texture",
      lighting: "a single soft directional daylight source with gentle falloff and one natural contact shadow",
      camera: "a 50-100mm lens, controlled shallow depth of field, fine 35mm film grain",
      color: "muted true-to-life palette with one restrained saturated accent",
      mood: "calm, confident, art-directed editorial still life",
      detail: "true-to-life material texture, subtle film grain, realistic optics",
    },
    avoid: ["illustration or 3D-render look", "plastic CGI sheen", "fake glossy gloss", "volumetric glow", "lens flare", "harsh clipped shadows", "text", "watermark"],
  },
  {
    id: "social-bg-plate",
    category: "social",
    title: "Social card BACKGROUND plate (no text)",
    description:
      "A premium text-free background plate to sit UNDER type composited elsewhere (e.g. Remotion). Restrained art confined to one zone, the rest clean for a headline overlay.",
    recommended: { size: "1024x1536", quality: "high", format: "png" },
    background: "opaque",
    dims: {
      medium: "a premium social-media card BACKGROUND, art-directed editorial graphic, absolutely NO text",
      composition:
        "restrained art (Swiss geometry, a material texture, or a subtle hero element) confined to one third of the canvas, the remaining two-thirds clean calm empty negative space reserved for a headline overlay",
      setting: "a warm off-white field with real material/paper texture",
      lighting: "soft, dimensional, with subtle real depth",
      color: "capped palette, one small accent as the only saturated element",
      mood: "calm, intentional, expensive",
      detail: "precise craft, real texture, fine grain, generous emptiness",
    },
    avoid: ["any text or lettering", "people", "clip-art icons", "default AI gradient", "glow", "busy clutter", "centered focal point", "watermark"],
  },
];
