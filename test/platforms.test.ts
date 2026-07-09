import { test } from "node:test";
import assert from "node:assert/strict";
import { getPlatform, PLATFORMS, PLATFORM_IDS } from "../dist/platforms.js";

test("every platform has a native size, clause, and note", () => {
  assert.ok(PLATFORMS.length >= 6);
  for (const p of PLATFORMS) {
    assert.ok(p.id && p.title && p.size && p.note, p.id);
    assert.ok(p.clause.trim().endsWith("."), `${p.id} clause must be a full sentence (joins the prompt)`);
  }
});

test("getPlatform resolves ids case-insensitively and rejects unknowns", () => {
  assert.equal(getPlatform("instagram-story").size, "1152x2048");
  assert.equal(getPlatform("Instagram-Story").id, "instagram-story");
  assert.throws(() => getPlatform("myspace"), /Unknown platform/);
});

test("story/tiktok safe insets cover the documented UI zones", () => {
  const story = getPlatform("instagram-story");
  assert.equal(story.safeInsets?.top, 0.1);
  assert.equal(story.safeInsets?.bottom, 0.12);
  const tiktok = getPlatform("tiktok");
  assert.equal(tiktok.safeInsets?.right, 0.14);
});

test("PLATFORM_IDS matches the registry", () => {
  assert.deepEqual(PLATFORM_IDS, PLATFORMS.map((p) => p.id));
});
