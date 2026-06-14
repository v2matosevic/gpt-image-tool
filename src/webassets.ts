// Web-asset recipes: turn one source image into the exact production deliverables a site needs —
// favicons, OG/social cards, responsive hero widths, app-icon sets — correctly sized and cropped.
// All local (no model), built on the dependency-free raster ops.

import { dirname, join } from "node:path";
import { canEncode, encodeIco, fitTo, loadRGBA, resizeRGBA, saveImage, type OutFormat, type RGBA } from "./imageops.js";
import { writeFile, mkdir } from "node:fs/promises";

export type WebAssetKind = "favicon" | "appicon" | "og" | "hero";

export interface ExportOptions {
  sourcePath: string;
  kind: WebAssetKind;
  outDir?: string;
  baseName?: string;
  /** Preferred output format for og/hero (favicons/app-icons are always png for transparency). */
  format?: OutFormat;
}

export interface ExportedFile {
  path: string;
  width: number;
  height: number;
  format: string;
}

export interface ExportResult {
  kind: WebAssetKind;
  source: string;
  outDir: string;
  files: ExportedFile[];
  notes: string[];
}

// Square icon sizes per kind.
const FAVICON_SIZES = [16, 32, 48, 180, 512];
const FAVICON_ICO = [16, 32, 48];
const APPICON_SIZES = [48, 72, 96, 120, 128, 144, 152, 167, 180, 192, 256, 512, 1024];
const OG_DIMS: [number, number][] = [
  [1200, 630], // Open Graph / Facebook / LinkedIn
  [1080, 1080], // square (Instagram-style)
  [1600, 900], // 16:9 large
];
const HERO_WIDTHS = [640, 828, 1200, 1920];

export async function exportWebAssets(opts: ExportOptions): Promise<ExportResult> {
  const src = await loadRGBA(opts.sourcePath);
  const outDir = opts.outDir ?? join(dirname(opts.sourcePath), "web");
  const base = opts.baseName ?? opts.kind;
  await mkdir(outDir, { recursive: true });
  const files: ExportedFile[] = [];
  const notes: string[] = [];

  // Resolve the effective output format, downgrading to png if the encoder isn't available.
  async function fmtFor(preferred: OutFormat): Promise<OutFormat> {
    if (await canEncode(preferred)) return preferred;
    notes.push(`${preferred} unavailable (install \`sharp\`) — wrote png instead.`);
    return "png";
  }

  async function emit(img: RGBA, name: string, format: OutFormat): Promise<void> {
    const ext = format === "jpeg" ? "jpg" : format;
    const path = join(outDir, `${name}.${ext}`);
    await saveImage(img, path, format);
    files.push({ path, width: img.width, height: img.height, format });
  }

  if (opts.kind === "favicon" || opts.kind === "appicon") {
    const sizes = opts.kind === "favicon" ? FAVICON_SIZES : APPICON_SIZES;
    const squares = new Map<number, RGBA>();
    for (const s of sizes) {
      const img = fitTo(src, s, s, "cover");
      squares.set(s, img);
      await emit(img, `${base}-${s}`, "png"); // icons stay png for transparency
    }
    if (opts.kind === "favicon") {
      const ico = encodeIco(FAVICON_ICO.map((s) => squares.get(s)!).filter(Boolean));
      const icoPath = join(outDir, "favicon.ico");
      await writeFile(icoPath, ico);
      files.push({ path: icoPath, width: 48, height: 48, format: "ico" });
    }
  } else if (opts.kind === "og") {
    const format = await fmtFor(opts.format ?? "jpeg");
    for (const [w, h] of OG_DIMS) {
      await emit(fitTo(src, w, h, "cover"), `${base}-${w}x${h}`, format);
    }
  } else {
    // hero: responsive widths, keep source aspect, never upscale past the source.
    const format = await fmtFor(opts.format ?? "webp");
    const widths = HERO_WIDTHS.filter((w) => w <= src.width);
    if (!widths.length) widths.push(src.width);
    else if (!widths.includes(src.width) && src.width <= 2048) widths.push(src.width);
    const aspect = src.height / src.width;
    for (const w of widths.sort((a, b) => a - b)) {
      const h = Math.round(w * aspect);
      await emit(resizeRGBA(src, w, h), `${base}-${w}w`, format);
    }
  }

  return { kind: opts.kind, source: opts.sourcePath, outDir, files, notes };
}
