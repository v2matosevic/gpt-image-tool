import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { brandSchema, brandColor, resolveBrand, safeNameSchema } from "./branding.js";
import { loadOutlineFont, outlineText, type OutlineFont } from "./font.js";
import { parseVectorSvg, rasterizeSvg, recolorVector, svgDocument } from "./vector.js";
import { decodeRGBA, loadRGBA, encodeIco, saveImage, type RGBA } from "./imageops.js";
import { encodePng } from "./bgremove.js";
import { alphaBounds, inspectRGBA, smallSizeCheck } from "./imageqa.js";
import { createContactSheet } from "./contactsheet.js";

export const logoKitSchema = z.object({
  brand: brandSchema.optional(),
  markPath: z.string().min(1).optional(),
  wordmarkPath: z.string().min(1).optional(),
  brandName: z.string().trim().min(1).max(100).optional(),
  fontPath: z.string().min(1).optional(),
  outDir: z.string().min(1),
  baseName: safeNameSchema.default("logo"),
  layouts: z.array(z.enum(["mark", "wordmark", "horizontal", "stacked"])).min(1).max(4).optional(),
  variants: z.array(z.enum(["color", "mono", "inverse"])).min(1).max(3).default(["color", "mono", "inverse"]),
  formats: z.array(z.enum(["png", "webp", "svg"])).min(1).max(3).default(["png", "webp", "svg"]),
  padding: z.number().min(0.02).max(0.35).default(0.12),
  social: z.boolean().default(true),
  monochromeMode: z.enum(["preserve", "silhouette"]).default("preserve"),
}).strict();
export type LogoKitInput = z.input<typeof logoKitSchema>;

export interface Artwork {
  body: string;
  width: number;
  height: number;
  vector: boolean;
  source: string;
  sha256: string;
  probe: RGBA;
  notes: string[];
}

export async function loadArtwork(path: string, prefix = "art"): Promise<Artwork> {
  const bytes = await readFile(path);
  const svg = extname(path).toLowerCase() === ".svg" ? parseVectorSvg(bytes.toString("utf8"), prefix, true) : undefined;
  const max = 768;
  const scale = svg ? max / Math.max(svg.width, svg.height) : 1;
  const probe = svg ? await decodeRGBA(await rasterizeSvg(svgDocument(`<g transform="scale(${scale})">${svg.body}</g>`, Math.max(1, Math.round(svg.width * scale)), Math.max(1, Math.round(svg.height * scale))))) : await loadRGBA(path);
  const bounds = alphaBounds(probe);
  if (!bounds) throw new Error(`Artwork is fully transparent: ${path}`);
  const notes: string[] = [];
  if (!inspectRGBA(probe).hasTransparency) notes.push(`${basename(path)} is opaque. Mono variants may include its background; supply a transparent master.`);
  if (!svg && Math.min(bounds.width, bounds.height) < 512) notes.push(`${basename(path)} has less than 512 pixels on its short ink side; larger exports are resampled, not new detail.`);
  const sourceScale = svg ? scale : 1;
  const width = bounds.width / sourceScale, height = bounds.height / sourceScale;
  const rawBody = svg?.body ?? `<image width="${probe.width}" height="${probe.height}" href="data:image/png;base64,${encodePng(probe).toString("base64")}"/>`;
  const body = `<svg width="${width}" height="${height}" viewBox="${bounds.left / sourceScale} ${bounds.top / sourceScale} ${width} ${height}">${rawBody}</svg>`;
  return { body, width, height, vector: svg?.vector ?? false, source: resolve(path), sha256: createHash("sha256").update(bytes).digest("hex"), probe, notes };
}

function textArtwork(font: OutlineFont, text: string, color: string): Artwork {
  const o = outlineText(font, text, color);
  return { ...o, vector: true, source: `font:${font.path}`, sha256: font.sha256, probe: { width: 0, height: 0, data: Buffer.alloc(0) }, notes: [] };
}

