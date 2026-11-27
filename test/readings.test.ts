import { test } from "node:test";
import assert from "node:assert/strict";
import { readLook, lookDrift } from "../dist/imageqa.js";

type RGB = [number, number, number];
function image(w: number, h: number, px: (x: number, y: number) => RGB) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([...px(x, y), 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}

test("a half-black, half-white image reads as a 50/50 palette with maximal contrast", () => {
  const r = readLook(image(120, 90, x => (x < 60 ? [0, 0, 0] : [255, 255, 255])));
  assert.equal(r.palette.length, 2);
  assert.ok(Math.abs(r.palette[0]!.share - 0.5) < 0.02);
  assert.ok(r.contrast.range > 95, `range ${r.contrast.range}`);
  assert.ok(r.contrast.rms > 0.49);
  assert.equal(r.color.saturation, "muted");
  assert.equal(r.color.temperature, "neutral");
  // Black is the departure from the mid tone on the left, white on the right: weight is balanced.
  assert.ok(Math.abs(r.composition.centroid.x - 0.5) < 0.05);
});

test("known stripes give known palette shares, key and warmth", () => {
  const r = readLook(image(100, 100, x => (x < 50 ? [230, 120, 30] : x < 75 ? [20, 40, 140] : [250, 250, 245])));
  const shares = Object.fromEntries(r.palette.map(p => [p.hex, p.share]));
  const near = (hex: string) => Object.entries(shares).find(([h]) => h === hex)?.[1];
  assert.ok(Math.abs((near("#e6781e") ?? 0) - 0.5) < 0.02, JSON.stringify(r.palette));
  assert.ok(Math.abs((near("#14288c") ?? 0) - 0.25) < 0.02, JSON.stringify(r.palette));
  const dark = readLook(image(64, 64, () => [25, 25, 30]));
  assert.equal(dark.luminance.key, "low");
  const bright = readLook(image(64, 64, () => [240, 236, 228]));
  assert.equal(bright.luminance.key, "high");
  assert.equal(readLook(image(64, 64, () => [240, 160, 60])).color.temperature, "warm");
  assert.equal(readLook(image(64, 64, () => [60, 120, 230])).color.temperature, "cool");
});

test("a blurred half reads as softer than the sharp half; a lone subject is the heavy cell", () => {
  const checker = (x: number, y: number): RGB => (((x >> 1) + (y >> 1)) % 2 ? [250, 250, 250] : [10, 10, 10]);
  const r = readLook(image(150, 150, (x, y) => (x < 75 ? checker(x, y) : [130, 130, 130])));
  const left = r.sharpness.thirds[0]! + r.sharpness.thirds[3]! + r.sharpness.thirds[6]!;
  const right = r.sharpness.thirds[2]! + r.sharpness.thirds[5]! + r.sharpness.thirds[8]!;
  assert.ok(left > right * 10, `left ${left} right ${right}`);
  assert.ok(r.sharpness.separation > 10);
  assert.ok(r.composition.negativeSpace > 0.3 && r.composition.negativeSpace < 0.7, String(r.composition.negativeSpace));
  const subject = readLook(image(150, 150, (x, y) => (x > 105 && x < 140 && y > 10 && y < 45 ? [200, 30, 30] : [235, 235, 230])));
  assert.equal(subject.composition.heaviest, "top-right");
  assert.ok(subject.composition.negativeSpace > 0.8);
});

test("drift flags a palette and key change against the anchor and stays quiet for a near copy", () => {
  const anchor = readLook(image(80, 80, x => (x < 40 ? [200, 180, 150] : [240, 235, 225])));
  const near = readLook(image(80, 80, x => (x < 42 ? [198, 178, 152] : [238, 236, 224])));
  assert.deepEqual(lookDrift(near, anchor), []);
  const moved = readLook(image(80, 80, x => (x < 40 ? [20, 30, 90] : [40, 50, 120])));
  const flags = lookDrift(moved, anchor).map(f => f.measure);
  assert.ok(flags.includes("palette") && flags.includes("key") && flags.includes("temperature"), flags.join(","));
});
