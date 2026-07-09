import { test } from "node:test";
import assert from "node:assert/strict";
import { platePathFor, slidePath, sublinePosFor } from "../dist/socialcard.js";

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
