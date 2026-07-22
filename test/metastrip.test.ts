import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { listMetadataBlocks, stripImageMetadata } from "../dist/metastrip.js";
import { decodePng, encodePng } from "../dist/bgremove.js";

// --- PNG helpers -------------------------------------------------------------------------------

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
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Insert metadata chunks into a clean encodePng output (after IHDR). */
function pngWithMetadata(): { dirty: Buffer; pixels: Buffer } {
  const img = { width: 3, height: 2, data: Buffer.alloc(3 * 2 * 4, 0x7f) };
  const clean = encodePng(img);
  const ihdrEnd = 8 + 12 + 13; // sig + IHDR chunk
  const meta = Buffer.concat([
    pngChunk("tEXt", Buffer.from("Software\0OpenAI gpt-image", "latin1")),
    pngChunk("iTXt", Buffer.from("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>", "latin1")),
    pngChunk("eXIf", Buffer.from([0x4d, 0x4d, 0x00, 0x2a])),
    pngChunk("caBX", Buffer.from("c2pa-manifest-bytes")), // C2PA content credentials
  ]);
  return { dirty: Buffer.concat([clean.subarray(0, ihdrEnd), meta, clean.subarray(ihdrEnd)]), pixels: img.data };
}

test("PNG: drops tEXt/iTXt/eXIf/caBX, keeps pixels bit-exact", () => {
  const { dirty, pixels } = pngWithMetadata();
  assert.deepEqual(listMetadataBlocks(dirty), ["IHDR", "tEXt", "iTXt", "eXIf", "caBX", "IDAT", "IEND"]);
  const clean = stripImageMetadata(dirty);
  assert.deepEqual(listMetadataBlocks(clean), ["IHDR", "IDAT", "IEND"]);
  const decoded = decodePng(clean);
  assert.deepEqual(decoded.data, pixels);
});

test("PNG: keeps color-management chunks (sRGB/gAMA/iCCP) and tRNS", () => {
  const img = { width: 1, height: 1, data: Buffer.from([1, 2, 3, 255]) };
  const clean = encodePng(img);
  const ihdrEnd = 8 + 12 + 13;
  const dirty = Buffer.concat([
    clean.subarray(0, ihdrEnd),
    pngChunk("sRGB", Buffer.from([0])),
    pngChunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f])),
    pngChunk("tIME", Buffer.alloc(7)), // droppable
    clean.subarray(ihdrEnd),
  ]);
  assert.deepEqual(listMetadataBlocks(stripImageMetadata(dirty)), ["IHDR", "sRGB", "gAMA", "IDAT", "IEND"]);
});

// --- JPEG --------------------------------------------------------------------------------------

function jpegSegment(marker: number, data: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}

test("JPEG: drops APP1/APP11/APP13/COM, keeps APP0/APP2/APP14 + scan verbatim", () => {
  const scan = Buffer.concat([Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x00]), Buffer.from("entropy-data"), Buffer.from([0xff, 0xd9])]);
  const dirty = Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    jpegSegment(0xe0, Buffer.from("JFIF\0")), // APP0 keep
    jpegSegment(0xe1, Buffer.from("Exif\0\0....")), // APP1 drop
    jpegSegment(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0<xmp/>")), // APP1 XMP drop
    jpegSegment(0xeb, Buffer.from("JP..jumb-c2pa")), // APP11 drop
    jpegSegment(0xed, Buffer.from("Photoshop 3.0\0")), // APP13 drop
    jpegSegment(0xfe, Buffer.from("a comment")), // COM drop
    jpegSegment(0xe2, Buffer.from("ICC_PROFILE\0")), // APP2 keep
    jpegSegment(0xee, Buffer.from("Adobe")), // APP14 keep
    jpegSegment(0xdb, Buffer.alloc(65)), // DQT keep
    scan,
  ]);
  const clean = stripImageMetadata(dirty);
  assert.deepEqual(listMetadataBlocks(clean), ["0xe0", "0xe2", "0xee", "0xdb", "0xda"]);
  // The entropy stream (SOS → EOI) must be preserved byte-for-byte.
  assert.ok(clean.includes(Buffer.from("entropy-data")));
  assert.deepEqual(clean.subarray(clean.length - 2), Buffer.from([0xff, 0xd9]));
  assert.ok(!clean.includes(Buffer.from("jumb-c2pa")));
  assert.ok(!clean.includes(Buffer.from("Exif")));
});

// --- WebP --------------------------------------------------------------------------------------

function riffChunk(fourcc: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, "ascii");
  head.writeUInt32LE(data.length, 4);
  const pad = data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([head, data, pad]);
}

function webpWith(chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WEBP", 8, "ascii");
  return Buffer.concat([header, body]);
}

test("WebP: drops EXIF/XMP/JUMB, clears VP8X flags, fixes RIFF size", () => {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x20 | 0x08 | 0x04; // ICC + EXIF + XMP flags set
  const dirty = webpWith([
    riffChunk("VP8X", vp8x),
    riffChunk("ICCP", Buffer.from("icc-profile")),
    riffChunk("VP8 ", Buffer.from("lossy-bitstream")),
    riffChunk("EXIF", Buffer.from("exif-data")),
    riffChunk("XMP ", Buffer.from("<xmp/>")),
    riffChunk("JUMB", Buffer.from("c2pa")),
  ]);
  const clean = stripImageMetadata(dirty);
  assert.deepEqual(listMetadataBlocks(clean), ["VP8X", "ICCP", "VP8 "]);
  assert.equal(clean[20]! & 0x08, 0); // EXIF flag cleared
  assert.equal(clean[20]! & 0x04, 0); // XMP flag cleared
  assert.equal(clean[20]! & 0x20, 0x20); // ICC flag preserved
  assert.equal(clean.readUInt32LE(4), clean.length - 8); // RIFF size consistent
});

test("unknown formats pass through unchanged", () => {
  const buf = Buffer.from("definitely not an image");
  assert.equal(stripImageMetadata(buf), buf);
});
