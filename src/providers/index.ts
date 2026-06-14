import { SubscriptionProvider } from "./subscription.js";
import { ApiKeyProvider } from "./apikey.js";
import type { ImageProvider } from "./types.js";

export type BackendName = "subscription" | "apikey";

/** Select a backend by explicit name, env (GPT_IMAGE_BACKEND), then default ("subscription"). */
export function getProvider(name?: string): ImageProvider {
  const backend = (name || process.env.GPT_IMAGE_BACKEND || "subscription").toLowerCase();
  switch (backend) {
    case "subscription":
      return new SubscriptionProvider();
    case "apikey":
      return new ApiKeyProvider();
    default:
      throw new Error(`Unknown backend "${backend}". Use "subscription" or "apikey".`);
  }
}
