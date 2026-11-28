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

// ---------------------------------------------------------------- look readings (Studio instruments)
// Local measurements of what an agent cannot reliably eyeball in a downsized view. They are
// measurements, not a quality score: a low-contrast or off-centre image is not a worse image.

export interface LookReading {
  version: 1;
  source: "local";
  width: number;
  height: number;
  /** Dominant colours with their share of (opaque) pixels, largest first. */
  palette: Array<{ hex: string; share: number }>;
  /** CIE L* (0-100) of opaque pixels; key from the median: low below 35, high above 65. */
  luminance: { mean: number; median: number; p5: number; p95: number; key: "low" | "mid" | "high"; histogram: number[] };
  /** RMS contrast of L* / 100, and the p5 to p95 L* range. */
  contrast: { rms: number; range: number };
  /** Mean b* (yellow positive, blue negative) as warmth; mean chroma C* as saturation. */
  color: { warmth: number; temperature: "warm" | "neutral" | "cool"; chroma: number; saturation: "muted" | "moderate" | "vivid" };
  /** Visual weight per thirds cell (row-major, sums to 1), its centroid (0..1), and the share of quiet area. */
  composition: { thirds: number[]; centroid: { x: number; y: number }; heaviest: string; negativeSpace: number };
  /** Relative sharpness per thirds cell (max = 1), and max/min ratio as a focus-separation measure. */
  sharpness: { thirds: number[]; sharpest: string; separation: number };
  /** Share of pixels on a strong edge: a proxy for detail density. */
  detail: { edgeDensity: number };
  /** Share of opaque pixels per colour family (HSV hue, saturation >= 0.25, value >= 0.15). Optional:
   *  readings stored before 2026-11-28 lack it. */
  hues?: Record<HueFamily, number>;
  /** Share of opaque pixels per 5-degree hue bin (72 bins from 0), same saturation and value floor. */
  hueHistogram?: number[];
}

export const HUE_FAMILIES = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"] as const;
export type HueFamily = (typeof HUE_FAMILIES)[number];
/** Upper hue bound (degrees) of each family, in ring order; red wraps around 345. */
const HUE_BOUNDS: Array<[number, HueFamily]> = [[15, "red"], [45, "orange"], [70, "yellow"], [170, "green"], [200, "cyan"], [260, "blue"], [290, "purple"], [345, "pink"], [360, "red"]];

/** Hue range of each family in degrees, [from, to); red wraps through 0. */
export const HUE_RANGES: Record<HueFamily, [number, number]> = { red: [345, 375], orange: [15, 45], yellow: [45, 70], green: [70, 170], cyan: [170, 200], blue: [200, 260], purple: [260, 290], pink: [290, 345] };

export function hueFamilyShares(img: RGBA): Record<HueFamily, number> { return hueReading(img).hues; }

export function hueReading(img: RGBA): { hues: Record<HueFamily, number>; hueHistogram: number[] } {
  const counts = Object.fromEntries(HUE_FAMILIES.map(f => [f, 0])) as Record<HueFamily, number>;
  const bins: number[] = new Array(72).fill(0);
  const { data } = img;
  let opaque = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 128) continue;
    opaque++;
    const r = data[i]! / 255, g = data[i + 1]! / 255, b = data[i + 2]! / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (max < 0.15 || d / max < 0.25) continue;
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    counts[HUE_BOUNDS.find(([hi]) => h < hi)![1]]++;
    bins[Math.min(71, Math.floor(h / 5))]!++;
  }
  for (const f of HUE_FAMILIES) counts[f] = r3(opaque ? counts[f] / opaque : 0);
  return { hues: counts, hueHistogram: bins.map(c => Math.round((opaque ? c / opaque : 0) * 10000) / 10000) };
}

