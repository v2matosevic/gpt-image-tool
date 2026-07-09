import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOverlaySvg, escapeXml, wrapText } from "../dist/typeset.js";

const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

test("escapeXml escapes all five XML specials", () => {
  assert.equal(escapeXml(`<a & "b" 'c'>`), "&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;");
});

test("wrapText wraps long copy and respects hard newlines", () => {
  const lines = wrapText("premium is not loud it is precise", 100, 800);
  assert.ok(lines.length > 1);
  assert.equal(lines.join(" "), "premium is not loud it is precise"); // no words lost
  assert.deepEqual(wrapText("one\ntwo", 40, 10_000), ["one", "two"]);
});

test("buildOverlaySvg renders verbatim, uppercased, escaped text", () => {
  const svg = buildOverlaySvg(
    [{ text: 'čips & "đumbir"', uppercase: true, color: "#8b0f24", fontFamily: "Inter" }],
    1024,
    1280,
    NO_INSETS,
  );
  assert.match(svg, /ČIPS &amp;/); // diacritics survive, XML escaped (may wrap across tspans)
  assert.match(svg, /&quot;ĐUMBIR&quot;/);
  assert.match(svg, /fill="#8b0f24"/);
  assert.match(svg, /font-family="Inter, 'Segoe UI'/);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1024" height="1280">/);
});

test("safe insets push a bottom-center block up", () => {
  const flat = buildOverlaySvg([{ text: "HELLO", position: "bottom-center" }], 1000, 2000, NO_INSETS);
  const inset = buildOverlaySvg([{ text: "HELLO", position: "bottom-center" }], 1000, 2000, { ...NO_INSETS, bottom: 0.2 });
  const y = (svg: string) => Number(/y="(\d+)"/.exec(svg)![1]);
  assert.ok(y(inset) < y(flat), `inset y ${y(inset)} must sit above flat y ${y(flat)}`);
});
