// The paid fallback backend: standard OpenAI Images API with an OPENAI_API_KEY. Stable and
// supported, but bills API credits (not the subscription). Only used when explicitly selected.

import type { GenerateInput, GenerateResult, ImageProvider } from "./types.js";

const ENDPOINT = "https://api.openai.com/v1/images/generations";
const DEFAULT_MODEL = process.env.GPT_IMAGE_API_MODEL?.trim() || "gpt-image-1";

export class ApiKeyProvider implements ImageProvider {
  readonly name = "apikey";

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const key = process.env.OPENAI_API_KEY?.trim();
    if (!key) {
      throw new Error("apikey backend requires OPENAI_API_KEY in the environment (see .env.example).");
    }
    const body: Record<string, unknown> = {
      model: DEFAULT_MODEL,
      prompt: input.prompt,
      n: 1,
      output_format: input.format,
    };
    if (input.size !== "auto") body.size = input.size;
    if (input.quality !== "auto") body.quality = input.quality;

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      throw new Error(`OpenAI Images API failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    const j: any = await res.json();
    const b64 = j?.data?.[0]?.b64_json;
    if (typeof b64 !== "string") throw new Error("OpenAI Images API returned no image data.");
    return {
      bytes: Buffer.from(b64, "base64"),
      format: input.format,
      revisedPrompt: typeof j.data[0].revised_prompt === "string" ? j.data[0].revised_prompt : undefined,
    };
  }
}
