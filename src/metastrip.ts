// Provenance/metadata stripper: rewrite a PNG/JPEG/WebP container keeping ONLY what's needed to
// display the pixels — drops EXIF, XMP, IPTC, comments and C2PA/JUMBF content-credential manifests
// (the "Made with AI" provenance block gpt-image embeds). Pixel data is copied verbatim, so the
// image is byte-identical visually and never re-compressed. Dependency-free, pure Buffer walking.
//
// Honest ceiling: this removes METADATA provenance only. It cannot remove a watermark encoded in
// the pixels themselves (SynthID-style), should the model ever embed one.

// --- PNG ---------------------------------------------------------------------------------------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Chunks required to decode + color-manage the image (and APNG animation). Everything else —
// tEXt/zTXt/iTXt, eXIf, tIME, caBX (C2PA), private chunks — is dropped.
const PNG_KEEP = new Set(["IHDR", "PLTE", "tRNS", "sRGB", "gAMA", "cHRM", "iCCP", "IDAT", "IEND", "acTL", "fcTL", "fdAT"]);

function stripPng(buf: Buffer): Buffer {
  const out: Buffer[] = [PNG_SIG];
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const end = pos + 12 + len; // len + type + data + crc
    if (end > buf.length) break; // truncated chunk — stop, keep what we have
    if (PNG_KEEP.has(type)) out.push(buf.subarray(pos, end));
    pos = end;
    if (type === "IEND") break;
  }
  return Buffer.concat(out);
}

// --- JPEG --------------------------------------------------------------------------------------

// APPn/COM segments to drop: APP1 (EXIF + XMP), APP11 (JUMBF → C2PA), APP13 (IPTC/Photoshop),
// COM (comments). Kept: APP0 (JFIF), APP2 (ICC profile), APP14 (Adobe color transform — decoders
// need it for correct color), and every structural segment (DQT/SOF/DHT/DRI/SOS…).
const JPEG_DROP = new Set([0xe1, 0xeb, 0xed, 0xfe]);

function stripJpeg(buf: Buffer): Buffer {
  const out: Buffer[] = [buf.subarray(0, 2)]; // SOI
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) break; // desynced — keep the rest verbatim
    const marker = buf[pos + 1]!;
    if (marker === 0xd9) break; // EOI
    // Standalone markers (no length): TEM + RSTn.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(buf.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(pos + 2);
    const end = pos + 2 + segLen;
    if (segLen < 2 || end > buf.length) break;
    if (marker === 0xda) {
      // SOS: the entropy-coded stream follows — copy everything from here to the end verbatim.
      out.push(buf.subarray(pos));
      return Buffer.concat(out);
    }
    if (!JPEG_DROP.has(marker)) out.push(buf.subarray(pos, end));
    pos = end;
  }
  out.push(buf.subarray(pos)); // trailing bytes (EOI or unparseable remainder)
  return Buffer.concat(out);
}

// --- WebP --------------------------------------------------------------------------------------

// RIFF chunks to drop: EXIF, XMP, and JUMB (C2PA). Everything else (VP8/VP8L/VP8X/ALPH/ICCP/
// ANIM/ANMF) is image data or color management.
const WEBP_DROP = new Set(["EXIF", "XMP ", "JUMB"]);
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;

function stripWebp(buf: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let pos = 12; // "RIFF" + size + "WEBP"
  while (pos + 8 <= buf.length) {
    const fourcc = buf.toString("ascii", pos, pos + 4);
    const len = buf.readUInt32LE(pos + 4);
    const padded = len + (len % 2); // chunks are even-padded
    const end = pos + 8 + padded;
    if (end > buf.length) break;
    if (!WEBP_DROP.has(fourcc)) {
      let chunk = buf.subarray(pos, end);
      if (fourcc === "VP8X" && len >= 1) {
        // Clear the EXIF/XMP presence flags so the header matches the stripped body.
        chunk = Buffer.from(chunk);
        chunk[8] = chunk[8]! & ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
      }
      chunks.push(chunk);
    }
    pos = end;
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length + 4, 4); // size covers "WEBP" + chunks
  header.write("WEBP", 8, "ascii");
  return Buffer.concat([header, body]);
}

// --- Dispatch ----------------------------------------------------------------------------------

/**
 * Strip all non-essential metadata (EXIF/XMP/IPTC/comments/C2PA) from a PNG, JPEG or WebP buffer.
 * Pixels are untouched (container rewrite only). Unknown formats are returned unchanged.
 */
export function stripImageMetadata(buf: Buffer): Buffer {
  if (buf.length > 12 && buf.subarray(0, 8).equals(PNG_SIG)) return stripPng(buf);
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return stripJpeg(buf);
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return stripWebp(buf);
  return buf;
}

/** List a container's chunk/segment names — used by tests and `--check`-style inspection. */
export function listMetadataBlocks(buf: Buffer): string[] {
  const out: string[] = [];
  if (buf.length > 12 && buf.subarray(0, 8).equals(PNG_SIG)) {
    let pos = 8;
    while (pos + 8 <= buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString("ascii", pos + 4, pos + 8);
      out.push(type);
      pos += 12 + len;
      if (type === "IEND") break;
    }
  } else if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let pos = 2;
    while (pos + 4 <= buf.length && buf[pos] === 0xff) {
      const marker = buf[pos + 1]!;
      if (marker === 0xd9) break;
      out.push(`0x${marker.toString(16)}`);
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        pos += 2;
        continue;
      }
      if (marker === 0xda) break;
      pos += 2 + buf.readUInt16BE(pos + 2);
    }
  } else if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF") {
    let pos = 12;
    while (pos + 8 <= buf.length) {
      const len = buf.readUInt32LE(pos + 4);
      out.push(buf.toString("ascii", pos, pos + 4));
      pos += 8 + len + (len % 2);
    }
  }
  return out;
}
