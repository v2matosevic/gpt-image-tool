import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePng, encodePng, removeBackground } from "../dist/bgremove.js";

// Build a WxH RGBA image with a paint(x,y)->[r,g,b,a] function, encode to PNG.
function makePng(w: number, h: number, paint: (x: number, y: number) => number[]): Buffer {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = paint(x, y);
      const o = (y * w + x) * 4;
      data[o] = r!; data[o + 1] = g!; data[o + 2] = b!; data[o + 3] = a!;
    }
  }
  return encodePng({ width: w, height: h, data });
}

test("encode → decode round-trips pixels exactly", () => {
  const png = makePng(8, 6, (x, y) => [x * 30, y * 40, 100, 255]);
  const img = decodePng(png);
  assert.equal(img.width, 8);
  assert.equal(img.height, 6);
  assert.deepEqual([...img.data.subarray(0, 4)], [0, 0, 100, 255]);
  const last = (6 * 8 - 1) * 4;
  assert.deepEqual([...img.data.subarray(last, last + 4)], [7 * 30, 5 * 40, 100, 255]);
});

test("removeBackground keys out the green border but keeps the subject", () => {
  const green = [0x00, 0xb1, 0x40, 255];
  // 10x10 green field with a solid red 4x4 block in the center.
  const png = makePng(10, 10, (x, y) => (x >= 3 && x < 7 && y >= 3 && y < 7 ? [220, 30, 30, 255] : green));
  const out = decodePng(removeBackground(png, { keyColor: { r: 0, g: 0xb1, b: 0x40 }, tolerance: 40 }));
  const alpha = (x: number, y: number) => out.data[(y * 10 + x) * 4 + 3];
  assert.equal(alpha(0, 0), 0, "corner should be transparent");
  assert.equal(alpha(9, 9), 0, "far corner should be transparent");
  assert.equal(alpha(5, 5), 255, "subject center should be opaque");
  assert.equal(out.data[(5 * 10 + 5) * 4], 220, "subject color preserved");
});

test("known chroma key clears chroma ENCLOSED by the subject (3D holes, line interiors)", () => {
  const green = [0x00, 0xb1, 0x40, 255];
  // A green pixel trapped inside a red block — unreachable from the edge. With a known key color
  // it must still be removed (global key), since the background is defined by color.
  const png = makePng(10, 10, (x, y) => {
    if (x >= 3 && x < 7 && y >= 3 && y < 7) return x === 5 && y === 5 ? green : [220, 30, 30, 255];
    return green;
  });
  const out = decodePng(removeBackground(png, { keyColor: { r: 0, g: 0xb1, b: 0x40 }, tolerance: 40 }));
  assert.equal(out.data[(5 * 10 + 5) * 4 + 3], 0, "enclosed chroma must be removed with a known key");
  assert.equal(out.data[(4 * 10 + 4) * 4 + 3], 255, "adjacent red subject pixel stays opaque");
});

test("corner-sampled flood-fill preserves bg-colored pixels enclosed by the subject", () => {
  // No keyColor → sample the white corners → flood-fill removes the border but keeps an enclosed
  // white pixel surrounded by the red subject.
  const png = makePng(10, 10, (x, y) => {
    if (x >= 3 && x < 7 && y >= 3 && y < 7) return x === 5 && y === 5 ? [255, 255, 255, 255] : [220, 30, 30, 255];
    return [255, 255, 255, 255];
  });
  const out = decodePng(removeBackground(png, { tolerance: 40 }));
  assert.equal(out.data[0 + 3], 0, "border must be removed");
  assert.equal(out.data[(5 * 10 + 5) * 4 + 3], 255, "enclosed white must remain opaque");
});
