// Dependency-free background removal for transparent assets on the subscription backend (which
// can't emit native transparency). We render the subject on a flat solid background, then flood-fill
// from the image edges, keying out the connected background to alpha. Minimal PNG codec for the
// 8-bit, non-interlaced RGB/RGBA images gpt-image returns, built on Node's zlib.

import { deflateSync, inflateSync } from "node:zlib";

interface RGBAImage {
  width: number;
  height: number;
  data: Buffer; // width*height*4, RGBA
}

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// --- CRC32 (PNG chunk checksums) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode an 8-bit, non-interlaced RGB/RGBA PNG into RGBA pixels. Throws on unsupported variants. */
export function decodePng(buf: Buffer): RGBAImage {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let bitDepth = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      interlace = data[12]!;
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len; // len + type(4) + data + crc(4)
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]!;
    const line = Buffer.from(raw.subarray(rp, rp + stride));
    rp += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      let v = line[i]!;
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) v = (v + paeth(a, b, c)) & 0xff;
      line[i] = v;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s]!;
      out[d + 1] = line[s + 1]!;
      out[d + 2] = line[s + 2]!;
      out[d + 3] = channels === 4 ? line[s + 3]! : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode RGBA pixels as an 8-bit RGBA PNG (filter 0). */
export function encodePng(img: RGBAImage): Buffer {
  const { width, height, data } = img;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    data.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

export interface RemoveBgOptions {
  /** Per-channel color tolerance vs the background color (0–255). */
  tolerance?: number;
  /** Known background color to key out. If omitted, the average of the four corners is used. */
  keyColor?: { r: number; g: number; b: number };
}

/**
 * Remove the connected background reachable from the image edges, keying it to alpha. Flood-fill
 * from the border keeps holes/colors inside the subject intact (unlike a global color key).
 * Returns an RGBA PNG.
 */
export function removeBackground(png: Buffer, opts: RemoveBgOptions = {}): Buffer {
  const tol = opts.tolerance ?? 28;
  const img = decodePng(png);
  const { width: w, height: h, data } = img;
  const n = w * h;

  // Reference background color: the known key color, else the average of the four corners.
  let rr: number;
  let gg: number;
  let bb: number;
  if (opts.keyColor) {
    ({ r: rr, g: gg, b: bb } = opts.keyColor);
  } else {
    const corners = [0, (w - 1) * 4, (h - 1) * w * 4, (n - 1) * 4];
    rr = gg = bb = 0;
    for (const c of corners) {
      rr += data[c]!;
      gg += data[c + 1]!;
      bb += data[c + 2]!;
    }
    rr = Math.round(rr / 4);
    gg = Math.round(gg / 4);
    bb = Math.round(bb / 4);
  }

  const isBg = (px: number): boolean => {
    const o = px * 4;
    return Math.abs(data[o]! - rr) <= tol && Math.abs(data[o + 1]! - gg) <= tol && Math.abs(data[o + 2]! - bb) <= tol;
  };

  if (opts.keyColor) {
    // Known chroma key: the background is DEFINED by color, so remove every matching pixel —
    // this also clears chroma trapped INSIDE the subject (holes in 3D forms, line-icon interiors)
    // that an edge flood-fill can never reach.
    for (let px = 0; px < n; px++) {
      if (isBg(px)) data[px * 4 + 3] = 0;
    }
    // Green de-spill: clamp the green channel of surviving edge pixels so no green fringe remains.
    if (gg > rr && gg > bb) {
      for (let px = 0; px < n; px++) {
        const o = px * 4;
        if (data[o + 3] === 0) continue;
        const cap = Math.max(data[o]!, data[o + 2]!);
        if (data[o + 1]! > cap) data[o + 1] = cap;
      }
    }
  } else {
    // Unknown background (e.g. a flat white photo): flood-fill from the edges so background-colored
    // regions enclosed by the subject stay opaque.
    const visited = new Uint8Array(n);
    const stack: number[] = [];
    for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
    for (let y = 0; y < h; y++) stack.push(y * w, y * w + (w - 1));
    while (stack.length) {
      const px = stack.pop()!;
      if (visited[px]) continue;
      visited[px] = 1;
      if (!isBg(px)) continue;
      data[px * 4 + 3] = 0;
      const x = px % w;
      const y = (px / w) | 0;
      if (x > 0) stack.push(px - 1);
      if (x < w - 1) stack.push(px + 1);
      if (y > 0) stack.push(px - w);
      if (y < h - 1) stack.push(px + w);
    }
  }

  return encodePng(img);
}
