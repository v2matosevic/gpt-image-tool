// Deterministic type + logo compositor: the model paints the plate (e.g. the social-bg-plate
// preset), THIS sets the type — real fonts, exact spelling, exact brand hex, zero garbled glyphs.
// Text is built as SVG and rasterized by `sharp` (the one step that needs it — librsvg + system
// fonts); logo prep and the final composite are our own dependency-free RGBA ops.

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
  /** Extra letter spacing in px (e.g. 2 for airy caps). */
  letterSpacing?: number;
  /** Line height as a multiple of fontSize (default 1.12). */
  lineHeight?: number;
  /** Wrap width as a fraction of the canvas width (default 0.86). */
  maxWidthRatio?: number;
  uppercase?: boolean;
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

/**
 * Greedy word-wrap with an approximate glyph width (bold sans ≈ 0.56 em + letterSpacing). SVG
 * anchoring keeps alignment exact even when the estimate is off by a few px.
 */
export function wrapText(text: string, fontSize: number, maxWidth: number, letterSpacing = 0): string[] {
  const em = fontSize * 0.56 + letterSpacing;
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

interface Placed {
  x: number; // anchor x
  anchor: "start" | "middle" | "end";
  top: number; // top of the block
}

/** Resolve a position keyword to an SVG text anchor + block top inside the safe area. */
function place(pos: OverlayPosition, canvasW: number, canvasH: number, blockH: number, insets: SafeInsets): Placed {
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

function blockToSvg(b: TextBlock, canvasW: number, canvasH: number, index: number, insets: SafeInsets): string {
  const fontSize = b.fontSize ?? Math.round(canvasW / (index === 0 ? 9 : 22));
  const lineH = Math.round(fontSize * (b.lineHeight ?? 1.12));
  const spacing = b.letterSpacing ?? 0;
  const maxWidth = canvasW * (b.maxWidthRatio ?? 0.86) - canvasW * (insets.left + insets.right);
  const text = b.uppercase ? b.text.toUpperCase() : b.text;
  const lines = wrapText(text, fontSize, maxWidth, spacing);
  const blockH = lines.length * lineH;
  const pos = place(b.position ?? (index === 0 ? "center" : "bottom-center"), canvasW, canvasH, blockH, insets);
  const family = b.fontFamily ? `${escapeXml(b.fontFamily)}, ` : "";
  const weight = b.fontWeight ?? 700;
  const fill = b.color ?? "#111111";

  const tspans = lines
    .map((line, i) => {
      // Baseline ≈ 0.8em below the line's top — close enough across sans faces.
      const y = pos.top + i * lineH + Math.round(fontSize * 0.8);
      return `<tspan x="${pos.x}" y="${y}">${escapeXml(line)}</tspan>`;
    })
    .join("");
  return (
    `<text text-anchor="${pos.anchor}" font-family="${family}'Segoe UI', 'Helvetica Neue', Arial, sans-serif" ` +
    `font-size="${fontSize}" font-weight="${weight}" fill="${escapeXml(fill)}"` +
    (spacing ? ` letter-spacing="${spacing}"` : "") +
    `>${tspans}</text>`
  );
}

/** Full-canvas SVG containing every text block. Exported for tests. */
export function buildOverlaySvg(blocks: TextBlock[], canvasW: number, canvasH: number, insets: SafeInsets): string {
  const inner = blocks.map((b, i) => blockToSvg(b, canvasW, canvasH, i, insets)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">${inner}</svg>`;
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
    const svg = buildOverlaySvg(blocks, base.width, base.height, insets);
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
  const format: OutFormat = input.format ?? (extname(outPath).toLowerCase() === ".jpg" || extname(outPath).toLowerCase() === ".jpeg" ? "jpeg" : "png");
  await saveImage(base, outPath, format);
  return { path: outPath, width: base.width, height: base.height, notes };
}
