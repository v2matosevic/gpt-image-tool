// The vision proof-loop: send a generated image BACK through the subscription endpoint (same free
// quota, multimodal) and have the model proofread it — verbatim text, diacritics, duplicated words,
// obvious AI artifacts. generate.ts uses the verdict to auto-regenerate with concrete feedback.
// Proofing FAILS OPEN: any transport/parse problem returns an "unverified" pass so an image is
// never lost to a broken proofread.

import { codexVersionHeader, getValidCreds, refreshAfter401 } from "./auth.js";
import { codexResponsesRequest } from "./codexhttp.js";
import { parseSse } from "./sse.js";
import { backoffMs, isNetworkError, isRetryableStatus, retryAfterMs, sleep } from "./retry.js";

const PROOF_MODEL = process.env.GPT_IMAGE_PROOF_MODEL?.trim() || "gpt-5.5";
const PROOF_RETRIES = 2; // proofing is cheap but rides the same throttled quota as generation
const PROOF_TIMEOUT_MS = Number(process.env.GPT_IMAGE_PROOF_TIMEOUT_MS) || 120_000;

export interface ProofVerdict {
  pass: boolean;
  /** All text the proofreader could read in the image, verbatim. */
  textRead?: string;
  /** Concrete problems found (empty when pass). */
  issues: string[];
  /** True when the proofread itself couldn't run/parse — the image was NOT actually verified. */
  unverified?: boolean;
  /** How many generation attempts were consumed (filled in by the retry loop). */
  attempts?: number;
}

export interface ProofRequest {
  /** The literal text the image must contain, verbatim (style.text). */
  expectedText?: string;
  /** Extra context so the proofreader doesn't flag intentional properties (e.g. transparency). */
  context?: string;
}

function proofQuestion(req: ProofRequest): string {
  return (
    "You are a meticulous prepress proofreader for a design studio. Examine the attached image.\n" +
    (req.expectedText
      ? `REQUIREMENT: the image must contain exactly this text, verbatim, correctly spelled including every diacritic: "${req.expectedText}"\n`
      : "") +
    (req.context ? `Context (intentional, do not flag): ${req.context}\n` : "") +
    "Check, strictly:\n" +
    "1. Every visible word and letter: spelling, duplicated or stray words, garbled/extra characters, wrong or missing diacritics (č ć ž š đ á é ü …), broken kerning.\n" +
    "2. Obvious generation artifacts: malformed hands or faces, warped geometry, nonsense glyphs, unintended watermarks or logos.\n" +
    "3. Craft: does it read as professionally art-directed (real materials, coherent lighting, no plastic AI sheen)?\n" +
    'Reply with ONLY minified JSON, no markdown fences: {"pass":true|false,"textRead":"<all text you can read in the image, verbatim, empty string if none>","issues":["<each concrete problem>"]}\n' +
    "pass=false if ANY text is wrong or any serious artifact exists. Minor stylistic taste is not an issue."
  );
}

/** Parse the proofreader's reply. Exported for tests. Unparseable → fail-open (pass, unverified). */
export function parseVerdict(raw: string): ProofVerdict {
  const text = raw.trim();
  // Tolerate accidental code fences or prose around the JSON object.
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { pass?: unknown; textRead?: unknown; issues?: unknown };
      const issues = Array.isArray(j.issues) ? j.issues.map(String).filter(Boolean) : [];
      const pass = typeof j.pass === "boolean" ? j.pass : issues.length === 0;
      return { pass, issues, textRead: typeof j.textRead === "string" ? j.textRead : undefined };
    } catch {
      /* fall through */
    }
  }
  return { pass: true, issues: [], unverified: true };
}

function buildBody(imageB64: string, mime: string, question: string): unknown {
  return {
    model: PROOF_MODEL,
    stream: true,
    instructions: "You are a meticulous image proofreader. Answer with the exact JSON requested.",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: question },
          { type: "input_image", image_url: `data:${mime};base64,${imageB64}` },
        ],
      },
    ],
    tools: [],
    tool_choice: "none",
    parallel_tool_calls: false,
    store: false,
    reasoning: { effort: "low", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    text: { verbosity: "low" },
  };
}

/** Harvest assistant output text from the Responses SSE stream. The same message item can be
 *  delivered on BOTH `response.output_item.done` and inside `response.completed` — take the first
 *  non-empty harvest only (mirrors the `??=` idempotency in the subscription provider). */
async function consumeText(body: ReadableStream<Uint8Array>): Promise<string> {
  let out = "";
  const harvest = (item: any) => {
    if (out || item?.type !== "message" || !Array.isArray(item.content)) return;
    let text = "";
    for (const c of item.content) {
      if (c?.type === "output_text" && typeof c.text === "string") text += c.text;
    }
    out = text;
  };
  for await (const ev of parseSse(body, () => {})) {
    const type = typeof ev.type === "string" ? ev.type : "";
    if (type === "response.output_item.done") harvest((ev as any).item);
    else if (type === "response.completed") for (const item of (ev as any).response?.output ?? []) harvest(item);
    else if (type === "error") throw new Error((ev as any).message || "proof stream error");
  }
  return out;
}

/**
 * Proofread a generated image via the subscription endpoint. Retries transient throttles (the
 * proof rides the same shared quota as generation, so a 429 right after a burst is the COMMON
 * case, not the rare one). Never throws — a final failure returns an unverified pass.
 */
export async function proofImage(imageBytes: Buffer, mime: string, req: ProofRequest): Promise<ProofVerdict> {
  const body = buildBody(imageBytes.toString("base64"), mime, proofQuestion(req));
  let lastErr: unknown;
  for (let attempt = 0; attempt <= PROOF_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROOF_TIMEOUT_MS);
    try {
      const version = await codexVersionHeader();
      let creds = await getValidCreds();
      let res = await codexResponsesRequest(creds, version, body, controller.signal);
      if ((res.status === 401 || res.status === 403) && creds.refreshToken) {
        creds = await refreshAfter401(creds.accessToken);
        res = await codexResponsesRequest(creds, version, body, controller.signal);
      }
      if (isRetryableStatus(res.status) && attempt < PROOF_RETRIES) {
        clearTimeout(timer);
        await sleep(retryAfterMs(res) ?? backoffMs(attempt));
        continue;
      }
      if (!res.ok || !res.body) throw new Error(`proof request failed: HTTP ${res.status}`);
      return parseVerdict(await consumeText(res.body));
    } catch (e) {
      lastErr = e;
      if (isNetworkError(e, controller.signal.aborted) && attempt < PROOF_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  console.error(`[gpt-image] proofread skipped (${lastErr instanceof Error ? lastErr.message : lastErr}) — image NOT verified.`);
  return { pass: true, issues: [], unverified: true };
}
