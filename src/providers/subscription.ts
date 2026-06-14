// The subscription backend: POSTs to the same ChatGPT-backend Responses endpoint Codex CLI uses,
// authenticated with the ChatGPT OAuth token from ~/.codex/auth.json. Billed to the ChatGPT/Codex
// usage bucket, not the paid API. The request shape mirrors the proven `chatgpt-imagegen` payload.

import { randomUUID } from "node:crypto";
import { getValidCreds, refreshCreds, codexVersionHeader, userAgent, reloginHint } from "../auth.js";
import type { SubscriptionCreds as Creds } from "../auth.js";
import { parseSse } from "../sse.js";
import { MAX_RETRIES, backoffMs, isNetworkError, isRetryableStatus, retryAfterMs, sleep } from "../retry.js";
import type { GenerateInput, GenerateResult, ImageProvider } from "./types.js";

const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_MODEL = process.env.GPT_IMAGE_MODEL?.trim() || "gpt-5.5";
const TOTAL_TIMEOUT_MS = Number(process.env.GPT_IMAGE_TIMEOUT_MS) || 300_000;
const STALL_TIMEOUT_MS = Number(process.env.GPT_IMAGE_STALL_MS) || 120_000;

function buildUserText(input: GenerateInput): string {
  const hasRef = (input.inputImages?.length ?? 0) > 0;
  let t = hasRef
    ? "Use the image_generation tool to produce a new image from the attached reference image(s), following these instructions. "
    : "Use the image_generation tool to render the following. ";
  t += `${hasRef ? "Instructions" : "Request"}: ${input.prompt}. `;
  t += `Output format: ${input.format}.`;
  if (input.size !== "auto") t += ` Size: ${input.size}.`;
  t += " Do not include explanatory text — produce only the image.";
  return t;
}

