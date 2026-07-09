import { test } from "node:test";
import assert from "node:assert/strict";
import { blockBox, buildOverlaySvg, escapeXml, layoutBlock, regionContrast, wrapText } from "../dist/typeset.js";

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

test("accent word gets its own colored tspan, case-insensitively, uppercase-aware", () => {
  const svg = buildOverlaySvg(
    [{ text: "više od očekivanja", uppercase: true, accentWord: "od", accentColor: "#c2261f" }],
    2000,
    2000,
    NO_INSETS,
  );
  assert.match(svg, /<tspan fill="#c2261f">OD<\/tspan>/);
  assert.match(svg, /VIŠE /); // rest of the line intact around the accent
});

test("forced scrim draws a rounded rect sized to the block box", () => {
  const svg = buildOverlaySvg([{ text: "HI", position: "top-left", fontSize: 100 }], 1000, 1000, NO_INSETS, [true]);
  assert.match(svg, /<rect [^>]*rx="\d+"/);
  const none = buildOverlaySvg([{ text: "HI", position: "top-left", fontSize: 100 }], 1000, 1000, NO_INSETS, [false]);
  assert.doesNotMatch(none, /<rect/);
});

test("regionContrast: dark text on white is high, on near-black is low", () => {
  const solid = (v: number) => {
    const data = Buffer.alloc(100 * 100 * 4);
    for (let i = 0; i < 100 * 100; i++) data.set([v, v, v, 255], i * 4);
    return { width: 100, height: 100, data };
  };
  const l = layoutBlock({ text: "X", position: "center", fontSize: 40 }, 100, 100, 0, NO_INSETS);
  const box = blockBox(l, 100, 100);
  const darkTextLum = 0.05;
  assert.ok(regionContrast(solid(255), box, darkTextLum) > 10);
  assert.ok(regionContrast(solid(20), box, darkTextLum) < 2.5);
});
