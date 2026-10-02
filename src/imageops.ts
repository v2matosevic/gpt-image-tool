// Dependency-free raster ops for the web-asset pipeline: load → resize → crop/pad → encode.
// Core path uses our own PNG codec (bgremove) + an area-averaging resampler, so the default install
// needs no native deps and produces crisp PNG/ICO. If `sharp` happens to be installed it's used at
// runtime to additionally decode jpeg/webp input and encode jpeg/webp/avif output — never a hard dep.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { decodePng, encodePng, removeBackground, type RemoveBgOptions } from "./bgremove.js";

export interface RGBA {
  width: number;
  height: number;
  data: Buffer; // width*height*4
}

export type Fit = "cover" | "contain" | "stretch";
export type OutFormat = "png" | "jpeg" | "webp";

/** MIME for an output format — the ONE format→mime map (MCP inline results, proof data URIs). */
export function mimeForFormat(f: OutFormat): string {
  return f === "jpeg" ? "image/jpeg" : f === "webp" ? "image/webp" : "image/png";
}

let sharpCache: any;
export async function loadSharp(): Promise<any> {
  if (sharpCache !== undefined) return sharpCache;
  try {
    // @ts-ignore - optional dependency, not installed by default
    sharpCache = (await import("sharp")).default;
  } catch {
    sharpCache = null;
  }
  return sharpCache;
}

function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
}

/** Load any image to RGBA. PNG works dependency-free; jpeg/webp need `sharp` installed. */
export async function loadRGBA(path: string): Promise<RGBA> {
  const buf = await readFile(path);
  return decodeRGBA(buf);
}

export async function decodeRGBA(buf: Buffer): Promise<RGBA> {
  if (isPng(buf)) return decodePng(buf);
  const sharp = await loadSharp();
  if (!sharp) {
    throw new Error(
      `Only PNG input is supported without \`sharp\`. Got a non-PNG image. ` +
        `Generate as PNG, or run \`npm i sharp\` to enable jpeg/webp input.`,
    );
  }
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: Buffer.from(data) };
}

/** Resample to exact w×h. Area-average for downscale (crisp), bilinear for upscale. */
export function resizeRGBA(src: RGBA, dw: number, dh: number): RGBA {
  if (![dw, dh].every(n => Number.isInteger(n) && n > 0) || dw * dh > 40_000_000) throw new Error("Invalid raster dimensions (maximum 40 million pixels).");
  if (dw === src.width && dh === src.height) return { ...src, data: Buffer.from(src.data) };
  const dst = Buffer.alloc(dw * dh * 4);
  const sxr = src.width / dw;
  const syr = src.height / dh;
  const upscaling = dw > src.width || dh > src.height;

  if (upscaling) {
    // Bilinear.
    for (let dy = 0; dy < dh; dy++) {
      const fy = Math.max(0, Math.min(src.height - 1, (dy + 0.5) * syr - 0.5));
      const y0 = Math.max(0, Math.floor(fy));
      const y1 = Math.min(src.height - 1, y0 + 1);
      const wy = fy - y0;
      for (let dx = 0; dx < dw; dx++) {
        const fx = Math.max(0, Math.min(src.width - 1, (dx + 0.5) * sxr - 0.5));
        const x0 = Math.max(0, Math.floor(fx));
        const x1 = Math.min(src.width - 1, x0 + 1);
        const wx = fx - x0;
        const o = (dy * dw + dx) * 4;
        const samples = [[(y0 * src.width + x0) * 4, (1 - wx) * (1 - wy)], [(y0 * src.width + x1) * 4, wx * (1 - wy)],
          [(y1 * src.width + x0) * 4, (1 - wx) * wy], [(y1 * src.width + x1) * 4, wx * wy]];
        const alpha = samples.reduce((sum, [s, w]) => sum + src.data[s! + 3]! * w!, 0);
        dst[o + 3] = Math.round(alpha);
        for (let c = 0; c < 3; c++) dst[o + c] = alpha > 0 ? Math.round(samples.reduce((sum, [s, w]) => sum + src.data[s! + c]! * src.data[s! + 3]! * w!, 0) / alpha) : 0;
      }
    }
    return { width: dw, height: dh, data: dst };
  }

  // Area average (box) — premultiply alpha so transparent edges don't bleed dark.
  for (let dy = 0; dy < dh; dy++) {
    const y0 = Math.floor(dy * syr);
    const y1 = Math.min(src.height, Math.ceil((dy + 1) * syr));
    for (let dx = 0; dx < dw; dx++) {
      const x0 = Math.floor(dx * sxr);
      const x1 = Math.min(src.width, Math.ceil((dx + 1) * sxr));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const s = (y * src.width + x) * 4;
          const weight = (Math.min(x + 1, (dx + 1) * sxr) - Math.max(x, dx * sxr)) * (Math.min(y + 1, (dy + 1) * syr) - Math.max(y, dy * syr));
          const af = src.data[s + 3]! / 255 * weight;
          r += src.data[s]! * af;
          g += src.data[s + 1]! * af;
          b += src.data[s + 2]! * af;
          a += src.data[s + 3]! * weight;
          n += weight;
        }
      }
      const o = (dy * dw + dx) * 4;
      const aAvg = a / n;
      const aw = aAvg > 0 ? aAvg / 255 : 1; // un-premultiply
      dst[o] = Math.round(r / n / aw);
      dst[o + 1] = Math.round(g / n / aw);
      dst[o + 2] = Math.round(b / n / aw);
      dst[o + 3] = Math.round(aAvg);
    }
  }
  return { width: dw, height: dh, data: dst };
}

