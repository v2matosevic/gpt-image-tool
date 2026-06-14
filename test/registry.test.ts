import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_MODIFIERS, ALL_PRESETS, build, catalog, getPreset } from "../dist/presets/index.js";
import { DIM_ORDER } from "../dist/presets/types.js";

const SIZES = new Set(["auto", "1024x1024", "1536x1024", "1024x1536"]);
const QUALITIES = new Set(["auto", "low", "medium", "high"]);
const FORMATS = new Set(["png", "jpeg", "webp"]);
const DIM_KEYS = new Set<string>(DIM_ORDER);

test("preset ids are unique and well-formed", () => {
  const ids = ALL_PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate preset id");
  for (const p of ALL_PRESETS) {
    assert.match(p.id, /^[a-z0-9-]+$/, `bad id: ${p.id}`);
    assert.ok(p.title && p.description, `${p.id} missing title/description`);
    assert.ok(Object.keys(p.dims).length >= 3, `${p.id} too few dims`);
    for (const k of Object.keys(p.dims)) assert.ok(DIM_KEYS.has(k), `${p.id} has unknown dim "${k}"`);
  }
});

test("every preset's recommended settings are valid enum values", () => {
  for (const p of ALL_PRESETS) {
    assert.ok(SIZES.has(p.recommended.size), `${p.id} bad size`);
    assert.ok(QUALITIES.has(p.recommended.quality), `${p.id} bad quality`);
    assert.ok(FORMATS.has(p.recommended.format), `${p.id} bad format`);
  }
});

test("modifier ids are unique and only touch known dims", () => {
  const ids = ALL_MODIFIERS.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate modifier id");
  for (const m of ALL_MODIFIERS) {
    for (const k of Object.keys(m.dims)) assert.ok(DIM_KEYS.has(k), `${m.id} has unknown dim "${k}"`);
  }
});

test("library is comprehensive (>=30 presets across all 5 categories)", () => {
  assert.ok(ALL_PRESETS.length >= 30, `only ${ALL_PRESETS.length} presets`);
  const cats = new Set(ALL_PRESETS.map((p) => p.category));
  for (const c of ["photography", "illustration", "design", "render3d", "specialized"]) {
    assert.ok(cats.has(c as any), `no presets in category ${c}`);
  }
});

test("every preset compiles to a non-trivial prompt", () => {
  for (const p of ALL_PRESETS) {
    const c = build({ subject: "a test subject", preset: p.id });
    assert.ok(c.prompt.length > 30, `${p.id} produced a trivial prompt`);
    assert.match(c.prompt, /a test subject/);
  }
});

test("build throws helpfully on unknown preset / modifier", () => {
  assert.throws(() => build({ subject: "x", preset: "nope-xyz" }), /Unknown preset "nope-xyz"/);
  assert.throws(() => build({ subject: "x", modifiers: ["nope-xyz"] }), /Unknown modifier "nope-xyz"/);
});

test("catalog returns presets + modifiers + usage", () => {
  const c = catalog();
  assert.equal(c.presets.length, ALL_PRESETS.length);
  assert.ok(c.modifiers.length >= 20);
  assert.ok(c.usage.includes("generate_image"));
  const filtered = catalog("photography");
  assert.ok(filtered.presets.every((p) => p.category === "photography"));
});

test("getPreset round-trips", () => {
  assert.equal(getPreset("product-studio")?.category, "photography");
  assert.equal(getPreset("missing"), undefined);
});
