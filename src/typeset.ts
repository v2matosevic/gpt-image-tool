// Deterministic type + logo compositor: the model paints the plate (e.g. the social-bg-plate
// preset), THIS sets the type — real fonts, exact spelling, exact brand hex, zero garbled glyphs.
// Text is built as SVG and rasterized by `sharp` (the one step that needs it — librsvg + system
// fonts); logo prep and the final composite are our own dependency-free RGBA ops.
// A legibility guard samples the plate under each block and slips a subtle scrim behind type that
// would otherwise sink into a busy or same-tone region.

import { extname } from "node:path";
import { loadRGBA, loadSharp, resizeRGBA, saveImage, type OutFormat, type RGBA } from "./imageops.js";
import { getPlatform, type SafeInsets } from "./platforms.js";

export type OverlayPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "center-left"
  | "center"
  | "center-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export interface TextBlock {
  /** The literal copy — rendered exactly; never passes through the image model. */
  text: string;
  position?: OverlayPosition;
  /** Font family; must be installed on this machine (falls back to system sans). */
  fontFamily?: string;
  /** Px. Default: 1/9 of canvas width for the first block, 1/22 for later blocks. */
  fontSize?: number;
  fontWeight?: number | string;
  color?: string;
  /** One word (or phrase) inside `text` to ink in `accentColor` — the editorial accent. */
  accentWord?: string;
  accentColor?: string;
  /** Extra letter spacing in px (e.g. 2 for airy caps). */
  letterSpacing?: number;
  /** Line height as a multiple of fontSize (default 1.12). */
  lineHeight?: number;
  /** Wrap width as a fraction of the canvas width (default 0.86). */
  maxWidthRatio?: number;
  uppercase?: boolean;
  /** Legibility scrim behind the block: undefined = auto (on when contrast is low), true/false = force. */
  scrim?: boolean;
}

export interface LogoOverlay {
  path: string;
  position?: OverlayPosition;
  /** Logo width as a fraction of canvas width (default 0.14). */
  widthRatio?: number;
  /** 0–1 (default 1). */
  opacity?: number;
}

export interface ComposeOverlayInput {
  imagePath: string;
  blocks?: TextBlock[];
  logo?: LogoOverlay;
  /** Respect this platform's UI safe areas when auto-positioning (e.g. "instagram-story"). */
  platform?: string;
  outputPath?: string;
  format?: OutFormat;
}

export interface ComposeOverlayResult {
  path: string;
  width: number;
  height: number;
  notes: string[];
}

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);
}

// Approximate average glyph advance for a bold sans, in em. Measured against Segoe UI Bold caps —
// deliberately slightly wide so wraps land early (never overflowing) and scrims fully cover.
const GLYPH_EM = 0.6;

/**
 * Greedy word-wrap with an approximate glyph width (~0.6 em + letterSpacing). SVG anchoring keeps
 * alignment exact even when the estimate is off by a few px.
 */