function buildBody(input: GenerateInput, model: string): unknown {
  const imageTool: Record<string, unknown> = { type: "image_generation", output_format: input.format };
  if (input.size !== "auto") imageTool.size = input.size;
  if (input.quality !== "auto") imageTool.quality = input.quality; // backend may ignore/downgrade
  // NOTE: the subscription routing model rejects `background: transparent` ("not supported for this
  // model"). Transparency is handled out-of-band by generate.ts (render on a flat bg, then key it
  // out locally). Only the apikey backend supports the native background param.

  // Multimodal content: the text brief first, then any reference images (img2img / edit / upscale).
  // Confirmed against the live endpoint: input_image with a base64 data URI is accepted and used.
  const content: Array<Record<string, unknown>> = [{ type: "input_text", text: buildUserText(input) }];
  for (const img of input.inputImages ?? []) {
    content.push({ type: "input_image", image_url: `data:${img.mime};base64,${img.bytes.toString("base64")}` });
  }
  // Inpainting: transparent areas of the mask mark the regions to regenerate.
  if (input.maskImage) {
    imageTool.input_image_mask = {
      image_url: `data:${input.maskImage.mime};base64,${input.maskImage.bytes.toString("base64")}`,
    };
  }

  return {
    model,
    stream: true,
    instructions: "You are an image generation assistant.",
    input: [{ type: "message", role: "user", content }],
    tools: [imageTool],
    tool_choice: "auto",
    parallel_tool_calls: false,
    store: false,
    reasoning: { effort: "low", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    text: { verbosity: "low" },
  };
}

async function doRequest(
  creds: Creds,
  version: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  const uuid = randomUUID();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${creds.accessToken}`,
    Accept: "text/event-stream",
    Connection: "Keep-Alive",
    version,
    session_id: uuid,
    "x-client-request-id": uuid,
    "User-Agent": userAgent(version),
    originator: "codex_cli_rs",
  };
  if (creds.accountId) headers["chatgpt-account-id"] = creds.accountId;
  return fetch(ENDPOINT, { method: "POST", headers, body: JSON.stringify(body), signal });
}

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  onChunk: () => void,
): Promise<{ b64: string | null; revisedPrompt?: string }> {
  let b64: string | null = null;
  let revisedPrompt: string | undefined;
  const harvest = (item: any) => {
    if (item?.type === "image_generation_call" && typeof item.result === "string") {
      b64 ??= item.result;
      if (!revisedPrompt && typeof item.revised_prompt === "string") revisedPrompt = item.revised_prompt;
    }
  };
  for await (const ev of parseSse(body, onChunk)) {
    const type = typeof ev.type === "string" ? ev.type : "";
    if (type === "response.output_item.done") {
      harvest((ev as any).item);
    } else if (type === "response.completed") {
      const out: any[] = (ev as any).response?.output ?? [];
      for (const item of out) harvest(item);
    } else if (type === "error") {
      const msg = (ev as any).message || (ev as any).error?.message || "stream error";
      throw new Error(`subscription backend stream error: ${msg}`);
    }
  }
  return { b64, revisedPrompt };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

export class SubscriptionProvider implements ImageProvider {
  readonly name = "subscription";

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const version = await codexVersionHeader();
    const body = buildBody(input, DEFAULT_MODEL);
    let creds = await getValidCreds();

    // Retry transient failures (429 rate limit / 5xx / network) with bounded backoff, so a brief
    // quota throttle recovers on its own instead of failing the call.
    let lastErr: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const totalTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
      let stallTimer: NodeJS.Timeout | undefined;
      let streaming = false;
      const resetStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
      };
      try {
        let res = await doRequest(creds, version, body, controller.signal);
        if (res.status === 401 || res.status === 403) {
          if (creds.refreshToken) {
            // refreshCreds throws a clear re-login message if the session is truly dead.
            creds = await refreshCreds(creds.refreshToken);
            res = await doRequest(creds, version, body, controller.signal);
          }
          if (res.status === 401 || res.status === 403) {
            throw new Error(reloginHint(`subscription auth rejected (HTTP ${res.status})`));
          }
        }
        if (isRetryableStatus(res.status) && attempt < MAX_RETRIES) {
          const wait = retryAfterMs(res) ?? backoffMs(attempt);
          clearTimeout(totalTimer);
          if (stallTimer) clearTimeout(stallTimer);
          await sleep(wait);
          continue;
        }
        if (!res.ok || !res.body) {
          const detail = await safeText(res);
          throw new Error(
            `subscription image request failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}` +
              (res.status === 400 ? " (a 400 / 'newer version of Codex' usually means the model is gated — try GPT_IMAGE_MODEL=gpt-5.4-mini)" : "") +
              (res.status === 429 ? ` (rate limited — your ChatGPT/Codex quota; retried ${MAX_RETRIES}×, still throttled. Wait a few minutes)` : ""),
          );
        }
        resetStall();
        streaming = true;
        const { b64, revisedPrompt } = await consumeStream(res.body, resetStall);
        if (!b64) {
          throw new Error(
            "subscription backend returned no image (the model may have replied with text). Try a more explicit prompt.",
          );
        }
        return { bytes: Buffer.from(b64, "base64"), format: input.format, revisedPrompt };
      } catch (e) {
        if (controller.signal.aborted) {
          lastErr = new Error(
            `subscription image request timed out (>${Math.round(TOTAL_TIMEOUT_MS / 1000)}s total or >${Math.round(STALL_TIMEOUT_MS / 1000)}s stalled).`,
          );
        } else {
          lastErr = e;
        }
        // Retry pre-stream network blips; never retry a mid-stream or content error.
        if (!streaming && isNetworkError(e, controller.signal.aborted) && attempt < MAX_RETRIES) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastErr;
      } finally {
        clearTimeout(totalTimer);
        if (stallTimer) clearTimeout(stallTimer);
      }
    }
    throw lastErr ?? new Error("subscription image request failed after retries.");
  }
}
