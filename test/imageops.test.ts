import { test } from "node:test";
import assert from "node:assert/strict";
import { resizeRGBA, fitTo, encodeIco, blitOver, compositeMasked, type RGBA } from "../dist/imageops.js";

function make(w: number, h: number, px: (x: number, y: number) => number[]): RGBA {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(px(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}

test("resizeRGBA downscales 2x2 → 1x1 by averaging", () => {
  const src = make(2, 2, (x, y) => {
    const colors = [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [255, 255, 255, 255],
    ];
    return colors[y * 2 + x]!;
  });
  const out = resizeRGBA(src, 1, 1);
  assert.equal(out.width, 1);
  assert.equal(out.height, 1);
  // r=(255+0+0+255)/4=128, g=(0+255+0+255)/4=128, b=(0+0+255+255)/4=128
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(out.data[c]! - 128) <= 1, `channel ${c}=${out.data[c]}`);
  assert.equal(out.data[3], 255);
});

test("fitTo cover and contain both yield the exact target size", () => {
  const src = make(100, 50, () => [10, 20, 30, 255]);
  assert.deepEqual([fitTo(src, 64, 64, "cover").width, fitTo(src, 64, 64, "cover").height], [64, 64]);
  const contain = fitTo(src, 64, 64, "contain");
  assert.deepEqual([contain.width, contain.height], [64, 64]);
  // contain pads with transparency: top corner should be transparent (100x50 fit into square leaves top/bottom bars)
  assert.equal(contain.data[3], 0);
});

test("encodeIco writes a valid ICO header (magic + image count)", () => {
  const a = make(16, 16, () => [0, 0, 0, 255]);
  const b = make(32, 32, () => [0, 0, 0, 255]);
  const ico = encodeIco([a, b]);
  assert.equal(ico.readUInt16LE(0), 0); // reserved
  assert.equal(ico.readUInt16LE(2), 1); // type icon
  assert.equal(ico.readUInt16LE(4), 2); // two images
  assert.equal(ico[6], 16); // first entry width
});

test("padding semi-transparent ink keeps straight RGB and source-over combines alpha", () => {
  const src = make(2, 1, () => [240, 20, 30, 128]);
  const contained = fitTo(src, 2, 3, "contain");
  assert.deepEqual([...contained.data.subarray(8, 12)], [240, 20, 30, 128]);
  const dst = make(1, 1, () => [0, 0, 255, 128]);
  blitOver(dst, make(1, 1, () => [255, 0, 0, 128]), 0, 0);
  assert.deepEqual([...dst.data], [170, 0, 85, 192]);
});

test("enlargement interpolates alpha-premultiplied color and clamps border samples", () => {
  const src = make(2, 1, x => x === 0 ? [255, 0, 0, 255] : [0, 0, 0, 0]);
  const out = resizeRGBA(src, 8, 1);
  assert.deepEqual([...out.data.subarray(0, 4)], [255, 0, 0, 255]);
  for (let i = 0; i < out.data.length; i += 4) if (out.data[i + 3]! > 0) assert.equal(out.data[i], 255, "transparent black must not bleed into the red edge");
});

test("masked composite preserves every outside byte, including hidden RGB and alpha", () => {
  const src = make(4, 2, (x, y) => [x * 40, y * 70, 55, x * 60]);
  const gen = make(8, 4, () => [255, 0, 0, 255]);
  const mask = make(4, 2, x => [0, 0, 0, x < 2 ? 0 : 255]);
  const out = compositeMasked(src, gen, mask);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 4; x++) {
    const i = (y * 4 + x) * 4;
    assert.deepEqual([...out.data.subarray(i, i + 4)], x < 2 ? [255, 0, 0, 255] : [...src.data.subarray(i, i + 4)]);
  }
});