export function placeArtwork(a: Pick<Artwork, "body" | "width" | "height">, x: number, y: number, width: number, height: number, center = true): string {
  const s = Math.min(width / a.width, height / a.height);
  const left = x + (center ? (width - a.width * s) / 2 : 0), top = y + (height - a.height * s) / 2;
  return `<g transform="translate(${left} ${top}) scale(${s})">${a.body}</g>`;
}

/** Turn only visible ink into a single color; near-white counters become transparent. */
export function monochrome(img: RGBA, color: string): RGBA {
  const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  const data = Buffer.from(img.data);
  // A completely white source is a legitimate reversed logo; keep its alpha silhouette.
  let hasDarkInk = false;
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 64 && Math.min(data[i]!, data[i + 1]!, data[i + 2]!) < 210) { hasDarkInk = true; break; }
  for (let i = 0; i < data.length; i += 4) {
    const white = Math.min(data[i]!, data[i + 1]!, data[i + 2]!);
    const ink = hasDarkInk ? Math.max(0, Math.min(1, (248 - white) / 28)) : 1;
    data[i + 3] = Math.round(data[i + 3]! * ink);
    data[i] = rgb[0]!; data[i + 1] = rgb[1]!; data[i + 2] = rgb[2]!;
  }
  return { ...img, data };
}

export function silhouetteIoU(a: RGBA, b: RGBA): number {
  if (a.width !== b.width || a.height !== b.height) return 0;
  let intersection = 0, union = 0;
  for (let i = 3; i < a.data.length; i += 4) { const aa = a.data[i]! > 127, bb = b.data[i]! > 127; if (aa || bb) union++; if (aa && bb) intersection++; }
  return union ? intersection / union : 1;
}

type Layout = "mark" | "wordmark" | "horizontal" | "stacked";
function lockup(layout: Layout, mark?: Artwork, word?: Artwork): Artwork {
  if (layout === "mark") { if (!mark) throw new Error("The mark layout needs markPath."); return mark; }
  if (layout === "wordmark") { if (!word) throw new Error("The wordmark layout needs wordmarkPath or brandName and fontPath."); return word; }
  if (!mark || !word) throw new Error(`${layout} needs both a mark and a wordmark.`);
  const markH = 220, markW = markH * mark.width / mark.height, wordH = markH * 0.45, wordW = wordH * word.width / word.height, gap = markH * 0.25;
  const width = layout === "horizontal" ? markW + gap + wordW : Math.max(markW, wordW);
  const height = layout === "horizontal" ? markH : markH + gap + wordH;
  const body = layout === "horizontal"
    ? placeArtwork(mark, 0, 0, markW, markH) + placeArtwork(word, markW + gap, (markH - wordH) / 2, wordW, wordH)
    : placeArtwork(mark, (width - markW) / 2, 0, markW, markH) + placeArtwork(word, (width - wordW) / 2, markH + gap, wordW, wordH);
  return { body, width, height,
    vector: mark.vector && word.vector, source: `${mark.source} + ${word.source}`, sha256: createHash("sha256").update(mark.sha256 + word.sha256).digest("hex"), probe: mark.probe, notes: [] };
}

function lockupSvg(art: Artwork, width: number, height: number, padding: number, title: string, background?: string): string {
  return svgDocument((background ? `<rect width="100%" height="100%" fill="${background}"/>` : "") + placeArtwork(art, width * padding, height * padding, width * (1 - padding * 2), height * (1 - padding * 2)), width, height, title);
}

