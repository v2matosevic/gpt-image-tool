// Which renderer a Studio slot uses, and what an API slot is expected to cost.
//
// The subscription is the default renderer everywhere (the owner, 2026-11-28: "for simple day-to-day
// images always use the subscription"). The paid API is used only where a node says so: renderer
// "api" on a generate, edit or process node, or a finish node, which is API by definition. The
// project profile can hold API defaults (model, quality, size, complexity) and spend limits under
// "studio", but never the renderer itself, so no project can be defaulted to paid rendering.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_API_MODEL, customSizeProblem, resolveImageModel } from "../models.js";
import { estimateCost } from "../pricing.js";
import { getPreset } from "../presets/index.js";
import { getPlatform } from "../platforms.js";
import { findProfilePath } from "../profile.js";
import { SIZES } from "./nodes.js";
import type { Issue, RenderInfo } from "./types.js";

export const SUBSCRIPTION_MODEL = "gpt-image-2 (server-chosen)";
export const SUBSCRIPTION_RENDER: RenderInfo = { renderer: "subscription", model: SUBSCRIPTION_MODEL };

/** Defaults when the profile does not set them. The owner accepted run and day on 2026-11-28; the ceiling is the orchestrating agent's default. */
export const DEFAULT_LIMITS = { run: 2, day: 10, ceiling: 50 } as const;

const sizeStr = z.string().refine(v => (SIZES as readonly string[]).includes(v) || !customSizeProblem(v), v => ({ message: customSizeProblem(v) ?? `bad size ${v}` }));
const money = z.number().finite().min(0).max(10_000);
export const studioProfileSchema = z.object({
  api: z.object({
    model: z.string().trim().min(1).max(80),
    quality: z.enum(["low", "medium", "high", "xhigh", "max", "auto"]),
    size: sizeStr,
    complexity: z.enum(["low", "medium", "high"]),
  }).partial().strict(),
  limits: z.object({ run: money, day: money, ceiling: money }).partial().strict(),
}).partial().strict();

export interface StudioProfile {
  api: { model?: string; quality?: string; size?: string; complexity?: string };
  limits: { run: number; day: number; ceiling: number };
  path?: string;
  issue?: Issue;
}

/** The "studio" block of the project's .gptimage.json, validated. A broken block is reported as
 *  an issue on API nodes (and refuses API runs) rather than silently ignored. */
export function studioProfile(dir: string): StudioProfile {
  const out: StudioProfile = { api: {}, limits: { ...DEFAULT_LIMITS } };
  const path = findProfilePath(join(dir, "assets"));
  if (!path) return out;
  out.path = path;
  let raw: any;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { return out; }
  if (!raw || typeof raw !== "object" || raw.studio === undefined) return out;
  if (raw.studio && typeof raw.studio === "object" && "renderer" in raw.studio) {
    out.issue = { path: `${path} studio.renderer`, message: "a project-wide renderer is not supported: the subscription stays the default", fix: 'Remove studio.renderer and set renderer:"api" on the nodes that need paid quality (or use a finish node).' };
    return out;
  }
  const parsed = studioProfileSchema.safeParse(raw.studio);
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    out.issue = { path: `${path} studio.${i.path.join(".")}`, message: i.message, fix: "Fix the studio block: {api:{model, quality, size, complexity}, limits:{run, day, ceiling}} (dollars)." };
    return out;
  }
  out.api = parsed.data.api ?? {};
  out.limits = { ...DEFAULT_LIMITS, ...(parsed.data.limits ?? {}) };
  if (out.limits.day > out.limits.ceiling) out.limits.day = out.limits.ceiling;
  if (out.limits.run > out.limits.day) out.limits.run = out.limits.day;
  return out;
}

/** A size that keeps an image's aspect with the long edge at `long` px, in multiples of 16 and
 *  inside the API limits. Unknown dimensions give a square. */
export function sizeForLongEdge(width: number | undefined, height: number | undefined, long = 2048): string {
  if (!width || !height) return `${long}x${long}`;
  const r = Math.min(3, Math.max(1 / 3, width / height));
  const r16 = (x: number) => Math.max(16, Math.round(x / 16) * 16);
  let w = r >= 1 ? long : r16(long * r), h = r >= 1 ? r16(long / r) : long;
  while (w * h < 655_360) { w += 16; h = r16(w / r); }
  return `${w}x${h}`;
}

/** The size the compiler will use for a generate slot, made explicit so the estimate and the
 *  request agree: node or style size, then the API default, platform, preset, 1024x1024. */
export function generateSize(settings: Record<string, any>, preset: string | undefined, apiDefault?: string): string {
  if (typeof settings.size === "string") return settings.size;
  if (apiDefault) return apiDefault;
  if (typeof settings.platform === "string") { try { return getPlatform(settings.platform).size; } catch { /* validated elsewhere */ } }
  const p = preset ? getPreset(preset) : undefined;
  return p?.recommended.size ?? "1024x1024";
}

/** The render a node's slot uses. undefined = the subscription. */
export function apiRender(type: string, settings: Record<string, any>, prof: StudioProfile, x: { preset?: string; image?: { width?: number; height?: number } }): RenderInfo | undefined {
  const api = type === "finish" || settings.renderer === "api";
  if (!api) return undefined;
  const model = resolveImageModel(settings.model ?? prof.api.model ?? DEFAULT_API_MODEL, "apikey", {})!;
  const r: RenderInfo = { renderer: "api", model };
  if (type === "finish") {
    r.quality = settings.quality ?? "high";
    r.size = settings.size ?? sizeForLongEdge(x.image?.width, x.image?.height, 2048);
    r.complexity = settings.complexity ?? "low";
  } else if (type === "process") {
    r.quality = settings.quality ?? "high";
    r.size = settings.size ?? (settings.op === "upscale" ? sizeForLongEdge(x.image?.width, x.image?.height, 2048) : undefined);
    if (settings.complexity ?? prof.api.complexity) r.complexity = settings.complexity ?? prof.api.complexity;
  } else {
    r.quality = settings.quality ?? prof.api.quality ?? "low";
    r.size = type === "generate" ? generateSize(settings, x.preset, prof.api.size) : settings.size ?? prof.api.size;
    if (settings.complexity ?? prof.api.complexity) r.complexity = settings.complexity ?? prof.api.complexity;
  }
  for (const k of Object.keys(r) as (keyof RenderInfo)[]) if (r[k] === undefined) delete r[k];
  return r;
}

/** Estimated dollars for one slot rendered with `render`. */
export function estimateSlot(render: RenderInfo, x: { promptChars?: number; inputImages?: number }): number {
  return estimateCost({ model: render.model, quality: render.quality, size: render.size, promptChars: x.promptChars ?? 600, inputImages: x.inputImages ?? 0 }).dollars;
}

/** "api sunburst-2.6 high 2048x2048" style label for snapshots and run text. */
export function renderLabel(r: RenderInfo | undefined): string {
  if (!r || r.renderer === "subscription") return "subscription";
  const short = r.model.replace(/^gpt-image-/, "");
  return ["api", short, r.quality, r.size, r.complexity && `complexity ${r.complexity}`].filter(Boolean).join(" ");
}