export function wrapText(text: string, fontSize: number, maxWidth: number, letterSpacing = 0): string[] {
  const em = fontSize * GLYPH_EM + letterSpacing;
  const perLine = Math.max(1, Math.floor(maxWidth / em));
  const lines: string[] = [];
  for (const hard of text.split(/\r?\n/)) {
    const words = hard.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const w of words) {
      const candidate = line ? `${line} ${w}` : w;
      if (candidate.length > perLine && line) {
        lines.push(line);
        line = w;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function insetsFor(platform?: string): SafeInsets {
  const base: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  if (!platform) return base;
  return { ...base, ...(getPlatform(platform).safeInsets ?? {}) };
}

/** Everything needed to both draw a block and reason about the pixels beneath it. */
export interface BlockLayout {
  lines: string[];
  fontSize: number;
  lineH: number;
  x: number;
  anchor: "start" | "middle" | "end";
  top: number;
  /** Approximate rendered width of the widest line (same estimate the wrapper uses). */
  estWidth: number;
  height: number;
}

/** Resolve a position keyword to an SVG text anchor + block top inside the safe area. */
function place(
  pos: OverlayPosition,
  canvasW: number,
  canvasH: number,
  blockH: number,
  insets: SafeInsets,
): { x: number; anchor: BlockLayout["anchor"]; top: number } {
  const margin = Math.round(Math.min(canvasW, canvasH) * 0.06);
  const left = Math.round(canvasW * insets.left) + margin;
  const right = canvasW - Math.round(canvasW * insets.right) - margin;
  const top = Math.round(canvasH * insets.top) + margin;
  const bottom = canvasH - Math.round(canvasH * insets.bottom) - margin;

  const [v, h] = pos.split("-").length === 2 ? (pos.split("-") as [string, string]) : ["center", "center"];
  const anchor = h === "left" ? "start" : h === "right" ? "end" : "middle";
  const x = h === "left" ? left : h === "right" ? right : Math.round((left + right) / 2);
  const blockTop = v === "top" ? top : v === "bottom" ? bottom - blockH : Math.round((top + bottom - blockH) / 2);
  return { x, anchor, top: blockTop };
}

/** Lay out one block (wrap + place). Exported for tests. */
export function layoutBlock(b: TextBlock, canvasW: number, canvasH: number, index: number, insets: SafeInsets): BlockLayout {
  const fontSize = b.fontSize ?? Math.round(canvasW / (index === 0 ? 9 : 22));
  const lineH = Math.round(fontSize * (b.lineHeight ?? 1.12));
  const spacing = b.letterSpacing ?? 0;
  const maxWidth = canvasW * (b.maxWidthRatio ?? 0.86) - canvasW * (insets.left + insets.right);
  const text = b.uppercase ? b.text.toUpperCase() : b.text;
  const lines = wrapText(text, fontSize, maxWidth, spacing);
  const height = lines.length * lineH;
  const pos = place(b.position ?? (index === 0 ? "center" : "bottom-center"), canvasW, canvasH, height, insets);
  const estWidth = Math.max(...lines.map((l) => l.length)) * (fontSize * GLYPH_EM + spacing);
  return { lines, fontSize, lineH, x: pos.x, anchor: pos.anchor, top: pos.top, estWidth, height };
}

/** The block's bounding box in canvas pixels (clamped), derived from its anchor + estimate. */
export function blockBox(l: BlockLayout, canvasW: number, canvasH: number): { x0: number; y0: number; x1: number; y1: number } {
  // Widen the estimate a further 8% — a scrim that clips the last glyph is worse than one a
  // little generous, and the width model is only approximate.
  const w = l.estWidth * 1.08;
  const left = l.anchor === "start" ? l.x : l.anchor === "end" ? l.x - w : l.x - w / 2;
  const pad = l.fontSize * 0.2;
  return {
    x0: Math.max(0, Math.round(left - pad)),
    y0: Math.max(0, Math.round(l.top - pad)),
    x1: Math.min(canvasW, Math.round(left + w + pad)),
    y1: Math.min(canvasH, Math.round(l.top + l.height + pad)),
  };
}

function srgbLuminance(r: number, g: number, b: number): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// The two named colors people actually pass; anything else unparseable falls back.
const NAMED_LUMINANCE: Record<string, number> = { white: 1, black: 0 };

function colorLuminance(css: string | undefined, fallback: number): number {
  const c = (css ?? "").trim().toLowerCase();
  if (c in NAMED_LUMINANCE) return NAMED_LUMINANCE[c]!;
  const m = /#([0-9a-f]{6}|[0-9a-f]{3})\b/.exec(c);
  if (!m) return fallback;
  let hex = m[1]!;
  if (hex.length === 3) hex = [...hex].map((ch) => ch + ch).join("");
  const int = parseInt(hex, 16);
  return srgbLuminance(int >> 16, (int >> 8) & 0xff, int & 0xff);
}

/** WCAG-style contrast between the text color and the mean of the plate region under the block. */
export function regionContrast(img: RGBA, box: { x0: number; y0: number; x1: number; y1: number }, textLuminance: number): number {
  let sum = 0;
  let n = 0;
  for (let y = box.y0; y < box.y1; y += 4) {
    for (let x = box.x0; x < box.x1; x += 4) {
      const o = (y * img.width + x) * 4;
      sum += srgbLuminance(img.data[o]!, img.data[o + 1]!, img.data[o + 2]!);
      n++;
    }
  }
  if (!n) return 21;
  const bg = sum / n;
  const [hi, lo] = bg > textLuminance ? [bg, textLuminance] : [textLuminance, bg];
  return (hi + 0.05) / (lo + 0.05);
}

// Display type is huge; below ~2.5:1 even a headline melts into the plate.
const MIN_DISPLAY_CONTRAST = 2.5;

function accentTspans(line: string, accentWord: string | undefined, accentColor: string | undefined, uppercase: boolean): string {
  if (!accentWord || !accentColor) return escapeXml(line);
  const target = (uppercase ? accentWord.toUpperCase() : accentWord).trim();
  if (!target) return escapeXml(line);
  // Whole-word match only — 'art' must not ink the tail of 'SMART'.
  const esc = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = line.split(new RegExp(`(?<![\\p{L}\\p{N}])(${esc})(?![\\p{L}\\p{N}])`, "iu"));
  return parts
    .map((p) => (p.toLowerCase() === target.toLowerCase() ? `<tspan fill="${escapeXml(accentColor)}">${escapeXml(p)}</tspan>` : escapeXml(p)))
    .join("");
}

function blockSvg(b: TextBlock, l: BlockLayout, withScrim: boolean, canvasW: number, canvasH: number): string {
  const family = b.fontFamily ? `${escapeXml(b.fontFamily)}, ` : "";
  const weight = b.fontWeight ?? 700;
  const fill = b.color ?? "#111111";
  const spacing = b.letterSpacing ?? 0;

  let scrim = "";
  if (withScrim) {
    const box = blockBox(l, canvasW, canvasH);
    const dark = colorLuminance(fill, 0.05) < 0.5;
    // Dark type gets a soft light plate; light type a soft dark one. A designer-legit treatment,
    // not a hack — and it needs no SVG filters (librsvg-safe).
    const scrimFill = dark ? "rgba(255,255,255,0.62)" : "rgba(0,0,0,0.38)";
    const r = Math.round(l.fontSize * 0.25);
    scrim = `<rect x="${box.x0}" y="${box.y0}" width="${box.x1 - box.x0}" height="${box.y1 - box.y0}" rx="${r}" fill="${scrimFill}"/>`;
  }

  const tspans = l.lines
    .map((line, i) => {
      // Baseline ≈ 0.8em below the line's top — close enough across sans faces.
      const y = l.top + i * l.lineH + Math.round(l.fontSize * 0.8);
      return `<tspan x="${l.x}" y="${y}">${accentTspans(line, b.accentWord, b.accentColor, Boolean(b.uppercase))}</tspan>`;
    })
    .join("");
  return (
    scrim +
    `<text text-anchor="${l.anchor}" font-family="${family}'Segoe UI', 'Helvetica Neue', Arial, sans-serif" ` +
    `font-size="${l.fontSize}" font-weight="${weight}" fill="${escapeXml(fill)}"` +
    (spacing ? ` letter-spacing="${spacing}"` : "") +
    `>${tspans}</text>`
  );
}

/** SVG from precomputed layouts — the layout pass runs ONCE (scrim decisions reuse the same). */
function svgFromLayouts(blocks: TextBlock[], layouts: BlockLayout[], canvasW: number, canvasH: number, scrims?: boolean[]): string {
  const inner = blocks.map((b, i) => blockSvg(b, layouts[i]!, scrims?.[i] ?? false, canvasW, canvasH)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">${inner}</svg>`;
}

/** Full-canvas SVG containing every text block. `scrims[i]` forces/suppresses each block's scrim. */
export function buildOverlaySvg(
  blocks: TextBlock[],
  canvasW: number,
  canvasH: number,
  insets: SafeInsets,
  scrims?: boolean[],
): string {
  const layouts = blocks.map((b, i) => layoutBlock(b, canvasW, canvasH, i, insets));
  return svgFromLayouts(blocks, layouts, canvasW, canvasH, scrims);
}

/** Composite `src` over `dst` at (ox,oy), straight source-over. */
function blitOver(dst: RGBA, src: RGBA, ox: number, oy: number): void {
  for (let y = 0; y < src.height; y++) {
    const dy = oy + y;
    if (dy < 0 || dy >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = ox + x;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      const d = (dy * dst.width + dx) * 4;
      const sa = src.data[s + 3]! / 255;
      if (sa === 0) continue;
      const da = dst.data[d + 3]! / 255;
      const oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        dst.data[d + c] = Math.round((src.data[s + c]! * sa + dst.data[d + c]! * da * (1 - sa)) / (oa || 1));
      }
      dst.data[d + 3] = Math.round(oa * 255);
    }
  }
}

function scaleAlpha(img: RGBA, opacity: number): RGBA {
  const out = { ...img, data: Buffer.from(img.data) };
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = Math.round(out.data[i]! * opacity);
  return out;
}

function overlayOutPath(src: string): string {
  return src.slice(0, src.length - extname(src).length) + "-final.png";
}

/** Output format from a file extension — recognizes jpg/jpeg/webp, defaults to png. */
export function formatFromPath(p: string): OutFormat {
  const e = extname(p).toLowerCase();
  if (e === ".jpg" || e === ".jpeg") return "jpeg";
  if (e === ".webp") return "webp";
  return "png";
}

/**
 * Composite exact text (and optionally the real logo asset) onto an image. This is the
 * deterministic half of the social pipeline: generate a plate with the model, set the type here.
 */
export async function composeOverlay(input: ComposeOverlayInput): Promise<ComposeOverlayResult> {
  const blocks = input.blocks ?? [];
  if (!blocks.length && !input.logo) throw new Error("composeOverlay needs at least one text block or a logo.");
  const notes: string[] = [];
  const base = await loadRGBA(input.imagePath);
  const insets = insetsFor(input.platform);

  // 1. Text: SVG → raster (sharp/librsvg is the only way to get real font shaping).
  if (blocks.length) {
    const sharp = await loadSharp();
    if (!sharp) {
      throw new Error("compose_overlay text needs `sharp` installed (`npm i sharp`) to rasterize SVG type.");
    }
    // Legibility guard: one layout pass; measure contrast under each block, decide scrims, render.
    const layouts = blocks.map((b, i) => layoutBlock(b, base.width, base.height, i, insets));
    const scrims = blocks.map((b, i) => {
      if (b.scrim != null) return b.scrim;
      const contrast = regionContrast(base, blockBox(layouts[i]!, base.width, base.height), colorLuminance(b.color, 0.05));
      if (contrast < MIN_DISPLAY_CONTRAST) {
        notes.push(
          `Block "${b.text.slice(0, 24)}…" contrast ${contrast.toFixed(1)}:1 < ${MIN_DISPLAY_CONTRAST}:1 — auto-scrim added (override with scrim:false).`,
        );
        return true;
      }
      return false;
    });
    const svg = svgFromLayouts(blocks, layouts, base.width, base.height, scrims);
    const { data, info } = await sharp(Buffer.from(svg), { density: 72 })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    blitOver(base, { width: info.width, height: info.height, data: Buffer.from(data) }, 0, 0);
    notes.push("Text set deterministically (real fonts) — spelling is exact by construction.");
    for (const b of blocks) {
      if (b.fontFamily) notes.push(`Font "${b.fontFamily}" must be installed on this machine (silent fallback to system sans otherwise).`);
    }
  }

  // 2. Logo: dependency-free resize + alpha blit of the REAL asset.
  if (input.logo) {
    const raw = await loadRGBA(input.logo.path);
    const targetW = Math.max(1, Math.round(base.width * (input.logo.widthRatio ?? 0.14)));
    const targetH = Math.max(1, Math.round(raw.height * (targetW / raw.width)));
    let logo = resizeRGBA(raw, targetW, targetH);
    if (input.logo.opacity != null && input.logo.opacity < 1) logo = scaleAlpha(logo, Math.max(0, input.logo.opacity));
    const pos = place(input.logo.position ?? "bottom-center", base.width, base.height, targetH, insets);
    const x = pos.anchor === "start" ? pos.x : pos.anchor === "end" ? pos.x - targetW : pos.x - Math.round(targetW / 2);
    blitOver(base, logo, x, pos.top);
    notes.push("Logo composited from the real asset (never model-drawn).");
  }

  if (input.platform) notes.push(`Overlays kept inside ${input.platform} safe areas.`);

  const outPath = input.outputPath ?? overlayOutPath(input.imagePath);
  const format: OutFormat = input.format ?? formatFromPath(outPath);
  await saveImage(base, outPath, format);
  return { path: outPath, width: base.width, height: base.height, notes };
}
