#!/usr/bin/env node
// Quality-regression bench: generate a fixed grid of representative presets and montage them into
// ONE contact sheet you can eyeball after any compiler/preset change. Costs a handful of
// subscription generations — run deliberately, not in CI.
//
//   npm run build && node scripts/bench.mjs [--quality low|medium|high] [--out bench/] [--presets a,b,c]
//
// Compare bench/contact-sheet.png against the previous run (kept alongside, timestamped).

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateImage } from "../dist/generate.js";
import { listPresets } from "../dist/presets/registry.js";
import { loadRGBA, fitTo } from "../dist/imageops.js";
import { encodePng } from "../dist/bgremove.js";

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const QUALITY = flag("quality", "low"); // low keeps a full sweep cheap on quota
const OUT_DIR = resolve(process.cwd(), flag("out", "bench"));
const CELL = 512;
const COLS = 3;

// One representative subject per category — fixed so runs stay comparable over time.
const CATEGORY_SUBJECTS = {
  photography: "a matte black ceramic coffee mug with a thin gold rim",
  illustration: "a lighthouse on a rocky coast at dusk",
  design: "a minimalist mountain-peak logo mark",
  render3d: "a friendly rounded robot assistant",
  specialized: "a vintage café racer motorcycle",
  webdev: "an analytics dashboard concept",
  social: "a single brass key resting on folded paper",
};

const explicit = flag("presets", "");
const picks = explicit
  ? explicit.split(",").map((s) => s.trim()).filter(Boolean).map((id) => ({ id, subject: flag("subject", "a matte black ceramic coffee mug") }))
  : Object.entries(CATEGORY_SUBJECTS).map(([cat, subject]) => {
      const first = listPresets(cat)[0];
      return first ? { id: first.id, subject } : null;
    }).filter(Boolean);

await mkdir(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const cells = [];

console.error(`bench: ${picks.length} presets at quality=${QUALITY} → ${OUT_DIR}`);
for (const [i, p] of picks.entries()) {
  const path = join(OUT_DIR, `${p.id}.png`);
  console.error(`  [${i + 1}/${picks.length}] ${p.id} — "${p.subject}"`);
  try {
    // Sequential on purpose: parallel bench runs chew through the shared ChatGPT quota and 429.
    const out = await generateImage({
      subject: p.subject,
      preset: p.id,
      quality: QUALITY,
      size: "1024x1024",
      format: "png",
      outputPath: path,
      proof: false, // bench measures the raw preset, not the proof-loop
    });
    cells.push({ preset: p.id, subject: p.subject, path: out.path, ok: true });
  } catch (e) {
    console.error(`    ✗ ${e instanceof Error ? e.message : e}`);
    cells.push({ preset: p.id, subject: p.subject, path: null, ok: false, error: String(e?.message ?? e) });
  }
}

// Montage: COLS × rows grid of CELL px squares (failed cells stay dark).
const rows = Math.ceil(cells.length / COLS);
const sheet = { width: COLS * CELL, height: rows * CELL, data: Buffer.alloc(COLS * CELL * rows * CELL * 4) };
for (let i = 0; i < sheet.data.length; i += 4) sheet.data.set([24, 24, 24, 255], i);

function blit(dst, src, ox, oy) {
  for (let y = 0; y < src.height; y++) {
    const row = src.data.subarray(y * src.width * 4, (y + 1) * src.width * 4);
    row.copy(dst.data, ((oy + y) * dst.width + ox) * 4);
  }
}

for (const [i, cell] of cells.entries()) {
  if (!cell.ok) continue;
  const img = fitTo(await loadRGBA(cell.path), CELL, CELL, "cover");
  blit(sheet, img, (i % COLS) * CELL, Math.floor(i / COLS) * CELL);
  cell.row = Math.floor(i / COLS);
  cell.col = i % COLS;
}

const sheetPath = join(OUT_DIR, `contact-sheet-${stamp}.png`);
await writeFile(sheetPath, encodePng(sheet));
await writeFile(join(OUT_DIR, `contact-sheet-${stamp}.json`), JSON.stringify({ quality: QUALITY, cell: CELL, cols: COLS, cells }, null, 2));
console.error(`✓ contact sheet → ${sheetPath}`);
console.log(sheetPath);