function blank(w: number, h: number, bg?: [number, number, number, number]): RGBA {
  const data = Buffer.alloc(w * h * 4);
  if (bg) for (let i = 0; i < w * h; i++) data.set(bg, i * 4);
  return { width: w, height: h, data };
}

/** Composite `src` onto `dst` at (ox,oy) with simple source-over. */
export function blitOver(dst: RGBA, src: RGBA, ox: number, oy: number): void {
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
      for (let c = 0; c < 3; c++) dst.data[d + c] = Math.round((src.data[s + c]! * sa + dst.data[d + c]! * da * (1 - sa)) / oa);
      dst.data[d + 3] = Math.round(oa * 255);
    }
  }
}

/** Fit `src` into exactly dw×dh. cover = scale-to-fill + center-crop; contain = scale-to-fit + pad. */
export function fitTo(src: RGBA, dw: number, dh: number, fit: Fit = "cover", bg?: [number, number, number, number]): RGBA {
  if (fit === "stretch") return resizeRGBA(src, dw, dh);
  const scale = fit === "cover" ? Math.max(dw / src.width, dh / src.height) : Math.min(dw / src.width, dh / src.height);
  const rw = Math.max(1, Math.round(src.width * scale));
  const rh = Math.max(1, Math.round(src.height * scale));
  const scaled = resizeRGBA(src, rw, rh);
  const out = blank(dw, dh, fit === "contain" ? bg ?? [0, 0, 0, 0] : undefined);
  blitOver(out, scaled, Math.round((dw - rw) / 2), Math.round((dh - rh) / 2));
  return out;
}

/** Transparent mask pixels are editable; opaque pixels remain byte-identical to the original. */
export function compositeMasked(original: RGBA, generated: RGBA, mask: RGBA): RGBA {
  if (mask.width !== original.width || mask.height !== original.height) throw new Error("Mask dimensions must match the original.");
  const edit = resizeRGBA(generated, original.width, original.height);
  const out = { ...original, data: Buffer.from(original.data) };
  for (let i = 0; i < out.data.length; i += 4) {
    const mix = 1 - mask.data[i + 3]! / 255;
    if (mix === 0) continue;
    if (mix === 1) { edit.data.copy(out.data, i, i, i + 4); continue; }
    const oa = original.data[i + 3]! * (1 - mix), ea = edit.data[i + 3]! * mix;
    for (let c = 0; c < 3; c++) out.data[i + c] = oa + ea ? Math.round((original.data[i + c]! * oa + edit.data[i + c]! * ea) / (oa + ea)) : 0;
    out.data[i + 3] = Math.round(oa + ea);
  }
  return out;
}

/** Encode an .ico from one or more RGBA sizes (each embedded as a PNG — supported by all modern OSes). */
export function encodeIco(images: RGBA[]): Buffer {
  const pngs = images.map((im) => encodePng(im));
  const count = pngs.length;
  const header = Buffer.alloc(6 + count * 16);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);
  let offset = 6 + count * 16;
  const dir = header;
  images.forEach((im, i) => {
    const e = 6 + i * 16;
    dir[e] = im.width >= 256 ? 0 : im.width; // 0 means 256
    dir[e + 1] = im.height >= 256 ? 0 : im.height;
    dir[e + 2] = 0; // palette
    dir[e + 3] = 0; // reserved
    dir.writeUInt16LE(1, e + 4); // color planes
    dir.writeUInt16LE(32, e + 6); // bpp
    dir.writeUInt32LE(pngs[i]!.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += pngs[i]!.length;
  });
  return Buffer.concat([header, ...pngs]);
}

/** Save an RGBA image. PNG is dependency-free; jpeg/webp use `sharp` if available (else error). */
export async function saveImage(img: RGBA, path: string, format: OutFormat = "png", quality = 82): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (format === "png") {
    await writeFile(path, encodePng(img));
    return;
  }
  const sharp = await loadSharp();
  if (!sharp) {
    throw new Error(`${format} output needs \`sharp\` installed (\`npm i sharp\`). PNG works without it.`);
  }
  await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
    .toFormat(format, { quality })
    .toFile(path);
}

/** Is jpeg/webp output available in this install? */
export async function canEncode(format: OutFormat): Promise<boolean> {
  return format === "png" ? true : Boolean(await loadSharp());
}

/**
 * Cut out the background of an existing image → transparent PNG. Best on clean/solid backgrounds:
 * it samples the corner color and flood-fills from the edges (it's a keyer, not AI matting).
 */
/** Default output path for a cutout: `<src-without-ext>-cutout.png` (no regex; handles no-extension). */
export function cutoutPath(src: string): string {
  return src.slice(0, src.length - extname(src).length) + "-cutout.png";
}

export async function removeBackgroundFile(srcPath: string, outPath: string, opts?: RemoveBgOptions): Promise<void> {
  const buf = await readFile(srcPath);
  const png = isPng(buf) ? buf : encodePng(await loadRGBA(srcPath));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, removeBackground(png, opts));
}
