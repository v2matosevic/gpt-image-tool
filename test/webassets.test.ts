import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportWebAssets } from "../dist/webassets.js";
import { encodePng } from "../dist/bgremove.js";
import { imageSize } from "../dist/imageinfo.js";

function writeSource(dir: string, w: number, h: number): string {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([(i % 255), 120, 200, 255], i * 4); // some gradient
  const path = join(dir, "source.png");
  writeFileSync(path, encodePng({ width: w, height: h, data }));
  return path;
}

function dims(p: string) {
  return imageSize(readFileSync(p));
}

test("favicon export produces all sizes + favicon.ico", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-fav-"));
  try {
    const src = writeSource(dir, 512, 512);
    const res = await exportWebAssets({ sourcePath: src, kind: "favicon", outDir: join(dir, "out") });
    const sizes = res.files.filter((f) => f.format === "png").map((f) => f.width).sort((a, b) => a - b);
    assert.deepEqual(sizes, [16, 32, 48, 180, 512]);
    for (const f of res.files.filter((f) => f.format === "png")) assert.deepEqual(dims(f.path), { width: f.width, height: f.height });
    const ico = res.files.find((f) => f.format === "ico");
    assert.ok(ico && existsSync(ico.path), "favicon.ico written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("og export crops to the exact social dimensions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-og-"));
  try {
    const src = writeSource(dir, 1536, 1024);
    const res = await exportWebAssets({ sourcePath: src, kind: "og", outDir: join(dir, "out"), format: "png" });
    const set = res.files.map((f) => `${f.width}x${f.height}`).sort();
    assert.deepEqual(set, ["1080x1080", "1200x630", "1600x900"].sort());
    for (const f of res.files) assert.deepEqual(dims(f.path), { width: f.width, height: f.height });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hero export emits responsive widths without upscaling past the source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-hero-"));
  try {
    const src = writeSource(dir, 1536, 864); // 16:9-ish
    const res = await exportWebAssets({ sourcePath: src, kind: "hero", outDir: join(dir, "out"), format: "png" });
    const widths = res.files.map((f) => f.width).sort((a, b) => a - b);
    // HERO_WIDTHS ≤ 1536 → [640, 828, 1200] + source width 1536
    assert.deepEqual(widths, [640, 828, 1200, 1536]);
    for (const f of res.files) {
      const d = dims(f.path)!;
      assert.equal(d.width, f.width);
      assert.equal(Math.round((d.width * 864) / 1536), d.height); // aspect preserved
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
