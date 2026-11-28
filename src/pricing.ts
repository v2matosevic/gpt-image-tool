// What the paid Images API costs. One table, with its date and source; every dollar figure the
// tool shows comes from here. Actual cost is computed from the usage the API returns with each
// image; the estimate (dry runs, spend-limit checks) uses OpenAI's own output-token calculator.

export const PRICING = {
  checked: "2026-11-28",
  sources: [
    "https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst",
    "https://developers.openai.com/api/docs/models/gpt-image-2.6-flare",
    "https://developers.openai.com/api/docs/guides/image-generation#cost-and-latency",
  ],
  /** Dollars per million tokens. Cached input rates apply only to the Responses tool, not to the
   *  Images API this tool calls, so they are not used. */
  rates: {
    "2.6": { textInput: 5, imageInput: 8, output: 30 },
    "2.5": { textInput: 5, imageInput: 8, output: 30 },
  },
} as const;

type Family = keyof typeof PRICING.rates;
const familyOf = (model: string): Family => (/^gpt-image-2\.5(?:-|$)/.test(model) ? "2.5" : "2.6");

/** The usage block of an Images API response, kept as the API reported it. */
export interface ImageUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number; cached_tokens?: number };
  output_tokens_details?: { text_tokens?: number; image_tokens?: number };
}

/** Keep only the numeric usage fields, so nothing else in a response body is ever stored. */
export function cleanUsage(u: unknown): ImageUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  const src = u as Record<string, any>;
  const pick = (o: any, keys: string[]) => {
    if (!o || typeof o !== "object") return undefined;
    const out: Record<string, number> = {};
    for (const k of keys) { const v = n(o[k]); if (v !== undefined) out[k] = v; }
    return Object.keys(out).length ? out : undefined;
  };
  const out: ImageUsage = {};
  for (const k of ["input_tokens", "output_tokens", "total_tokens"] as const) { const v = n(src[k]); if (v !== undefined) out[k] = v; }
  const inD = pick(src.input_tokens_details, ["text_tokens", "image_tokens", "cached_tokens"]);
  const outD = pick(src.output_tokens_details, ["text_tokens", "image_tokens"]);
  if (inD) out.input_tokens_details = inD;
  if (outD) out.output_tokens_details = outD;
  return Object.keys(out).length ? out : undefined;
}

/** Dollars for one request from its reported usage. Input tokens without a text/image split are
 *  charged at the image rate (the higher one), so an unclear report never reads as cheaper. */
export function costFromUsage(model: string, usage: ImageUsage): number {
  const r = PRICING.rates[familyOf(model)];
  const input = usage.input_tokens ?? 0;
  const text = usage.input_tokens_details?.text_tokens;
  const image = usage.input_tokens_details?.image_tokens;
  const known = (text ?? 0) + (image ?? 0);
  const textIn = text ?? 0;
  const imageIn = (image ?? 0) + Math.max(0, input - known);
  const output = usage.output_tokens ?? 0;
  return round6((textIn * r.textInput + imageIn * r.imageInput + output * r.output) / 1e6);
}

const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** OpenAI's image-guide calculator (GptImageTokenCalculator, read 2026-11-28): output tokens for
 *  one image at a quality and size. 2.6 scales the 2.5 count by a per-quality factor. */
const CALC_BASE = { low: 16, medium: 24, high: 48, xhigh: 64, max: 96 } as const;
const CALC_26 = { low: 4.2, medium: 3.3, high: 1, xhigh: 1, max: 1 } as const;
export function outputTokens(model: string, quality: keyof typeof CALC_BASE, width: number, height: number): number {
  const long = Math.max(width, height), short = Math.min(width, height);
  const o = CALC_BASE[quality];
  const s = o / (long / short);
  const fl = Math.floor(s);
  const d = s - fl === 0.5 ? fl + (fl % 2) : Math.round(s);
  const f = (width >= height ? o : d) * (width >= height ? d : o);
  const p = Math.ceil((f * (2e6 + width * height)) / 4e6);
  return familyOf(model) === "2.6" ? Math.round(p * CALC_26[quality]) : p;
}

/** Input tokens assumed per reference image in an estimate. Not published; set from measured
 *  usage (see docs/MODELS.md) and kept on the high side. */
export const EST_IMAGE_INPUT_TOKENS = 1600;

export interface CostEstimate { dollars: number; outputTokens: number; assumed: string[] }

/** An estimate for one request before it is sent. auto quality is assumed high and auto size
 *  1024x1024, and the result is said to rest on those assumptions. */
export function estimateCost(x: { model: string; quality?: string; size?: string; promptChars?: number; inputImages?: number }): CostEstimate {
  const assumed: string[] = [];
  let quality = (x.quality ?? "auto") as keyof typeof CALC_BASE | "auto";
  if (quality === "auto") { quality = "high"; assumed.push("quality auto taken as high"); }
  let w = 1024, h = 1024;
  const m = /^(\d+)x(\d+)$/.exec(x.size ?? "auto");
  if (m) { w = Number(m[1]); h = Number(m[2]); } else assumed.push("size auto taken as 1024x1024");
  const out = outputTokens(x.model, quality, w, h);
  const r = PRICING.rates[familyOf(x.model)];
  const text = Math.ceil((x.promptChars ?? 0) / 4);
  const images = (x.inputImages ?? 0) * EST_IMAGE_INPUT_TOKENS;
  return { dollars: round6((out * r.output + text * r.textInput + images * r.imageInput) / 1e6), outputTokens: out, assumed };
}

/** "$0.06" style, always to the cent, never rounding a nonzero spend down to $0.00. */
export function dollars(x: number): string {
  if (x > 0 && x < 0.005) return "<$0.01";
  return `$${x.toFixed(2)}`;
}