const CELLS = ["top-left", "top-centre", "top-right", "middle-left", "centre", "middle-right", "bottom-left", "bottom-centre", "bottom-right"];
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function srgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047, y = R * 0.2126729 + G * 0.7151522 + B * 0.072175, z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const f = (t: number) => (t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

export function readLook(src: RGBA): LookReading {
  const scale = Math.min(1, 256 / Math.max(src.width, src.height));
  const img = scale < 1 ? resizeRGBA(src, Math.max(1, Math.round(src.width * scale)), Math.max(1, Math.round(src.height * scale))) : src;
  const { width: w, height: h, data } = img;
  const n = w * h;
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n), opaque = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const lab = srgbToLab(data[i * 4]!, data[i * 4 + 1]!, data[i * 4 + 2]!);
    L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2];
    if (data[i * 4 + 3]! >= 128) { opaque[i] = 1; count++; }
  }
  if (!count) { opaque.fill(1); count = n; }
  const Ls: number[] = [];
  let sumL = 0, sumB = 0, sumC = 0;
  for (let i = 0; i < n; i++) if (opaque[i]) { Ls.push(L[i]!); sumL += L[i]!; sumB += B[i]!; sumC += Math.hypot(A[i]!, B[i]!); }
  Ls.sort((a, b) => a - b);
  const q = (p: number) => Ls[Math.min(Ls.length - 1, Math.floor(p * Ls.length))]!;
  const meanL = sumL / count;
  let varL = 0;
  for (let i = 0; i < n; i++) if (opaque[i]) varL += (L[i]! - meanL) ** 2;
  const histogram: number[] = Array(8).fill(0);
  for (const l of Ls) histogram[Math.min(7, Math.floor(Math.max(0, l) / 12.5))]!++;
  const median = q(0.5);
  const warmth = sumB / count, chroma = sumC / count;

  // Palette with shares: the median-cut palette, then each opaque pixel assigned to its nearest colour.
  const hexes = paletteFromRGBA([img], 5, { includeNeutrals: true });
  const centres = hexes.map(hx => [parseInt(hx.slice(1, 3), 16), parseInt(hx.slice(3, 5), 16), parseInt(hx.slice(5, 7), 16)] as const);
  const counts: number[] = new Array(centres.length).fill(0);
  for (let i = 0; i < n; i++) {
    if (!opaque[i]) continue;
    let best = 0, bd = Infinity;
    for (let k = 0; k < centres.length; k++) {
      const c = centres[k]!, d = (data[i * 4]! - c[0]) ** 2 + (data[i * 4 + 1]! - c[1]) ** 2 + (data[i * 4 + 2]! - c[2]) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    counts[best]!++;
  }
  const merged = new Map<string, number>();
  hexes.forEach((hex, k) => merged.set(hex, (merged.get(hex) ?? 0) + counts[k]!));
  const palette = [...merged].map(([hex, c]) => ({ hex, share: r3(c / count) })).filter(p => p.share > 0).sort((a, b) => b.share - a.share);

  // Sobel gradient on L* for sharpness, detail and visual weight.
  const grad = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = L[i - w + 1]! + 2 * L[i + 1]! + L[i + w + 1]! - L[i - w - 1]! - 2 * L[i - 1]! - L[i + w - 1]!;
    const gy = L[i + w - 1]! + 2 * L[i + w]! + L[i + w + 1]! - L[i - w - 1]! - 2 * L[i - w]! - L[i - w + 1]!;
    grad[i] = Math.hypot(gx, gy);
  }
  const cellOf = (x: number, y: number) => Math.min(2, Math.floor((y / h) * 3)) * 3 + Math.min(2, Math.floor((x / w) * 3));
  const weight: number[] = new Array(9).fill(0), sharp: number[] = new Array(9).fill(0), sharpN: number[] = new Array(9).fill(0);
  let wx = 0, wy = 0, wsum = 0, edges = 0, inner = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!opaque[i]) continue;
    // Weight: departure from the mean tone, plus colourfulness, plus local detail.
    const wt = Math.abs(L[i]! - meanL) + 0.5 * Math.hypot(A[i]!, B[i]!) + 0.25 * grad[i]!;
    const c = cellOf(x, y);
    weight[c]! += wt; wx += wt * (x + 0.5) / w; wy += wt * (y + 0.5) / h; wsum += wt;
    if (x > 0 && y > 0 && x < w - 1 && y < h - 1) { inner++; sharp[c]! += grad[i]! ** 2; sharpN[c]!++; if (grad[i]! > 40) edges++; }
  }
  const thirds = weight.map(v => r3(wsum ? v / wsum : 1 / 9));
  const sh = sharp.map((v, k) => (sharpN[k] ? v / sharpN[k]! : 0));
  const shMax = Math.max(...sh) || 1;
  const shMin = Math.max(1e-6, Math.min(...sh.map(v => Math.max(v, shMax * 1e-4))));
  // Negative space: blocks with little tonal variation and no strong edge.
  const bs = Math.max(4, Math.round(Math.max(w, h) / 16));
  let quiet = 0, blocks = 0;
  for (let by = 0; by < h; by += bs) for (let bx = 0; bx < w; bx += bs) {
    let s = 0, s2 = 0, g = 0, k = 0;
    for (let y = by; y < Math.min(h, by + bs); y++) for (let x = bx; x < Math.min(w, bx + bs); x++) {
      const i = y * w + x;
      if (!opaque[i]) continue;
      s += L[i]!; s2 += L[i]! ** 2; g = Math.max(g, grad[i]!); k++;
    }
    if (!k) continue;
    blocks++;
    if (Math.sqrt(Math.max(0, s2 / k - (s / k) ** 2)) < 4 && g < 40) quiet++;
  }
  const heaviest = thirds.indexOf(Math.max(...thirds));
  const sharpest = sh.indexOf(Math.max(...sh));
  return {
    version: 1, source: "local", width: src.width, height: src.height, palette,
    luminance: { mean: r3(meanL), median: r3(median), p5: r3(q(0.05)), p95: r3(q(0.95)), key: median < 35 ? "low" : median > 65 ? "high" : "mid", histogram: histogram.map(v => r3(v / count)) },
    contrast: { rms: r3(Math.sqrt(varL / count) / 100), range: r3(q(0.95) - q(0.05)) },
    color: { warmth: r3(warmth), temperature: warmth > 8 ? "warm" : warmth < -4 ? "cool" : "neutral", chroma: r3(chroma), saturation: chroma < 15 ? "muted" : chroma > 40 ? "vivid" : "moderate" },
    composition: { thirds, centroid: { x: r3(wsum ? wx / wsum : 0.5), y: r3(wsum ? wy / wsum : 0.5) }, heaviest: CELLS[heaviest]!, negativeSpace: r3(blocks ? quiet / blocks : 0) },
    sharpness: { thirds: sh.map(v => r3(v / shMax)), sharpest: CELLS[sharpest]!, separation: r3(Math.min(9999, shMax / shMin)) },
    detail: { edgeDensity: r3(inner ? edges / inner : 0) },
    ...hueReading(img),
  };
}

