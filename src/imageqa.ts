import { decodeRGBA, resizeRGBA, type RGBA } from "./imageops.js";
import type { ImageFormat } from "./providers/types.js";
import { paletteFromRGBA } from "./palette.js";

export function actualFormat(bytes: Buffer): ImageFormat {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes[0] === 255 && bytes[1] === 216) return "jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  throw new Error("Provider returned an unsupported image format.");
}

export function alphaBounds(img: RGBA, threshold = 8) {
  let left = img.width, top = img.height, right = -1, bottom = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (img.data[(y * img.width + x) * 4 + 3]! <= threshold) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return right < 0 ? null : { left, top, width: right - left + 1, height: bottom - top + 1 };
}

export function inspectRGBA(img: RGBA) {
  let transparent = 0, partial = 0;
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] === 0) transparent++;
    else if (img.data[i]! < 255) partial++;
  }
  const bounds = alphaBounds(img);
  return {
    width: img.width, height: img.height,
    hasTransparency: transparent + partial > 0,
    transparentFraction: transparent / (img.width * img.height),
    partialAlphaFraction: partial / (img.width * img.height),
    bounds,
    touchesEdge: Boolean(bounds && (bounds.left === 0 || bounds.top === 0 || bounds.left + bounds.width === img.width || bounds.top + bounds.height === img.height)),
  };
}

export async function inspectBytes(bytes: Buffer) { return inspectRGBA(await decodeRGBA(bytes)); }
export type ImageQA = ReturnType<typeof inspectRGBA> & { warnings: string[]; preservedOutsideMask?: boolean; outsideMaskMeanDifference?: number;
  palette?: ReturnType<typeof paletteCheck>; edges?: ReturnType<typeof edgeCheck> };

function lab(hex: string) {
  const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb as [number, number, number];
  const xyz = [(r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047, r * 0.2126729 + g * 0.7151522 + b * 0.072175, (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883];
  const f = xyz.map(t => t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
  return [116 * f[1]! - 16, 500 * (f[0]! - f[1]!), 200 * (f[1]! - f[2]!)];
}

export function deltaE76(a: string, b: string): number { const x = lab(a), y = lab(b); return Math.hypot(...x.map((v, i) => v - y[i]!)); }

/** Diagnostic only: lighting, antialiasing and texture legitimately change observed colors. */
export function paletteCheck(img: RGBA, colors: Array<{ name: string; hex: string }>) {
  const matches = paletteFromRGBA([img]).map(hex => {
    const nearest = colors.map(c => ({ ...c, delta: deltaE76(hex, c.hex) })).sort((a, b) => a.delta - b.delta)[0];
    return { observed: hex, nearest: nearest?.name, expected: nearest?.hex, deltaE: nearest?.delta };
  });
  return { metric: "CIE76 Lab D65", matches, maxDeltaE: Math.max(0, ...matches.map(m => m.deltaE ?? 0)), note: "Measured color difference, not a brand-fidelity verdict; shadows and materials change colors." };
}

export function edgeCheck(img: RGBA, key?: { r: number; g: number; b: number }) {
  let darkPartialPixels = 0, chromaPartialPixels = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3]!;
    if (a === 0 || a === 255) continue;
    const [r, g, b] = [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
    if (Math.max(r, g, b) < 24) darkPartialPixels++;
    if (key && Math.hypot(r - key.r, g - key.g, b - key.b) < 90) chromaPartialPixels++;
  }
  return { darkPartialPixels, chromaPartialPixels, note: "Edge candidates only. Dark artwork has legitimate dark partial-alpha pixels; inspect on light and dark grounds." };
}

export function smallSizeCheck(img: RGBA, size: number) {
  const small = resizeRGBA(img, Math.max(1, Math.round(size * img.width / Math.max(img.width, img.height))), Math.max(1, Math.round(size * img.height / Math.max(img.width, img.height))));
  const count = small.width * small.height, seen = new Uint8Array(count);
  const ink = (i: number) => small.data[i * 4 + 3]! >= 96;
  let components = 0, covered = 0;
  for (let i = 0; i < count; i++) {
    if (ink(i)) covered++;
    if (seen[i] || !ink(i)) continue;
    components++; const queue = [i]; seen[i] = 1;
    for (let q = 0; q < queue.length; q++) {
      const p = queue[q]!, x = p % small.width, y = Math.floor(p / small.width);
      for (const n of [x > 0 ? p - 1 : -1, x + 1 < small.width ? p + 1 : -1, y > 0 ? p - small.width : -1, y + 1 < small.height ? p + small.width : -1]) {
        if (n >= 0 && !seen[n] && ink(n)) { seen[n] = 1; queue.push(n); }
      }
    }
  }
  const inkCoverage = covered / count;
  return { size, width: small.width, height: small.height, inkCoverage, components,
    warnings: inkCoverage < 0.08 || inkCoverage > 0.85 ? ["Very little or very dense ink at this size; inspect legibility."] : [] };
}
