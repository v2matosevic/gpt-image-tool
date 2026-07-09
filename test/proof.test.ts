import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict } from "../dist/proof.js";

test("parses a clean JSON verdict", () => {
  const v = parseVerdict('{"pass":false,"textRead":"PREMIUM ISNT LOUD","issues":["missing apostrophe in ISN\'T"]}');
  assert.equal(v.pass, false);
  assert.equal(v.textRead, "PREMIUM ISNT LOUD");
  assert.deepEqual(v.issues, ["missing apostrophe in ISN'T"]);
  assert.ok(!v.unverified);
});

test("tolerates code fences and surrounding prose", () => {
  const v = parseVerdict('Here is my assessment:\n```json\n{"pass":true,"textRead":"AVES","issues":[]}\n```');
  assert.equal(v.pass, true);
  assert.equal(v.textRead, "AVES");
});

test("missing pass falls back to issues-derived verdict", () => {
  assert.equal(parseVerdict('{"issues":[]}').pass, true);
  assert.equal(parseVerdict('{"issues":["garbled glyph in headline"]}').pass, false);
});

test("unparseable reply fails OPEN as unverified", () => {
  const v = parseVerdict("I could not analyze the image, sorry.");
  assert.equal(v.pass, true);
  assert.equal(v.unverified, true);
});
