import { test } from "node:test";
import assert from "node:assert/strict";
import { paletteFromRGBA } from "../dist/palette.js";

function solid(w: number, h: number, rgba: [number, number, number, number]) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
}

test("extracts the dominant color from a solid image", () => {
  const hexes = paletteFromRGBA([solid(8, 8, [28, 181, 163, 255])], 3);
  assert.equal(hexes[0], "#1cb5a3");
});

test("ignores near-white background and transparent pixels", () => {
  // 3/4 white + 1/4 brand teal: white must NOT dominate the palette.
  const img = solid(8, 8, [255, 255, 255, 255]);
  for (let i = 0; i < 16; i++) img.data.set([28, 181, 163, 255], i * 4);
  const hexes = paletteFromRGBA([img], 2);
  assert.equal(hexes[0], "#1cb5a3");

  const transparent = solid(8, 8, [200, 30, 30, 0]);
  assert.deepEqual(paletteFromRGBA([transparent], 2), []);
});

test("separates two distinct brand colors", () => {
  const img = solid(8, 8, [224, 49, 49, 255]); // red
  for (let i = 0; i < 32; i++) img.data.set([30, 90, 255, 255], i * 4); // half blue
  const hexes = paletteFromRGBA([img], 2);
  assert.equal(hexes.length, 2);
  const joined = hexes.join(",");
  assert.match(joined, /#1e5aff/);
  assert.match(joined, /#e03131/);
});

test("returns [] for no usable pixels", () => {
  assert.deepEqual(paletteFromRGBA([], 4), []);
});
