// Exact brand identity around supplied/generated visual references. No model-drawn labels or logos.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { brandSchema, resolveBrand, brandColor, brandTokens, brandCss } from "./branding.js";
import { loadOutlineFont, outlineText, fitOutline, type OutlineFont } from "./font.js";
import { loadArtwork, placeArtwork, type Artwork } from "./logo.js";
import { decodeRGBA, fitTo, loadRGBA } from "./imageops.js";
import { encodePng } from "./bgremove.js";
import { svgDocument, rasterizeSvg } from "./vector.js";
import { generateImage } from "./generate.js";
import { createHash } from "node:crypto";

export const brandBoardSchema = z.object({
  brand: brandSchema.optional(),
  outDir: z.string().min(1),
  layout: z.enum(["editorial", "grid"]).default("editorial"),
  assets: z.array(z.object({ path: z.string().min(1), label: z.string().trim().min(1).max(120), fit: z.enum(["cover", "contain"]).default("cover") }).strict()).max(8).default([]),
  generate: z.array(z.object({ subject: z.string().trim().min(1).max(3000), preset: z.string().optional(), label: z.string().trim().min(1).max(120) }).strict()).max(4).default([]),
  keywords: z.array(z.string().trim().min(1).max(50)).max(8).default([]),
  quality: z.enum(["auto", "low", "medium", "high", "xhigh", "max"]).optional(),
  backend: z.enum(["subscription", "apikey"]).optional(),
  imageModel: z.string().optional(),
}).strict();
export type BrandBoardInput = z.input<typeof brandBoardSchema>;