/** One short line an agent can read: the measurements, no verdict. */
export function lookSummary(r: LookReading): string {
  return `${r.luminance.key} key (L* median ${Math.round(r.luminance.median)}), contrast ${r.contrast.rms.toFixed(2)}, ${r.color.temperature}, ${r.color.saturation}; ` +
    `weight ${r.composition.heaviest}, ${Math.round(r.composition.negativeSpace * 100)}% quiet; sharpest ${r.sharpness.sharpest} (${r.sharpness.separation >= 100 ? ">100" : r.sharpness.separation.toFixed(1)}x the softest); ` +
    `palette ${r.palette.slice(0, 4).map(p => `${p.hex} ${Math.round(p.share * 100)}%`).join(", ")}`;
}

export interface DriftFlag { measure: string; anchor: string; take: string; note: string }

/** Compare a take's reading with its anchor's. Coarse thresholds; identity of a face, character or
 *  product cannot be measured here and needs a pairwise look. */
export function lookDrift(take: LookReading, anchor: LookReading): DriftFlag[] {
  const flags: DriftFlag[] = [];
  const pal = (from: LookReading, to: LookReading) => from.palette.reduce((s, p) => s + p.share * Math.min(...to.palette.map(o => deltaE76(p.hex, o.hex))), 0);
  const pd = (pal(take, anchor) + pal(anchor, take)) / 2;
  if (pd > 15) flags.push({ measure: "palette", anchor: anchor.palette.slice(0, 3).map(p => p.hex).join(" "), take: take.palette.slice(0, 3).map(p => p.hex).join(" "), note: `palette moved (mean ΔE ${pd.toFixed(1)})` });
  // Mean, not median: the median jumps between modes on a two-tone image.
  if (Math.abs(take.luminance.mean - anchor.luminance.mean) > 12) flags.push({ measure: "key", anchor: `${anchor.luminance.key} (mean L* ${Math.round(anchor.luminance.mean)})`, take: `${take.luminance.key} (mean L* ${Math.round(take.luminance.mean)})`, note: "overall lightness changed" });
  if (Math.abs(take.contrast.rms - anchor.contrast.rms) > 0.08) flags.push({ measure: "contrast", anchor: anchor.contrast.rms.toFixed(2), take: take.contrast.rms.toFixed(2), note: "contrast changed" });
  if (Math.abs(take.color.warmth - anchor.color.warmth) > 8) flags.push({ measure: "temperature", anchor: `${anchor.color.temperature} (b* ${anchor.color.warmth.toFixed(0)})`, take: `${take.color.temperature} (b* ${take.color.warmth.toFixed(0)})`, note: "colour temperature moved" });
  if (Math.abs(take.color.chroma - anchor.color.chroma) > 12) flags.push({ measure: "saturation", anchor: anchor.color.saturation, take: take.color.saturation, note: "saturation changed" });
  return flags;
}
