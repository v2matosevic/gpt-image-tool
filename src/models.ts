// The subscription model directs the image tool; OpenAI selects its image renderer.
// Only the explicit API backend lets us select a GPT Image model directly.
export function configuredModels(env: NodeJS.ProcessEnv = process.env) {
  return {
    routing: env.GPT_IMAGE_MODEL?.trim() || "gpt-6-astra",
    image: env.GPT_IMAGE_API_MODEL?.trim() || "gpt-image-2",
    proof: env.GPT_IMAGE_PROOF_MODEL?.trim() || "gpt-6-astra",
  };
}