function luminance(hex: string): number {
  const cs = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return cs[0]! * 0.2126 + cs[1]! * 0.7152 + cs[2]! * 0.0722;
}
export function contrastRatio(a: string, b: string): number { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

export async function createBrandBoard(input: BrandBoardInput) {
  const o = brandBoardSchema.parse(input), outDir = resolve(o.outDir);
  const brand = resolveBrand(o.brand, outDir);
  if (!brand.fonts?.heading) throw new Error("A brand board requires brand.fonts.heading.path; fonts are never substituted.");
  const heading = await loadOutlineFont(brand.fonts.heading.path);
  const body = brand.fonts.body ? await loadOutlineFont(brand.fonts.body.path) : heading;
  const ink = brandColor(brand, "ink", "#19231E"), paper = brandColor(brand, "paper", "#F5F1E9");
  const primary = brandColor(brand, "primary", ink);
  // Preflight all fonts/copy and supplied images before spending quota.
  const headingSample = "Aa Bb Cc 0123";
  const bodySample = "The details make the difference.";
  const editorial = o.layout === "editorial";
  const metaTitle = editorial ? "IDENTITY / MATERIAL / MOOD" : "IDENTITY / VISUAL SYSTEM";
  const directionWords = o.keywords.length ? o.keywords : [brand.tagline ?? "Color, form, texture"];
  const captions = [...o.assets, ...o.generate].map((a, i) => `${String(i + 1).padStart(2, "0")} / ${a.label}`);
  const colorLabels = brand.colors.flatMap(c => [c.name, `${c.hex.toUpperCase()} / ${c.role}`, `Ink ${contrastRatio(c.hex, ink).toFixed(1)}:1 / Paper ${contrastRatio(c.hex, paper).toFixed(1)}:1`]);
  const exactBodyText = [brand.tagline ?? "Brand direction", metaTitle, bodySample, `TYPE / ${heading.name}`, body.name, "DIRECTION", ...directionWords, ...colorLabels, ...captions];
  for (const [f, texts] of [[heading, [brand.name, headingSample]], [body, exactBodyText]] as Array<[OutlineFont, string[]]>) {
    for (const text of texts) if (text.trim()) outlineText(f, text.replace(/\s+/g, " "), ink);
  }
  const mark = brand.logos?.mark ? await loadArtwork(brand.logos.mark, "board-mark") : undefined;
  const word = brand.logos?.wordmark ? await loadArtwork(brand.logos.wordmark, "board-word") : undefined;
  const assets: Array<{ path: string; label: string; fit: "cover" | "contain"; origin: "supplied" | "generated"; sidecar?: string; sha256: string }> = [];
  for (const asset of o.assets) {
    const rgba = await loadRGBA(asset.path);
    assets.push({ ...asset, path: resolve(asset.path), origin: "supplied", sha256: createHash("sha256").update(encodePng(rgba)).digest("hex") });
  }
  if (assets.length + o.generate.length > 8) throw new Error("A board supports at most 8 total supplied and generated tiles.");
  await mkdir(outDir, { recursive: true });
  let anchor: string | undefined;
  for (const [i, spec] of o.generate.entries()) {
    const g = await generateImage({ subject: spec.subject, preset: spec.preset ?? "brand-material", brand,
      brief: { purpose: "brand mood-board visual reference", avoid: ["lettering", "logos", "watermarks"] },
      references: anchor ? [{ path: anchor, role: "style" }] : [], styleReference: [],
      proof: false, count: 1, series: 1, background: "opaque", transparent: false,
      outputPath: join(outDir, `tile-${i + 1}.png`), quality: o.quality, backend: o.backend, imageModel: o.imageModel });
    anchor ??= g.path;
    assets.push({ path: g.path, label: spec.label, fit: "cover", origin: "generated", sidecar: `${g.path}.json`, sha256: createHash("sha256").update(Buffer.from(g.base64, "base64")).digest("hex") });
  }
  const extraStart = editorial && assets.length ? 1 : 0;
  const rows = Math.ceil((assets.length - extraStart) / 3);
  const width = 1920, height = rows ? 1120 + rows * 440 : 1180;
  const bits: string[] = [`<rect width="100%" height="100%" fill="${paper}"/>`];
  const textBounds: Array<{ text: string; x: number; y: number; width: number; height: number; fontSize: number }> = [];
  const text = (s: string, x: number, y: number, w: number, h: number, f = body, c = ink) => {
    if (!s.trim()) return;
    const outline = outlineText(f, s, c, h * 1.25);
    const scale = Math.min(1, w / Math.max(outline.width, outline.advanceWidth));
    const top = y + h + outline.bearingY * scale;
    bits.push(`<g transform="translate(${x} ${top}) scale(${scale})">${outline.body}</g>`);
    textBounds.push({ text: s, x, y: top, width: outline.width * scale, height: outline.height * scale, fontSize: h * 1.25 * scale });
  };
  text(brand.name, 64, 56, 1290, 105, heading);
  text(brand.tagline ?? "Brand direction", 68, 185, 1400, 27);
  text(metaTitle, 1450, 65, 400, 17);
  bits.push(`<path d="M64 235H1856" stroke="${ink}" stroke-opacity="0.25"/>`);

  const tile = async (index: number, x: number, y: number, w: number, h: number) => {
    const a = assets[index]!;
    const rgba = fitTo(await loadRGBA(a.path), Math.round(w), Math.round(h), a.fit);
    bits.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#E5E2DA"/><image x="${x}" y="${y}" width="${w}" height="${h}" href="data:image/png;base64,${encodePng(rgba).toString("base64")}"/>`);
    const labelX = Math.max(64, x);
    text(`${String(index + 1).padStart(2, "0")} / ${a.label}`, labelX, y + h + 18, w - (labelX - x), 22);
  };
  let logo: Artwork | undefined = word ?? mark;
  if (editorial && assets.length) await tile(0, 0, 278, 1164, 518);
  else if (editorial) {
    bits.push(`<rect x="64" y="278" width="1100" height="518" fill="${ink}"/>`);
    // Exact outlined type, not an invented replacement for a supplied logo.
    if (logo) {
      bits.push(`<rect x="176" y="372" width="876" height="300" fill="${paper}"/>`, placeArtwork(logo, 228, 414, 772, 216));
    } else text(brand.name, 125, 456, 968, 150, heading, paper);
  }
  if (editorial) {
    bits.push(`<rect x="1210" y="278" width="646" height="242" fill="${paper}" stroke="${ink}" stroke-opacity="0.15"/>`);
    if (logo) bits.push(placeArtwork(logo, 1250, 298, 566, 195));
    else text(brand.name, 1260, 348, 546, 88, heading, primary);
    text("TYPE / " + heading.name, 1210, 558, 646, 21);
    text(headingSample, 1210, 606, 646, 83, heading);
    text(bodySample, 1210, 731, 646, 32);
    text(body.name, 1210, 783, 646, 19);
  } else {
    bits.push(`<rect x="64" y="278" width="550" height="518" fill="${paper}" stroke="${ink}" stroke-opacity="0.15"/>`);
    if (logo) bits.push(placeArtwork(logo, 110, 360, 458, 350));
    else text(brand.name, 100, 440, 478, 75, heading);
    text("TYPE / " + heading.name, 670, 308, 575, 21);
    text(headingSample, 670, 384, 575, 73, heading);
    text(bodySample, 670, 530, 575, 28);
    text(body.name, 670, 590, 575, 19);
    text("DIRECTION", 1280, 308, 576, 21);
    directionWords.forEach((s, i) => text(s, 1280, 380 + i * 44, 576, 24));
  }

  const swatchWidth = 1100 / brand.colors.length;
  const contrasts = brand.colors.map((c, i) => {
    const x = 64 + i * swatchWidth;
    bits.push(`<rect x="${x}" y="892" width="${swatchWidth - 10}" height="102" fill="${c.hex}"${contrastRatio(c.hex, paper) < 1.2 ? ` stroke="${ink}" stroke-opacity="0.25"` : ""}/>`);
    text(c.name, x, 1011, swatchWidth - 12, 19);
    text(`${c.hex.toUpperCase()} / ${c.role}`, x, 1045, swatchWidth - 12, 16);
    const againstInk = contrastRatio(c.hex, ink), againstPaper = contrastRatio(c.hex, paper);
    text(`Ink ${againstInk.toFixed(1)}:1 / Paper ${againstPaper.toFixed(1)}:1`, x, 1075, swatchWidth - 12, 14);
    return { ...c, againstInk, againstPaper };
  });
  if (editorial) {
    text("DIRECTION", 1210, 895, 646, 19);
    directionWords.forEach((s, i) => text(s, 1210, 937 + i * (directionWords.length > 5 ? 21 : 31), 646, directionWords.length > 5 ? 17 : 22));
  }
  for (let i = extraStart; i < assets.length; i++) {
    const index = i - extraStart;
    const row = Math.floor(index / 3), cols = Math.min(3, assets.length - extraStart - row * 3);
    const tileWidth = (1792 - (cols - 1) * 32) / cols;
    await tile(i, 64 + index % 3 * (tileWidth + 32), 1150 + row * 440, tileWidth, 350);
  }
  const svg = svgDocument(bits.join(""), width, height, `${brand.name} brand direction board`);
  const path = join(outDir, "board.png"), svgPath = join(outDir, "board.svg"), manifest = join(outDir, "board.json");
  await writeFile(svgPath, svg);
  await writeFile(path, await rasterizeSvg(svg));
  const tokens = { ...brandTokens(brand), typography: { heading: { family: heading.family, weight: heading.weight, style: heading.style }, body: { family: body.family, weight: body.weight, style: body.style } } };
  await writeFile(join(outDir, "tokens.json"), JSON.stringify(tokens, null, 2));
  const fontCss = `\n/* Load licensed webfonts separately; these are inspected family names and weights. */\n:root {\n  --brand-font-heading: ${JSON.stringify(heading.family)};\n  --brand-font-heading-weight: ${heading.weight};\n  --brand-font-heading-style: ${heading.style};\n  --brand-font-body: ${JSON.stringify(body.family)};\n  --brand-font-body-weight: ${body.weight};\n  --brand-font-body-style: ${body.style};\n}\n`;
  await writeFile(join(outDir, "tokens.css"), brandCss(brand) + fontCss);
  const notes = ["Board SVG is self-contained and contains embedded raster tiles; it is not an all-vector logo master.", "Contrast ratios are measurements, not approval of every possible color pairing."];
  if (Buffer.byteLength(svg) > 20_000_000) notes.push("Board SVG exceeds 20 MB; use the PNG for sharing or reduce tile count.");
  const result = { path, svgPath, manifest, width, height, layout: o.layout, assets, contrasts, notes, textBounds,
    fonts: [heading, body].map(f => ({ path: f.path, family: f.family, name: f.name, subfamily: f.subfamily, weight: f.weight, style: f.style, sha256: f.sha256 })),
    logoSources: [mark, word].filter(Boolean).map(a => ({ path: a!.source, sha256: a!.sha256, vector: a!.vector })),
    tokens: { json: join(outDir, "tokens.json"), css: join(outDir, "tokens.css") } };
  await writeFile(manifest, JSON.stringify(result, null, 2));
  return result;
}
