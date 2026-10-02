import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { brandSchema, resolveBrandPaths } from "../dist/branding.js";
import { loadOutlineFont, outlineText, wrapOutlineText } from "../dist/font.js";
import { parseVectorSvg, rasterizeSvg, svgDocument } from "../dist/vector.js";
import { exportLogoKit, monochrome } from "../dist/logo.js";
import { createBrandBoard, contrastRatio } from "../dist/brandboard.js";
import { loadRGBA, decodeRGBA } from "../dist/imageops.js";
import { encodePng } from "../dist/bgremove.js";
import opentype from "opentype.js";
import { createSocialCarousel } from "../dist/socialcard.js";

const fixture = resolve("test/fixtures");
const fontPath = join(fixture, "brand-font.ttf"), markPath = join(fixture, "brand-mark.svg");
const brand = { name: "NORTHLINE", colors: [{ name: "Ink", role: "ink", hex: "#183C2F" }, { name: "Paper", role: "paper", hex: "#F6F2E9" }], fonts: { heading: { path: fontPath } }, logos: { mark: markPath } };

test("brand validates fields and resolves profile-relative files without hiding typos", () => {
  assert.equal(brandSchema.parse(brand).name, "NORTHLINE");
  assert.throws(() => brandSchema.parse({ ...brand, colors: [{ name: "bad", role: "primary", hex: "green" }] }), /colors/);
  assert.throws(() => brandSchema.parse({ ...brand, typo: true }), /typo/);
  assert.throws(() => brandSchema.parse({ ...brand, colors: [brand.colors[0], brand.colors[0]] }), /unique/);
  assert.equal(resolveBrandPaths({ ...brand, fonts: { heading: { path: "font.ttf" } } }, fixture).fonts!.heading.path, join(fixture, "font.ttf"));
});

test("font-file outlines use real metrics, NFC and explicit glyph coverage", async () => {
  const f = await loadOutlineFont(fontPath);
  assert.match(f.name, /Harness Fixture/);
  assert.equal(f.sha256.length, 64);
  assert.equal(f.font.getAdvanceWidth("ABC", 100), 180);
  assert.equal(outlineText(f, "e\u0301").body, outlineText(f, "é").body);
  assert.equal(outlineText(f, "ABC", "#000000", 100, { tracking: 10 }).width - outlineText(f, "ABC", "#000000", 100).width, 20);
  assert.deepEqual(wrapOutlineText(f, "AA BB CC", 100, 250), ["AA", "BB", "CC"]);
  const accented = outlineText(f, "A B", "#111111", 100, { accentWord: "B", accentColor: "#FF0000" });
  assert.equal((accented.body.match(/<path /g) ?? []).length, 3, "accent is a single glyph path, not an overpainted duplicate");
  assert.match(outlineText(f, "ČĆŽŠĐ").body, /<path/);
  assert.throws(() => outlineText(f, "漢"), /missing glyphs: 漢/);
});

test("SVG inputs reject active/external/font-dependent content and distinguish embedded rasters", async () => {
  assert.throws(() => parseVectorSvg('<svg width="20" height="20"><script>alert(1)</script></svg>'), /unsupported/);
  assert.throws(() => parseVectorSvg('<svg width="20" height="20"><use href="https://example.com/a.svg#x"/></svg>'), /external/);
  assert.throws(() => parseVectorSvg('<svg width="20" height="20"><text>Hello</text></svg>'), /unsupported/);
  assert.throws(() => parseVectorSvg('<!DOCTYPE svg><svg width="20" height="20"/>'), /document types/);
  const data = encodePng({ width: 1, height: 1, data: Buffer.from([0, 0, 0, 255]) }).toString("base64");
  assert.equal(parseVectorSvg(`<svg width="20" height="20"><image width="20" height="20" href="data:image/png;base64,${data}"/></svg>`, "raster", true).vector, false);
});

test("monochrome preserves white counters and accepts an all-white reversed mark", () => {
  const img = { width: 3, height: 1, data: Buffer.from([20, 30, 40, 255, 255, 255, 255, 255, 20, 30, 40, 128]) };
  const mono = monochrome(img, "#FF0000");
  assert.deepEqual([...mono.data], [255, 0, 0, 255, 255, 0, 0, 0, 255, 0, 0, 128]);
  assert.equal(monochrome({ width: 1, height: 1, data: Buffer.from([255, 255, 255, 255]) }, "#123456").data[3], 255);
});

