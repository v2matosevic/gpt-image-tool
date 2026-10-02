import { test } from "node:test";
import assert from "node:assert/strict";
import { platePathFor, slidePath, sublinePosFor, createSocialCarousel } from "../dist/socialcard.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ApiKeyProvider } from "../dist/providers/apikey.js";
import { encodePng } from "../dist/bgremove.js";
import { loadRGBA } from "../dist/imageops.js";

test("subline lands opposite the headline for EVERY position, including center family", () => {
  assert.equal(sublinePosFor("top-left"), "bottom-left");
  assert.equal(sublinePosFor("bottom-right"), "top-right");
  // regression: center positions used to no-op the flip and overlap the headline
  assert.equal(sublinePosFor("center"), "bottom-center");
  assert.equal(sublinePosFor("center-left"), "bottom-left");
  assert.equal(sublinePosFor("top-center"), "bottom-center");
});

test("plate path derivation handles file, extensionless, and directory outputPaths", () => {
  assert.equal(platePathFor("out/card.png"), "out/card-plate.png");
  assert.equal(platePathFor("out/card"), "out/card-plate.png");
  assert.equal(platePathFor("out/card.PNG"), "out/card-plate.png");
  // regression: a directory used to become 'out/-plate.png'
  assert.equal(platePathFor("out/"), "out/");
  assert.equal(platePathFor("out\\"), "out\\");
  assert.equal(platePathFor(undefined), undefined);
});

test("carousel slide paths are 1-indexed inside the output dir", () => {
  assert.equal(slidePath("out", "launch", 0), "out/launch-1.png");
  assert.equal(slidePath("out/", "launch", 2), "out/launch-3.png");
  assert.equal(slidePath(undefined, "launch", 0), undefined); // default dir + timestamped
});

test("carousel pins the accent actually used by slide one, including brand role selection", async t => {
  const dir = await mkdtemp(join(tmpdir(), "carousel-accent-role-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const plate = encodePng({ width: 320, height: 400, data: Buffer.alloc(320 * 400 * 4, 255) });
  t.mock.method(ApiKeyProvider.prototype, "generate", async () => ({ bytes: plate, format: "png" }));
  const result = await createSocialCarousel({ slides: [{ headline: "FIRST", accentWord: "FIRST", subline: "SUB" }, { headline: "NEXT", accentWord: "NEXT", subline: "SUB" }],
    brand: { name: "Fixture", colors: [{ name: "Pine", role: "primary", hex: "#234D3C" }, { name: "Marigold", role: "accent", hex: "#F1B954" }], fonts: { heading: { path: resolve("test/fixtures/brand-font.ttf") } } },
    backend: "apikey", outputDir: dir });
  for (const slide of result.slides) {
    assert.equal(slide.accentColor, "#F1B954");
    const img = await loadRGBA(slide.path); let matching = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 241 && img.data[i + 1] === 185 && img.data[i + 2] === 84) matching++;
    assert.ok(matching > 50, "the actual rendered slide contains the chosen accent");
  }
});
