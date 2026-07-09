// Brand-palette extraction: median-cut quantization over the project's styleReference images, so
// generations can anchor to the actual brand colors without anyone hand-writing hex codes.
// Dependency-free for PNG (jpeg/webp input uses `sharp` when installed, same as imageops).

import { stat } from "node:fs/promises";
import { loadRGBA, resizeRGBA, type RGBA } from "./imageops.js";

type Pixel = [number, number, number];

const SAMPLE_EDGE = 64; // downsample refs to ≤64px on the long edge before quantizing

/** Near-white/near-black, near-transparent pixels are background/paper, not brand. */
function isBrandPixel(r: number, g: number, b: number, a: number): boolean {
  if (a < 128) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  if (max > 240 && sat < 0.08) return false; // near-white
  if (max < 18) return false; // near-black
  return true;
}

function collectPixels(img: RGBA): Pixel[] {
  const scale = Math.max(img.width, img.height) / SAMPLE_EDGE;
  const small = scale > 1 ? resizeRGBA(img, Math.max(1, Math.round(img.width / scale)), Math.max(1, Math.round(img.height / scale))) : img;
  const out: Pixel[] = [];
  for (let i = 0; i < small.width * small.height; i++) {
    const o = i * 4;
    const r = small.data[o]!;
    const g = small.data[o + 1]!;
    const b = small.data[o + 2]!;
    const a = small.data[o + 3]!;
    if (isBrandPixel(r, g, b, a)) out.push([r, g, b]);
  }
  return out;
}

interface Box {
  pixels: Pixel[];
}

function widestChannel(pixels: Pixel[]): { channel: 0 | 1 | 2; range: number } {
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (const p of pixels) {
    for (let c = 0; c < 3; c++) {
      if (p[c]! < min[c]!) min[c] = p[c]!;
      if (p[c]! > max[c]!) max[c] = p[c]!;
    }
  }
  let channel: 0 | 1 | 2 = 0;
  let range = -1;
  for (const c of [0, 1, 2] as const) {
    const r = max[c]! - min[c]!;
    if (r > range) {
      range = r;
      channel = c;
    }
  }
  return { channel, range };
}

/** Classic median-cut: split the box with the widest channel range until we have `n` boxes. */
function medianCut(pixels: Pixel[], n: number): Box[] {
  const boxes: Box[] = [{ pixels }];
  while (boxes.length < n) {
    // Split the most-populated splittable box (compute each box's widest channel exactly once).
    boxes.sort((a, b) => b.pixels.length - a.pixels.length);
    let box: Box | undefined;
    let channel: 0 | 1 | 2 = 0;
    for (const b of boxes) {
      if (b.pixels.length < 2) continue;
      const w = widestChannel(b.pixels);
      if (w.range > 0) {
        box = b;
        channel = w.channel;
        break;
      }
    }
    if (!box) break;
    box.pixels.sort((a, b) => a[channel]! - b[channel]!);
    const mid = box.pixels.length >> 1;
    const right = box.pixels.splice(mid);
    boxes.push({ pixels: right });
  }
  return boxes;
}

function toHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

function averageHex(box: Box): string {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const p of box.pixels) {
    r += p[0]!;
    g += p[1]!;
    b += p[2]!;
  }
  const n = box.pixels.length || 1;
  return toHex(r / n, g / n, b / n);
}

/** Extract the dominant brand colors from decoded RGBA (pure, unit-testable). */
export function paletteFromRGBA(images: RGBA[], n = 4): string[] {
  const pixels = images.flatMap(collectPixels);
  if (!pixels.length) return [];
  const boxes = medianCut(pixels, Math.max(1, n));
  return boxes
    .filter((b) => b.pixels.length > 0)
    .sort((a, b) => b.pixels.length - a.pixels.length)
    .map(averageHex);
}

// Cache keyed by path+mtime — style references are stable brand assets read on every generation.
const cache = new Map<string, string[]>();

/**
 * Dominant brand colors (hex, most-dominant first) across reference images. Unreadable/undecodable
 * refs are skipped; returns [] when nothing usable (callers treat that as "no palette").
 */
export async function extractPalette(paths: string[], n = 4): Promise<string[]> {
  const images: RGBA[] = [];
  const keyParts: string[] = [];
  for (const p of paths) {
    try {
      const s = await stat(p);
      keyParts.push(`${p}:${s.mtimeMs}`);
    } catch {
      keyParts.push(p);
    }
  }
  const key = `${n}|${keyParts.join("|")}`;
  const hit = cache.get(key);
  if (hit) return hit;

  for (const p of paths) {
    try {
      images.push(await loadRGBA(p));
    } catch {
      // skip — a bad ref must not break generation (mirrors the styleReference loader)
    }
  }
  const result = paletteFromRGBA(images, n);
  cache.set(key, result);
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  return result;
}
