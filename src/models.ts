// Image renderer choices for the paid API backend, and the rules each one accepts. Checked against
// developers.openai.com/api/docs/guides/image-generation on 2026-11-28, which says "For new
// integrations, use GPT-Image-2.6 Sunburst or Flare". The subscription keeps its server-selected
// renderer (gpt-image-2); naming a model there is refused, never redirected to the API.

/** The short names follow the current generation (2.6). 2.5 stays selectable by its own names. */
export const IMAGE_MODELS = {
  flare: "gpt-image-2.6-flare",
  sunburst: "gpt-image-2.6-sunburst",
  "flare-2.6": "gpt-image-2.6-flare",
  "sunburst-2.6": "gpt-image-2.6-sunburst",
  "flare-2.5": "gpt-image-2.5-flare",
  "sunburst-2.5": "gpt-image-2.5-sunburst",
} as const;

/** The default API renderer when none is named. */
export const DEFAULT_API_MODEL = IMAGE_MODELS.sunburst;

export const IMAGE_MODEL_CHOICES = ["auto", ...Object.keys(IMAGE_MODELS), ...new Set(Object.values(IMAGE_MODELS))] as unknown as readonly [string, ...string[]];

export const COMPLEXITIES = ["low", "medium", "high"] as const;
export type Complexity = typeof COMPLEXITIES[number];

/** Resolve the renderer independently of the subscription's mainline routing model. */
export function resolveImageModel(selection: string | undefined, backend: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const selected = selection?.trim() || (backend === "apikey" ? env.GPT_IMAGE_API_MODEL?.trim() : undefined);
  if (backend !== "apikey" && selected && selected !== "auto") {
    throw new Error("The subscription endpoint does not reliably enforce image model selection. To select Flare or Sunburst, explicitly use backend apikey with OPENAI_API_KEY (separate API billing). No request was sent and the backend was not changed.");
  }
  if (!selected || selected === "auto") return backend === "apikey" ? DEFAULT_API_MODEL : undefined;
  return Object.hasOwn(IMAGE_MODELS, selected) ? IMAGE_MODELS[selected as keyof typeof IMAGE_MODELS] : selected;
}

/** Generation family of a resolved model id: "2.6", "2.5", "2", "1", or undefined when unknown. */
export function modelFamily(model: string | undefined): "2.6" | "2.5" | "2" | "1" | undefined {
  if (!model) return undefined;
  if (/^gpt-image-2\.6(?:-|$)/.test(model)) return "2.6";
  if (/^gpt-image-2\.5(?:-|$)/.test(model)) return "2.5";
  if (/^gpt-image-2(?:-|$)/.test(model) || model === "chatgpt-image-latest") return "2";
  if (/^gpt-image-1(?:\.|-|$)/.test(model)) return "1";
  return undefined;
}

export function validateImageQuality(quality: string, model: string | undefined): void {
  if (!["auto", "low", "medium", "high", "xhigh", "max"].includes(quality)) {
    throw new Error(`Invalid image quality: ${quality}. Use auto, low, medium, high, xhigh, or max.`);
  }
  if ((quality === "xhigh" || quality === "max") && !model) {
    throw new Error(`${quality} quality requires an explicitly selected GPT Image 2.5 or 2.6 API renderer. Subscription renderer capabilities are unverified.`);
  }
  if ((quality === "xhigh" || quality === "max") && model && /^gpt-image-(?:1(?:\.|-|$)|2(?:-|$))/.test(model)) {
    throw new Error(`${quality} quality requires GPT Image 2.5 or 2.6; selected image model is ${model}. Choose flare or sunburst.`);
  }
}

/** complexity is a GPT-Image-2.6 request field (low | medium | high; the API uses high when it is
 *  omitted). It is refused on the subscription and on older models rather than silently dropped. */
export function validateComplexity(complexity: string | undefined, model: string | undefined): void {
  if (complexity === undefined) return;
  if (!(COMPLEXITIES as readonly string[]).includes(complexity)) throw new Error(`Invalid complexity: ${complexity}. Use low, medium or high.`);
  if (!model) throw new Error("complexity needs the apikey backend with a GPT-Image-2.6 model (flare or sunburst). The subscription ignores it, so it was refused rather than dropped. No request was sent.");
  const fam = modelFamily(model);
  if (fam !== "2.6" && fam !== undefined) throw new Error(`complexity is a GPT-Image-2.6 setting; ${model} does not take it. Choose flare or sunburst (2.6), or leave complexity out.`);
}

/** The fixed size menu every backend accepts. Custom WIDTHxHEIGHT sizes are API-only. */
export const PRESET_SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536", "1024x1280", "1280x1024", "2048x2048", "2048x1152", "1152x2048"] as const;
export const SIZE_RULES = { multiple: 16, maxEdge: 3840, minPixels: 655_360, maxPixels: 8_294_400, maxAspect: 3 } as const;

export function parseSize(size: string): { width: number; height: number } | null {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(size);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** Why a WIDTHxHEIGHT size breaks the documented 2.5/2.6 limits, or null when it is valid. */
export function customSizeProblem(size: string): string | null {
  const d = parseSize(size);
  if (!d) return `"${size}" is not WIDTHxHEIGHT (e.g. 2048x1152) or auto.`;
  const { width: w, height: h } = d;
  const r = SIZE_RULES;
  if (w % r.multiple || h % r.multiple) return `${size}: width and height must be multiples of 16.`;
  if (Math.max(w, h) > r.maxEdge) return `${size}: no edge may exceed ${r.maxEdge} px.`;
  if (Math.max(w, h) / Math.min(w, h) > r.maxAspect) return `${size}: the aspect ratio must be between 1:3 and 3:1.`;
  if (w * h < r.minPixels || w * h > r.maxPixels) return `${size}: total pixels must be between ${r.minPixels.toLocaleString("en-US")} and ${r.maxPixels.toLocaleString("en-US")} (${(w * h).toLocaleString("en-US")} given).`;
  return null;
}

/** Sizes off the fixed menu need the apikey backend and a 2.5/2.6 model. */
export function validateSize(size: string, backend: string, model: string | undefined): void {
  if ((PRESET_SIZES as readonly string[]).includes(size)) return;
  if (backend !== "apikey") throw new Error(`Custom size ${size} needs backend apikey with flare or sunburst; the subscription accepts only ${PRESET_SIZES.join(", ")} (and ignores them). No request was sent and the backend was not changed.`);
  const fam = modelFamily(model);
  if (fam !== "2.6" && fam !== "2.5" && fam !== undefined) throw new Error(`Custom size ${size} needs GPT Image 2.5 or 2.6; ${model} takes only the fixed sizes.`);
  const problem = customSizeProblem(size);
  if (problem) throw new Error(`Invalid size ${problem}`);
}

export function configuredModels(env: NodeJS.ProcessEnv = process.env) {
  return {
    routing: env.GPT_IMAGE_MODEL?.trim() || "gpt-6-astra",
    image: resolveImageModel(undefined, "apikey", env),
    proof: env.GPT_IMAGE_PROOF_MODEL?.trim() || "gpt-6-astra",
  };
}
