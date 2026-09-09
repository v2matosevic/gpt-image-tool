export const IMAGE_MODELS = {
  flare: "gpt-image-2.5-flare",
  sunburst: "gpt-image-2.5-sunburst",
} as const;

export const IMAGE_MODEL_CHOICES = ["auto", "flare", "sunburst", ...Object.values(IMAGE_MODELS)] as const;

/** Resolve the renderer independently of the subscription's mainline routing model. */
export function resolveImageModel(selection: string | undefined, backend: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const selected = selection?.trim() || (backend === "apikey" ? env.GPT_IMAGE_API_MODEL?.trim() : undefined);
  if (backend !== "apikey" && selected && selected !== "auto") {
    throw new Error("The subscription endpoint does not reliably enforce image model selection. To select Flare or Sunburst, explicitly use backend apikey with OPENAI_API_KEY (separate API billing). No request was sent and the backend was not changed.");
  }
  if (!selected || selected === "auto") return backend === "apikey" ? IMAGE_MODELS.sunburst : undefined;
  return Object.hasOwn(IMAGE_MODELS, selected) ? IMAGE_MODELS[selected as keyof typeof IMAGE_MODELS] : selected;
}

export function validateImageQuality(quality: string, model: string | undefined): void {
  if (!["auto", "low", "medium", "high", "xhigh", "max"].includes(quality)) {
    throw new Error(`Invalid image quality: ${quality}. Use auto, low, medium, high, xhigh, or max.`);
  }
  if ((quality === "xhigh" || quality === "max") && !model) {
    throw new Error(`${quality} quality requires an explicitly selected GPT Image 2.5 API renderer. Subscription renderer capabilities are unverified.`);
  }
  if ((quality === "xhigh" || quality === "max") && model && /^gpt-image-(?:1(?:\.|-|$)|2(?:-|$))/.test(model)) {
    throw new Error(`${quality} quality requires GPT Image 2.5; selected image model is ${model}. Choose flare or sunburst.`);
  }
}

export function configuredModels(env: NodeJS.ProcessEnv = process.env) {
  return {
    routing: env.GPT_IMAGE_MODEL?.trim() || "gpt-6-astra",
    image: resolveImageModel(undefined, "apikey", env),
    proof: env.GPT_IMAGE_PROOF_MODEL?.trim() || "gpt-6-astra",
  };
}