export async function exportLogoKit(input: LogoKitInput) {
  const o = logoKitSchema.parse(input);
  let brand;
  try { brand = resolveBrand(o.brand, o.outDir); } catch (e) { if (!(e instanceof Error && e.message.startsWith("Provide brand settings")) || o.brand || (!o.markPath && !o.wordmarkPath && !o.brandName)) throw e; }
  const markPath = o.markPath ?? brand?.logos?.mark;
  const wordPath = o.wordmarkPath ?? brand?.logos?.wordmark;
  const name = o.brandName ?? brand?.name;
  const fontPath = o.fontPath ?? brand?.fonts?.heading.path;
  const ink = brand ? brandColor(brand, "ink", "#171717") : "#171717";
  const paper = brand ? brandColor(brand, "paper", "#F7F5EF") : "#F7F5EF";
  const primary = brand ? brandColor(brand, "primary", ink) : ink;
  const mark = markPath ? await loadArtwork(markPath, "mark") : undefined;
  const monoDark = brand?.logos?.monoDark ? await loadArtwork(brand.logos.monoDark, "mono-dark") : undefined;
  const monoLight = brand?.logos?.monoLight ? await loadArtwork(brand.logos.monoLight, "mono-light") : undefined;
  const font = !wordPath && o.brandName && fontPath ? await loadOutlineFont(fontPath) : undefined;
  const word = wordPath ? await loadArtwork(wordPath, "word") : font && o.brandName ? textArtwork(font, o.brandName, primary) : undefined;
  if (!mark && !word) throw new Error("Provide an approved mark/wordmark, or a brandName and a static fontPath.");
  if (o.brandName && !word && !wordPath && !fontPath) throw new Error("A brand name needs fontPath or approved wordmarkPath; fonts are never substituted.");
  const layouts = [...new Set(o.layouts ?? (mark && word ? ["mark", "wordmark", "horizontal", "stacked"] : mark ? ["mark"] : ["wordmark"]))] as Layout[];
  const outDir = resolve(o.outDir), notes = [...(mark?.notes ?? []), ...(word?.notes ?? [])];
  const files: Array<{ path: string; format: string; width?: number; height?: number; vector: boolean; layout?: string; variant?: string }> = [];
  const iconChecks: ReturnType<typeof smallSizeCheck>[] = [];
  const sheetPaths: string[] = [], sheetLabels: string[] = [];
  const checks: Array<{ layout: string; variant: string; vector: boolean; silhouetteIoU?: number; qa: ReturnType<typeof inspectRGBA> }> = [];
  const emit = async (rel: string, data: Buffer | string, info: Omit<typeof files[number], "path">) => {
    const path = join(outDir, rel);
    if ([mark?.source, word?.source].includes(path)) throw new Error("Output would overwrite a source artwork.");
    await mkdir(join(outDir, rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""), { recursive: true });
    await writeFile(path, data); files.push({ path, ...info }); return path;
  };
  for (const layout of layouts) {
    const art = lockup(layout, mark, word);
    const width = layout === "horizontal" || layout === "wordmark" ? 1600 : 1024;
    const height = layout === "horizontal" ? 480 : layout === "wordmark" ? Math.max(240, Math.min(1024, Math.round(width * art.height / art.width * 1.4))) : 1024;
    for (const variant of [...new Set(o.variants)]) {
      const color = variant === "inverse" ? paper : ink;
      const supplied = variant === "mono" ? monoDark : variant === "inverse" ? monoLight : undefined;
      if (variant !== "color" && layout !== "mark" && word && o.monochromeMode === "preserve" && await hasMultipleInkColors(word)) {
        notes.push(`${layout}/${variant} omitted: the supplied wordmark has multiple significant colors. Supply a single-ink wordmark for mono lockups, or explicitly opt into silhouette conversion.`);
        continue;
      }
      if (variant !== "color" && !supplied && o.monochromeMode === "preserve" && await hasMultipleInkColors(art)) {
        notes.push(`${layout}/${variant} omitted: a multicolor master needs an approved ${variant === "mono" ? "monoDark" : "monoLight"} source. Explicit monochromeMode: silhouette permits a derived silhouette that can lose internal details.`);
        continue;
      }
      const variantWord = supplied && word ? { ...word, body: word.vector ? recolorVector(svgDocument(word.body, word.width, word.height), color) : word.body } : word;
      const variantArt = supplied && layout !== "wordmark" ? lockup(layout, supplied, variantWord) : art;
      const suppliedExact = Boolean(supplied && layout !== "wordmark" && (!word || word.vector || layout === "mark"));
      const originalSvg = lockupSvg(variantArt, width, height, 0.08, `${name ?? "Logo"} ${layout}`);
      const original = await decodeRGBA(await rasterizeSvg(originalSvg));
      const raster = variant === "color" || suppliedExact ? original : monochrome(original, color);
      let vector = variantArt.vector, svg = originalSvg, iou: number | undefined;
      if (variant !== "color" && vector && !suppliedExact) {
        svg = recolorVector(originalSvg, color);
        iou = silhouetteIoU(raster, await decodeRGBA(await rasterizeSvg(svg)));
        vector = iou >= 0.99;
        if (!vector) notes.push(`${layout}/${variant}: vector recoloring changed counters or transparency (IoU ${iou.toFixed(4)}); exported raster only. Supply a dedicated mono master for vector delivery.`);
      }
      const stem = `logo/${o.baseName}-${layout}-${variant}`;
      const png = encodePng(raster);
      // Review PNGs remain available even for an SVG-only requested delivery.
      const pngPath = await emit(`${stem}.png`, png, { format: "png", width, height, vector: false, layout, variant });
      sheetPaths.push(pngPath); sheetLabels.push(`${layout} / ${variant}${font && layout !== "mark" ? " / typeset name" : vector ? " / vector" : " / raster"}`);
      if (o.formats.includes("svg") && vector) await emit(`${stem}.svg`, svg, { format: "svg", width, height, vector: true, layout, variant });
      if (o.formats.includes("webp")) {
        const path = join(outDir, `${stem}.webp`); await saveImage(raster, path, "webp", 100);
        files.push({ path, format: "webp", width, height, vector: false, layout, variant });
      }
      if (!variantArt.vector && o.formats.includes("svg")) notes.push(`${layout}: source contains raster artwork; no SVG logo emitted.`);
      checks.push({ layout, variant, vector, silhouetteIoU: iou, qa: inspectRGBA(raster) });
    }
  }
  if (mark) {
    const iconBuffers = new Map<number, RGBA>();
    for (const size of [16, 24, 32, 48, 192, 512]) {
      const png = await rasterizeSvg(lockupSvg(mark, size, size, o.padding, "Brand icon"));
      iconBuffers.set(size, await decodeRGBA(png));
      if (size === 16 || size === 32) iconChecks.push(smallSizeCheck(iconBuffers.get(size)!, size));
      await emit(`web/icon-${size}.png`, png, { format: "png", width: size, height: size, vector: false });
    }
    await emit("web/favicon.ico", encodeIco([16, 32, 48].map(s => iconBuffers.get(s)!)), { format: "ico", vector: false });
    if (mark.vector) await emit("web/favicon.svg", lockupSvg(mark, 64, 64, o.padding, "Brand favicon"), { format: "svg", width: 64, height: 64, vector: true });
    await emit("web/apple-touch-icon.png", await rasterizeSvg(lockupSvg(mark, 180, 180, 0.16, "Apple touch icon", paper)), { format: "png", width: 180, height: 180, vector: false });
    // A bbox's diagonal inside the central 80% circle survives every mask, including circles.
    const safeScale = 0.78 * 512 / Math.hypot(mark.width, mark.height);
    const maskBody = `<rect width="512" height="512" fill="${paper}"/>` + placeArtwork(mark, (512 - mark.width * safeScale) / 2, (512 - mark.height * safeScale) / 2, mark.width * safeScale, mark.height * safeScale);
    await emit("web/icon-maskable-512.png", await rasterizeSvg(svgDocument(maskBody, 512, 512)), { format: "png", width: 512, height: 512, vector: false });
    await emit("web/site.webmanifest", JSON.stringify({ name: name ?? "Brand", short_name: name ?? "Brand", display: "standalone", theme_color: primary, background_color: paper,
      icons: [{ src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" }, { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }, { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }] }, null, 2), { format: "json", vector: false });
    await emit("web/head.html", `${mark.vector ? '<link rel="icon" type="image/svg+xml" href="./favicon.svg">\n' : ''}<link rel="icon" href="./favicon.ico" sizes="any">\n<link rel="apple-touch-icon" href="./apple-touch-icon.png">\n<link rel="manifest" href="./site.webmanifest">\n<meta name="theme-color" content="${primary}">\n`, { format: "html", vector: false });
    if (o.social) await emit("social/avatar-400.png", await rasterizeSvg(svgDocument(`<rect width="400" height="400" fill="${paper}"/>` + placeArtwork(mark, 90, 90, 220, 220), 400, 400)), { format: "png", width: 400, height: 400, vector: false });
    // Actual-size pixels inside a 512px proof strip, without enlargement.
    const strip = `<rect width="512" height="96" fill="${paper}"/>` + [16, 24, 32, 48].map((s, i) => `<image x="${24 + i * 120}" y="16" width="${s}" height="${s}" href="data:image/png;base64,${encodePng(iconBuffers.get(s)!).toString("base64")}"/><text x="${24 + i * 120}" y="85" font-family="sans-serif" font-size="12" fill="${ink}">${s} px</text>`).join("");
    await emit("web/small-size-proof.png", await rasterizeSvg(svgDocument(strip, 512, 96)), { format: "png", width: 512, height: 96, vector: false });
  }
  if (o.social) {
    const socialArt = mark && word ? lockup("horizontal", mark, word) : mark ?? word!;
    await emit("social/og-1200x630.png", await rasterizeSvg(lockupSvg(socialArt, 1200, 630, 0.14, name ?? "Brand", paper)), { format: "png", width: 1200, height: 630, vector: false });
  }
  const sheet = await createContactSheet(sheetPaths, join(outDir, "sheet.png"), sheetLabels);
  const manifest = join(outDir, "kit.json");
  const result = { deliverable: "kit" as const, outDir, manifest, sheet, files, checks, iconChecks, notes: [...new Set(notes)],
    sources: [mark, word, monoDark, monoLight].filter((a): a is Artwork => Boolean(a)).map(a => ({ path: a.source, sha256: a.sha256, vector: a.vector })),
    fonts: font ? [{ path: font.path, family: font.family, subfamily: font.subfamily, weight: font.weight, style: font.style, sha256: font.sha256 }] : [], palette: { ink, paper, primary },
    wordmarkOrigin: wordPath ? "supplied artwork" : font ? "typeset name, not approved artwork" : "none",
    monochromeMode: o.monochromeMode };
  await writeFile(manifest, JSON.stringify(result, null, 2));
  return result;
}

/** Count significant distinct ink colors, ignoring edge antialiasing and near-paper counters. */
export async function hasMultipleInkColors(art: Artwork): Promise<boolean> {
  const img = await decodeRGBA(await rasterizeSvg(lockupSvg(art, 192, 192, 0, "Color analysis")));
  const bins = new Map<string, { rgb: number[]; count: number }>();
  let opaque = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3]! < 240) continue;
    const rgb = [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!];
    if (Math.min(...rgb) > 230) continue;
    opaque++;
    const key = rgb.map(c => Math.round(c / 24)).join(",");
    const bin = bins.get(key) ?? { rgb, count: 0 }; bin.count++; bins.set(key, bin);
  }
  const significant = [...bins.values()].filter(b => b.count > opaque * 0.015).sort((a, b) => b.count - a.count);
  const primary = significant[0];
  return Boolean(primary && significant.some(b => Math.hypot(...b.rgb.map((c, i) => c - primary.rgb[i]!)) > 65));
}
