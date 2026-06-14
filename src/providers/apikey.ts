// The paid fallback backend: standard OpenAI Images API with an OPENAI_API_KEY. Stable and
// supported, but bills API credits (not the subscription). Only used when explicitly selected.

import type { GenerateInput, GenerateResult, ImageProvider } from "./types.js";

const GEN_ENDPOINT = "https://api.openai.com/v1/images/generations";
const EDIT_ENDPOINT = "https://api.openai.com/v1/images/edits";
const DEFAULT_MODEL = process.env.GPT_IMAGE_API_MODEL?.trim() || "gpt-image-1";

function extFor(mime: string): string {
  return mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
}

export class ApiKeyProvider implements ImageProvider {
  readonly name = "apikey";

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const key = process.env.OPENAI_API_KEY?.trim();
    if (!key) {
      throw new Error("apikey backend requires OPENAI_API_KEY in the environment (see .env.example).");
    }
    return (input.inputImages?.length ?? 0) > 0
      ? this.edit(key, input)
      : this.create(key, input);
  }

  /** Text-to-image: /v1/images/generations (JSON). */
  private async create(key: string, input: GenerateInput): Promise<GenerateResult> {
    const body: Record<string, unknown> = {
      model: DEFAULT_MODEL,
      prompt: input.prompt,
      n: 1,
      output_format: input.format,
    };
    if (input.size !== "auto") body.size = input.size;
    if (input.quality !== "auto") body.quality = input.quality;

    const res = await fetch(GEN_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.parse(res, "generations", input.format);
  }

  /** Image-to-image (edit / upscale / variation): /v1/images/edits (multipart). */
  private async edit(key: string, input: GenerateInput): Promise<GenerateResult> {
    const form = new FormData();
    form.set("model", DEFAULT_MODEL);
    form.set("prompt", input.prompt);
    form.set("n", "1");
    if (input.size !== "auto") form.set("size", input.size);
    if (input.quality !== "auto") form.set("quality", input.quality);
    for (const img of input.inputImages ?? []) {
      // image[] supports multiple references on gpt-image-1.
      form.append("image[]", new Blob([new Uint8Array(img.bytes)], { type: img.mime }), `ref.${extFor(img.mime)}`);
    }
    const res = await fetch(EDIT_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` }, // fetch sets multipart boundary
      body: form,
    });
    return this.parse(res, "edits", input.format);
  }

  private async parse(res: Response, what: string, format: GenerateInput["format"]): Promise<GenerateResult> {
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      throw new Error(`OpenAI Images ${what} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    const j: any = await res.json();
    const b64 = j?.data?.[0]?.b64_json;
    if (typeof b64 !== "string") throw new Error("OpenAI Images API returned no image data.");
    return {
      bytes: Buffer.from(b64, "base64"),
      format,
      revisedPrompt: typeof j.data[0].revised_prompt === "string" ? j.data[0].revised_prompt : undefined,
    };
  }
}
