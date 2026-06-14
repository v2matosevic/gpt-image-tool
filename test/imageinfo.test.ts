import { test } from "node:test";
import assert from "node:assert/strict";
import { imageSize, sizeForAspect } from "../dist/imageinfo.js";

// Minimal valid PNG header (IHDR) for a WxH image — only the header is parsed.
function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

// Minimal JPEG with a SOF0 segment carrying dimensions.
function jpegHeader(w: number, h: number): Buffer {
  const sof = Buffer.alloc(11);
  sof[0] = 0xff; sof[1] = 0xc0; // SOF0
  sof.writeUInt16BE(8, 2);      // segment length
  sof[4] = 8;                   // precision
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof]);
}

test("reads PNG dimensions", () => {
  assert.deepEqual(imageSize(pngHeader(1280, 720)), { width: 1280, height: 720 });
});

test("reads JPEG dimensions", () => {
  assert.deepEqual(imageSize(jpegHeader(800, 1200)), { width: 800, height: 1200 });
});

test("returns null for garbage", () => {
  assert.equal(imageSize(Buffer.from("not an image")), null);
});

test("sizeForAspect maps to the closest supported size", () => {
  assert.equal(sizeForAspect({ width: 1000, height: 1000 }), "1024x1024");
  assert.equal(sizeForAspect({ width: 1920, height: 1080 }), "1536x1024");
  assert.equal(sizeForAspect({ width: 1080, height: 1920 }), "1024x1536");
  assert.equal(sizeForAspect(null), "auto");
});
