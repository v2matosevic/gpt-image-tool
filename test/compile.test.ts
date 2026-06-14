import { test } from "node:test";
import assert from "node:assert/strict";
import { compose } from "../dist/presets/compile.js";
import type { Modifier, Preset } from "../dist/presets/types.js";

const preset: Preset = {
  id: "demo",
  category: "photography",
  title: "Demo",
  description: "test",
  recommended: { size: "1536x1024", quality: "high", format: "jpeg" },
  dims: {
    medium: "studio photograph",
    composition: "centered hero shot",
    setting: "grey backdrop",
    lighting: "soft softbox key",
    detail: "ultra-detailed",
  },
  avoid: ["watermark", "clutter"],
};

const warm: Modifier = { id: "warm", kind: "color", title: "Warm", dims: { color: "warm golden grade" } };

test("compose builds subject-led prose and pulls preset settings", () => {
  const c = compose({ subject: "a ceramic mug", preset });
  assert.match(c.prompt, /^Studio photograph of a ceramic mug\./);
  assert.match(c.prompt, /Centered hero shot\./);
  assert.match(c.prompt, /Avoid: watermark, clutter\.$/);
  assert.equal(c.size, "1536x1024");
  assert.equal(c.quality, "high");
  assert.equal(c.format, "jpeg");
  assert.equal(c.presetId, "demo");
});

test("explicit settings override the preset recommendation", () => {
  const c = compose({ subject: "x", preset, size: "1024x1024", format: "png" });
  assert.equal(c.size, "1024x1024");
  assert.equal(c.format, "png");
  assert.equal(c.quality, "high"); // unchanged from preset
});

test("modifiers overlay, overrides win, avoid merges + dedupes", () => {
  const c = compose({
    subject: "x",
    preset,
    modifiers: [warm],
    overrides: { setting: "dark walnut table", avoid: ["clutter", "blur"] },
  });
  assert.match(c.prompt, /warm golden grade/i); // from modifier
  assert.match(c.prompt, /dark walnut table/i); // override applied
  assert.doesNotMatch(c.prompt, /grey backdrop/i); // override replaced preset setting
  assert.equal(c.modifierIds[0], "warm");
  // avoid: watermark, clutter (preset) + blur (override), deduped
  assert.match(c.prompt, /Avoid: watermark, clutter, blur\.$/);
});

test("text override is rendered as a legible-text clause", () => {
  const c = compose({ subject: "a poster", preset, overrides: { text: "SALE" } });
  assert.match(c.prompt, /includes the text "SALE", rendered clearly/);
});

test("raw prompt bypasses composition but still appends avoid/text", () => {
  const c = compose({ rawPrompt: "a neon cat", overrides: { avoid: ["dogs"], text: "MEOW" } });
  assert.match(c.prompt, /^a neon cat\./);
  assert.match(c.prompt, /includes the text "MEOW"/);
  assert.match(c.prompt, /Avoid: dogs\.$/);
  assert.equal(c.size, "1024x1024"); // defaults, no preset
});

test("compose throws without subject or rawPrompt", () => {
  assert.throws(() => compose({ preset }), /requires `subject`/);
});

test("subjectDetail folds into the lead sentence", () => {
  const c = compose({
    subject: "a watch",
    preset: { ...preset, dims: { medium: "macro photo", subjectDetail: "brushed steel" } },
  });
  assert.match(c.prompt, /^Macro photo of a watch, brushed steel\./);
});
