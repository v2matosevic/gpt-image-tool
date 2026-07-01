// Dependency-free image dimension reader for PNG / JPEG / WebP headers. Used to pick an output
// size that matches a reference image's aspect ratio (for upscale / edit). Returns null if unknown.

import type { ImageSize } from "./providers/types.js";

export interface Dimensions {
  width: number;
  height: number;
}

export function imageSize(buf: Buffer): Dimensions | null {
  return pngSize(buf) ?? jpegSize(buf) ?? webpSize(buf);
}

/**
 * Cheap sanity check that a buffer is actually an image (PNG/JPEG/WebP — the formats this tool ever
 * produces), not text/HTML/garbage — catches a backend returning a non-image payload before we save
 * it. Magic bytes only, so it never false-rejects an unusual-but-valid encoding (unlike a full
 * dimension parse).
 */
export function looksLikeImage(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.readUInt32BE(0) === 0x89504e47) return true; // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return true; // WebP
  return false;
}

function pngSize(b: Buffer): Dimensions | null {
  // 8-byte signature, then IHDR: [len][IHDR][width:4][height:4] → width at byte 16, height at 20.
  if (b.length < 24) return null;
  if (b.readUInt32BE(0) !== 0x89504e47) return null;
  if (b.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpegSize(b: Buffer): Dimensions | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < b.length) {
    if (b[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = b[off + 1]!;
    // SOF markers carry dimensions (exclude DHT/JPG/DAC and the RSTn/standalone markers).
    const isSOF = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    const segLen = b.readUInt16BE(off + 2);
    if (isSOF) {
      return { height: b.readUInt16BE(off + 5), width: b.readUInt16BE(off + 7) };
    }
    off += 2 + segLen;
  }
  return null;
}

function webpSize(b: Buffer): Dimensions | null {
  if (b.length < 30) return null;
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WEBP") return null;
  const fourcc = b.toString("ascii", 12, 16);
  if (fourcc === "VP8X") {
    // 24-bit little-endian (value - 1) for canvas width/height.
    const w = (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1;
    const h = (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1;
    return { width: w, height: h };
  }
  if (fourcc === "VP8 ") {
    // Lossy keyframe: dimensions are 14 bits each at offset 26/28.
    const w = b.readUInt16LE(26) & 0x3fff;
    const h = b.readUInt16LE(28) & 0x3fff;
    if (w && h) return { width: w, height: h };
  }
  return null;
}

/** Map an aspect ratio to the closest supported output size. */
export function sizeForAspect(dim: Dimensions | null): ImageSize {
  if (!dim || !dim.width || !dim.height) return "auto";
  const ratio = dim.width / dim.height;
  if (ratio > 1.2) return "1536x1024"; // landscape
  if (ratio < 0.72) return "1024x1536"; // tall portrait (2:3 and taller)
  if (ratio < 0.9) return "1024x1280"; // 4:5 portrait (Instagram feed)
  return "1024x1024"; // roughly square
}

/** Like sizeForAspect, but targets the 2K tier — used by upscale for a real resolution gain. */
export function upscaleSizeForAspect(dim: Dimensions | null): ImageSize {
  if (!dim || !dim.width || !dim.height) return "2048x2048";
  const ratio = dim.width / dim.height;
  if (ratio > 1.2) return "2048x1152"; // landscape
  if (ratio < 0.83) return "1152x2048"; // portrait
  return "2048x2048"; // roughly square
}
