import { test } from "node:test";
import assert from "node:assert/strict";
import { pickChromaKey } from "../dist/generate.js";

test("pickChromaKey selects the key farthest from the brand hue", () => {
  // Teal brand (AVES) must NEVER land on the green key.
  assert.equal(pickChromaKey("vivid teal #1CB5A3 with mint #5EEAD4").name, "magenta");
  // Warm red -> green is farthest.
  assert.equal(pickChromaKey("warm red #E03131").name, "green");
  // Blue brand avoids the blue key.
  assert.notEqual(pickChromaKey("royal blue #1E5AFF").name, "blue");
  // Magenta/pink brand falls to green.
  assert.equal(pickChromaKey("hot pink #FF2BD4").name, "green");
  // No usable hint -> safe green default.
  assert.equal(pickChromaKey(undefined).name, "green");
  assert.equal(pickChromaKey("teal, no hex code here").name, "green");
});

test("pickChromaKey dodges EVERY palette color, not just the first", () => {
  // Red alone -> green key; but a palette that ALSO contains green must not pick green.
  assert.equal(pickChromaKey(["#e03131"]).name, "green");
  const key = pickChromaKey(["#e03131", "#2f9e44"]); // red + green brand palette
  assert.notEqual(key.name, "green");
  // Full-spread palette picks the key with the best worst-case distance (never crashes).
  assert.ok(pickChromaKey(["#e03131", "#2f9e44", "#1e5aff", "#ff00ff"]).name);
});
