import { test } from "node:test";
import assert from "node:assert/strict";
import { resizeRGBA, fitTo, encodeIco, type RGBA } from "../dist/imageops.js";

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
