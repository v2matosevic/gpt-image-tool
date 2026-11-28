// The paid backend: the documented OpenAI Images API with an OPENAI_API_KEY. It bills API credits,
// not the subscription, and is used only when explicitly selected; there is no fallback to or
// from it. The key comes from secrets.ts and never appears in an error this throws.

import { MAX_RETRIES, backoffMs, isNetworkError, isRetryableStatus, retryAfterMs, sleep } from "../retry.js";
import type { GenerateInput, GenerateResult, ImageProvider } from "./types.js";
import { resolveImageModel, validateComplexity, validateImageQuality, validateSize } from "../models.js";
import { cleanUsage } from "../pricing.js";
import { findApiKey, missingKeyMessage, redact } from "../secrets.js";

const GEN_ENDPOINT = "https://api.openai.com/v1/images/generations";
const EDIT_ENDPOINT = "https://api.openai.com/v1/images/edits";

function extFor(mime: string): string {
  return mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
}

export class ApiKeyProvider implements ImageProvider {
  readonly name = "apikey";

  async generate(input: GenerateInput): Promise<GenerateResult> {
    input = { ...input, imageModel: resolveImageModel(input.imageModel, this.name) };
    validateImageQuality(input.quality, input.imageModel);
    validateComplexity(input.complexity, input.imageModel);
    validateSize(input.size, this.name, input.imageModel);
    const found = findApiKey(input.keyProject);
    if (!found) throw new Error(missingKeyMessage(input.keyProject));
    const { key, source } = found;
    try {
      const r = (input.inputImages?.length ?? 0) > 0 ? await this.edit(key, input) : await this.create(key, input);
      return { ...r, keySource: source };
    } catch (e) {
      // Errors travel into run records, node state and logs: scrub every trace of the key first.
      const msg = e instanceof Error ? e.message : String(e);
      const clean = new Error(redact(msg, key));
      throw clean;
    }
  }

  /** fetch with bounded retry on 429 / 5xx / network blips (honors Retry-After). */
  private async requestWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, init);
        if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) {
          await sleep(retryAfterMs(res) ?? backoffMs(attempt));
          continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (isNetworkError(e, false) && attempt < MAX_RETRIES) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw e;
      }
    }
    throw lastErr ?? new Error("OpenAI Images request failed after retries.");
  }

  /** Text-to-image: /v1/images/generations (JSON). */
  private async create(key: string, input: GenerateInput): Promise<GenerateResult> {
    const body: Record<string, unknown> = {
      model: input.imageModel,
      prompt: input.prompt,
      n: 1,
      output_format: input.format,
    };
    if (input.size !== "auto") body.size = input.size;
    if (input.quality !== "auto") body.quality = input.quality;
    if (input.complexity) body.complexity = input.complexity;
    if (input.background && input.background !== "auto" && input.format !== "jpeg") body.background = input.background;

    const res = await this.requestWithRetry(GEN_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.parse(res, "generations", input.format);
  }

  /** Image-to-image (edit / upscale / variation): /v1/images/edits (multipart). */
  private async edit(key: string, input: GenerateInput): Promise<GenerateResult> {
    const form = new FormData();
    form.set("model", input.imageModel!);
    form.set("output_format", input.format);
    form.set("prompt", input.prompt);
    form.set("n", "1");
    if (input.size !== "auto") form.set("size", input.size);
    if (input.quality !== "auto") form.set("quality", input.quality);
    if (input.complexity) form.set("complexity", input.complexity);
    if (input.background && input.background !== "auto" && input.format !== "jpeg") form.set("background", input.background);
    for (const img of input.inputImages ?? []) {
      // GPT Image supports multiple reference images.
      form.append("image[]", new Blob([new Uint8Array(img.bytes)], { type: img.mime }), `ref.${extFor(img.mime)}`);
    }
    if (input.maskImage) {
      form.append("mask", new Blob([new Uint8Array(input.maskImage.bytes)], { type: input.maskImage.mime }), `mask.${extFor(input.maskImage.mime)}`);
    }
    const res = await this.requestWithRetry(EDIT_ENDPOINT, {
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
      usage: cleanUsage(j.usage),
    };
  }
}
