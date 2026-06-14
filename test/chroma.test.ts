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
