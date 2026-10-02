import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateImage, previewImageRequest, editImage } from "../dist/generate.js";
import { encodePng, decodePng } from "../dist/bgremove.js";
import { briefClauses } from "../dist/brief.js";
import { ApiKeyProvider } from "../dist/providers/apikey.js";

const pixel = encodePng({ width: 2, height: 2, data: Buffer.from([200, 30, 10, 255, 0, 0, 0, 0, 200, 30, 10, 255, 0, 0, 0, 0]) });

test("preview is quota-free, matches the real compiled request, labels sent roles, and keeps declared colors", async t => {
  const dir = await mkdtemp(join(tmpdir(), "brief-preview-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "reference.png"); await writeFile(path, pixel);
  const opts = { subject: "a folded sculpture", backend: "apikey", proof: false, outputPath: join(dir, "result.png"),
    brief: { purpose: "website hero", audience: "architects", preserve: ["subject silhouette"], palette: ["#183C2F"] },
    references: [{ path, role: "subject" as const }, { path, role: "palette" as const }, { path, role: "photography" as const }, { path, role: "logo" as const }] };
  let sent: any;
  t.mock.method(globalThis, "fetch", () => { throw new Error("Preview must not use network"); });
  t.mock.method(ApiKeyProvider.prototype, "generate", async input => { sent = input; return { bytes: pixel, format: "png" }; });
  const p = await previewImageRequest(opts);
  assert.equal(sent, undefined); assert.equal(p.inputImages.filter(r => r.sent).length, 2);
  assert.deepEqual(p.palette, { source: "declared", colors: ["#183C2F"] });
  const out = await generateImage(opts);
  assert.equal(sent.prompt, p.compiledPrompt); assert.equal(sent.inputImages.length, 2);
  assert.match(sent.prompt, /Reference image 2: photography/);
  const sidecar = JSON.parse(await readFile(`${out.path}.json`, "utf8"));
  assert.equal(sidecar.brief.audience, "architects"); assert.equal(sidecar.references[1].role, "palette");
  assert.equal(sidecar.qa.width, 2); assert.equal(sidecar.qa.hasTransparency, true);
});

test("missing explicit refs, overfull requests and invalid brief fail before providers", async t => {
  const dir = await mkdtemp(join(tmpdir(), "brief-guards-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "reference.png"); await writeFile(path, pixel);
  t.mock.method(globalThis, "fetch", () => { throw new Error("Must not call provider"); });
  await assert.rejects(previewImageRequest({ subject: "x", references: [{ path: join(dir, "missing.png"), role: "subject" }] }), /not found/);
  await assert.rejects(previewImageRequest({ subject: "x", references: Array.from({ length: 17 }, () => ({ path, role: "style" as const })) }), /At most 16/);
  await assert.rejects(previewImageRequest({ subject: "x", count: 2, series: 2 }), /not both/);
  assert.throws(() => briefClauses({ palette: ["blue"] }), /palette/);
});

test("masked edits preserve outside pixels, include brief constraints, and record the preservation", async t => {
  const dir = await mkdtemp(join(tmpdir(), "edit-mask-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "source.png"), mask = join(dir, "mask.png");
  await writeFile(path, pixel);
  await writeFile(mask, encodePng({ width: 2, height: 2, data: Buffer.from([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0]) }));
  const replacement = encodePng({ width: 4, height: 4, data: Buffer.alloc(4 * 4 * 4, 255) });
  let sent: any;
  t.mock.method(ApiKeyProvider.prototype, "generate", async input => { sent = input; return { bytes: replacement, format: "png" }; });
  const out = await editImage({ imagePaths: [path], maskPath: mask, instruction: "make the selected region white", brief: { preserve: ["original labels"] }, backend: "apikey", proof: false, outputPath: join(dir, "edit.webp"), format: "webp" });
  assert.match(sent.prompt, /original labels/); assert.match(out.path, /\.png$/);
  const result = decodePng(await readFile(out.path)), src = decodePng(pixel);
  assert.equal(result.width, 2); assert.equal(result.height, 2);
  for (const i of [0, 8]) assert.deepEqual([...result.data.subarray(i, i + 4)], [...src.data.subarray(i, i + 4)]);
  assert.equal(out.qa?.preservedOutsideMask, true);
  assert.equal(JSON.parse(await readFile(`${out.path}.json`, "utf8")).preserveUnmasked, true);
});

test("declared brand colors replace profile color hints, while explicit call colors still win", async t => {
  const dir = await mkdtemp(join(tmpdir(), "brand-profile-colors-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const old = process.env.GPT_IMAGE_PROFILE; process.env.GPT_IMAGE_PROFILE = join(dir, ".gptimage.json");
  t.after(() => { if (old === undefined) delete process.env.GPT_IMAGE_PROFILE; else process.env.GPT_IMAGE_PROFILE = old; });
  await writeFile(process.env.GPT_IMAGE_PROFILE, JSON.stringify({ style: { color: "legacy purple" }, brand: { name: "Studio", colors: [{ name: "Ink", role: "ink", hex: "#123456" }] } }));
  const normal = await previewImageRequest({ subject: "paper", backend: "subscription" });
  assert.match(normal.compiledPrompt, /#123456 as ink/); assert.doesNotMatch(normal.compiledPrompt, /legacy purple/);
  const override = await previewImageRequest({ subject: "paper", style: { color: "explicit blue" }, backend: "subscription" });
  assert.match(override.compiledPrompt, /Explicit blue/); assert.equal(override.palette.source, "style");
});
