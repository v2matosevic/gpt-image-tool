import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, resetProfileCache } from "../dist/profile.js";
import { overlay, mergeStyle } from "../dist/generate.js";

function withProfile(json: string, fn: () => void) {
  const dir = mkdtempSync(join(tmpdir(), "gptimg-prof-"));
  const path = join(dir, ".gptimage.json");
  writeFileSync(path, json);
  process.env.GPT_IMAGE_PROFILE = path;
  resetProfileCache();
  try {
    fn();
  } finally {
    delete process.env.GPT_IMAGE_PROFILE;
    resetProfileCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadProfile reads and parses a .gptimage.json via env override", () => {
  withProfile(JSON.stringify({ preset: "flat-vector", outputDir: "./public/img", style: { color: "navy and coral" } }), () => {
    const loaded = loadProfile();
    assert.ok(loaded);
    assert.equal(loaded!.profile.preset, "flat-vector");
    assert.equal(loaded!.profile.outputDir, "./public/img");
    assert.equal(loaded!.profile.style?.color, "navy and coral");
  });
});

test("loadProfile returns null on malformed JSON and when absent", () => {
  withProfile("{ not valid json", () => {
    assert.equal(loadProfile(), null);
  });
  process.env.GPT_IMAGE_PROFILE = join(tmpdir(), "definitely-missing-" + process.pid + ".json");
  resetProfileCache();
  assert.equal(loadProfile(), null);
  delete process.env.GPT_IMAGE_PROFILE;
  resetProfileCache();
});

test("overlay: per-call args win; modifiers and avoid merge", () => {
  const base = {
    preset: "product-studio",
    modifiers: ["warm-grade"],
    style: { color: "brand navy", avoid: ["watermark"] },
    size: "1024x1024" as const,
    backend: "subscription",
  };
  const top = {
    subject: "a mug",
    modifiers: ["cinematic"],
    style: { color: "brand coral", avoid: ["clutter"] },
    size: "1536x1024" as const,
  };
  const r = overlay(base, top);
  assert.equal(r.subject, "a mug");
  assert.equal(r.preset, "product-studio"); // inherited from base
  assert.deepEqual(r.modifiers, ["warm-grade", "cinematic"]); // merged
  assert.equal(r.style?.color, "brand coral"); // top wins per-key
  assert.deepEqual(r.style?.avoid, ["watermark", "clutter"]); // avoid concatenated
  assert.equal(r.size, "1536x1024"); // top wins
  assert.equal(r.backend, "subscription"); // inherited
});

test("mergeStyle dedupes avoid and prefers top text", () => {
  const r = mergeStyle({ avoid: ["a", "b"], text: "OLD", lighting: "soft" }, { avoid: ["b", "c"], text: "NEW" });
  assert.deepEqual(r?.avoid, ["a", "b", "c"]);
  assert.equal(r?.text, "NEW");
  assert.equal(r?.lighting, "soft"); // base dim preserved when top doesn't set it
});