test("logo kit emits true vectors, opaque touch icons, safe maskable icons and an explicit manifest", async t => {
  const dir = await mkdtemp(join(tmpdir(), "logo-kit-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const kit = await exportLogoKit({ brand, brandName: brand.name, outDir: dir, formats: ["png", "svg"] });
  for (const layout of ["mark", "wordmark", "horizontal", "stacked"]) {
    const svg = kit.files.find(f => f.layout === layout && f.format === "svg" && f.variant === "color");
    assert.ok(svg, layout); assert.doesNotMatch(await readFile(svg.path, "utf8"), /<image|<text/);
  }
  const touch = await loadRGBA(join(dir, "web/apple-touch-icon.png"));
  for (let i = 3; i < touch.data.length; i += 4) assert.equal(touch.data[i], 255);
  const masked = await loadRGBA(join(dir, "web/icon-maskable-512.png"));
  const paper = [246, 242, 233];
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    const i = (y * 512 + x) * 4;
    if (paper.some((c, k) => Math.abs(masked.data[i + k]! - c) > 3)) assert.ok(Math.hypot(x - 255.5, y - 255.5) <= 205.5, "ink stays in maskable safe circle");
  }
  const ico = await readFile(join(dir, "web/favicon.ico")); assert.equal(ico.readUInt16LE(4), 3);
  assert.equal(JSON.parse(await readFile(kit.manifest, "utf8")).deliverable, "kit");
  assert.equal(kit.wordmarkOrigin, "typeset name, not approved artwork");
  assert.ok(!kit.files.some(f => f.layout === "mark" && f.variant === "mono"), "a two-tone mark cannot silently become a solid mono silhouette");
});

test("brand.name does not authorize a replacement wordmark, and supplied mono preserves the counter", async t => {
  const dir = await mkdtemp(join(tmpdir(), "approved-kit-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const kit = await exportLogoKit({ brand: { ...brand, logos: { mark: markPath, monoDark: join(fixture, "brand-mark-mono.svg") } }, outDir: dir, formats: ["png", "svg"], social: false });
  assert.equal(kit.wordmarkOrigin, "none");
  assert.ok(!kit.files.some(f => f.layout === "wordmark"));
  const mono = kit.files.find(f => f.layout === "mark" && f.variant === "mono" && f.format === "png")!;
  const rgba = await loadRGBA(mono.path);
  assert.equal(rgba.data[(Math.floor(rgba.height / 2) * rgba.width + Math.floor(rgba.width / 2)) * 4 + 3], 0, "the leaf remains an open counter");
});

test("a supplied mono mark cannot authorize flattening a multicolor wordmark", async t => {
  const dir = await mkdtemp(join(tmpdir(), "colored-wordmark-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const kit = await exportLogoKit({ brand: { ...brand, logos: { mark: markPath, wordmark: markPath, monoDark: join(fixture, "brand-mark-mono.svg") } },
    outDir: dir, layouts: ["wordmark", "horizontal"], formats: ["png", "svg"], variants: ["color", "mono"], social: false });
  assert.ok(!kit.files.some(f => f.variant === "mono"));
  assert.ok(kit.notes.some(n => n.includes("wordmark has multiple")));
});

test("PNG-only logo gets raster delivery; SVG-wrapped PNG is also not a vector", async t => {
  const dir = await mkdtemp(join(tmpdir(), "raster-kit-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = await rasterizeSvg(await readFile(markPath, "utf8"));
  const path = join(dir, "input.png"); await writeFile(path, bytes);
  const kit = await exportLogoKit({ markPath: path, outDir: join(dir, "kit"), formats: ["png", "svg"], social: false });
  assert.ok(kit.files.every(f => f.format !== "svg"));
  assert.ok(kit.notes.some(n => n.includes("raster artwork")));
  const wrapped = parseVectorSvg(svgDocument(`<image width="256" height="256" href="data:image/png;base64,${bytes.toString("base64")}"/>`, 256, 256), "a", true);
  assert.equal(wrapped.vector, false);
});

test("both board layouts deliver the same exact outlined identity and reusable color tokens offline", async t => {
  const dir = await mkdtemp(join(tmpdir(), "brand-board-")); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const layout of ["editorial", "grid"] as const) {
    const result = await createBrandBoard({ brand, outDir: join(dir, layout), layout, assets: [{ path: markPath, label: "Approved mark", fit: "contain" }] });
    const svg = await readFile(result.svgPath, "utf8"); assert.doesNotMatch(svg, /<text\b/); assert.match(svg, /<path\b/);
    const png = await loadRGBA(result.path); assert.equal(png.width, result.width); assert.equal(png.height, result.height);
    const css = await readFile(result.tokens.css, "utf8"); for (const c of brand.colors) assert.ok(css.includes(c.hex.toUpperCase()));
    assert.equal(result.assets[0].origin, "supplied");
    for (const b of result.textBounds) assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.width <= result.width + 1 && b.y + b.height <= result.height + 1, `text fits: ${b.text}`);
    assert.match(svg, /fill="#F6F2E9" stroke="#183C2F" stroke-opacity="0.25"/, "paper swatch gets a visible border");
    const tokens = JSON.parse(await readFile(result.tokens.json, "utf8")); assert.equal(tokens.typography.heading.family, "Harness Fixture"); assert.equal(tokens.typography.heading.weight, 400);
  }
  assert.equal(contrastRatio("#000000", "#FFFFFF"), 21);
});

test("board annotations and every carousel slide validate glyphs before any image request", async t => {
  const dir = await mkdtemp(join(tmpdir(), "brand-preflight-")); t.after(() => rm(dir, { recursive: true, force: true }));
  let calls = 0; t.mock.method(globalThis, "fetch", () => { calls++; throw new Error("Unexpected provider request"); });
  const f = await loadOutlineFont(fontPath);
  const glyphs = Array.from({ length: f.font.glyphs.length }, (_, i) => f.font.glyphs.get(i)).filter(g => g.unicode !== 58);
  const subset = new opentype.Font({ familyName: "Preflight", styleName: "Regular", unitsPerEm: 1000, ascender: 800, descender: -200, glyphs });
  const missingColon = join(dir, "missing-colon.ttf"); await writeFile(missingColon, Buffer.from(subset.toArrayBuffer()));
  await assert.rejects(createBrandBoard({ brand: { ...brand, fonts: { heading: { path: missingColon } } }, outDir: join(dir, "board"), generate: [{ subject: "paper", label: "Material" }] }), /missing glyphs: :/);
  await assert.rejects(createSocialCarousel({ slides: [{ headline: "VALID" }, { headline: "漢" }], headlineFontFile: fontPath, backend: "apikey", outputDir: join(dir, "slides") }), /missing glyphs: 漢/);
  assert.equal(calls, 0);
});
