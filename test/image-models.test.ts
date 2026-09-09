import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IMAGE_MODELS, resolveImageModel, validateImageQuality } from "../dist/models.js";
import { buildSubscriptionBody } from "../dist/providers/subscription.js";
import { ApiKeyProvider } from "../dist/providers/apikey.js";
import { generateImage, editImage, upscaleImage } from "../dist/generate.js";
import { encodePng } from "../dist/bgremove.js";

const png = encodePng({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
const base = { prompt: "a paper bird", size: "1024x1024" as const, quality: "low" as const, format: "png" as const };

test("renderer choice preserves per-call precedence, aliases, snapshots and backend isolation", () => {
  const env = { GPT_IMAGE_API_MODEL: IMAGE_MODELS.sunburst };
  assert.equal(resolveImageModel("flare", "apikey", env), IMAGE_MODELS.flare);
  assert.equal(resolveImageModel(undefined, "apikey", { GPT_IMAGE_API_MODEL: " flare " }), IMAGE_MODELS.flare);
  assert.equal(resolveImageModel("auto", "apikey", { GPT_IMAGE_API_MODEL: "old-model" }), IMAGE_MODELS.sunburst);
  assert.equal(resolveImageModel("gpt-image-2.5-flare-2026-09-08", "apikey", env), "gpt-image-2.5-flare-2026-09-08");
  assert.equal(resolveImageModel("toString", "apikey", env), "toString", "unknown IDs cannot resolve inherited object properties");
  assert.equal(resolveImageModel(undefined, "subscription", env), undefined);
  assert.equal(resolveImageModel("auto", "subscription", env), undefined);
  for (const model of Object.values(IMAGE_MODELS)) {
    assert.throws(() => buildSubscriptionBody({ ...base, imageModel: model }), /does not reliably enforce/);
  }
  assert.equal(buildSubscriptionBody(base).tools[0].model, undefined);
});

test("new quality levels validate without silently downgrading older or unknown subscription renderers", () => {
  for (const model of Object.values(IMAGE_MODELS)) {
    for (const quality of ["auto", "low", "medium", "high", "xhigh", "max"]) validateImageQuality(quality, model);
  }
  for (const model of ["gpt-image-1", "gpt-image-1.5", "gpt-image-1-mini", "gpt-image-2", "gpt-image-2-2026-04-21", undefined]) {
    assert.throws(() => validateImageQuality("max", model), /requires/);
  }
  assert.throws(() => validateImageQuality("typo", IMAGE_MODELS.flare), /Invalid image quality/);
});

for (const [choice, model] of Object.entries(IMAGE_MODELS)) {
  test(`${choice}: API generation and masked edits select the renderer and retain quality, format and references`, async (t) => {
    const oldKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "synthetic-test-key";
    t.after(() => { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; });
    const requests: RequestInit[] = [];
    t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
      requests.push(init);
      return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
    });
    const provider = new ApiKeyProvider();
    await provider.generate({ ...base, imageModel: choice, quality: "xhigh", background: "transparent" });
    const body = JSON.parse(requests[0].body as string);
    assert.equal(body.model, model);
    assert.equal(body.quality, "xhigh");
    assert.equal(body.background, "transparent");
    const image = { bytes: png, mime: "image/png" };
    await provider.generate({ ...base, imageModel: choice, quality: "max", inputImages: [image, image], maskImage: image });
    const form = requests[1].body as FormData;
    assert.equal(form.get("model"), model);
    assert.equal(form.get("quality"), "max");
    assert.equal(form.get("output_format"), "png");
    assert.equal(form.getAll("image[]").length, 2);
    assert.ok(form.get("mask") instanceof Blob);
  });
}

test("model access errors do not retry with another model or backend", async (t) => {
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "synthetic-test-key";
  t.after(() => { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("model not available", { status: 400 }); });
  await assert.rejects(new ApiKeyProvider().generate({ ...base, imageModel: "flare" }), /HTTP 400/);
  assert.equal(calls, 1);
});

test("profiles, explicit overrides, sidecar replay, edits, upscales and series retain the requested renderer", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gptimg-models-"));
  const old = { key: process.env.OPENAI_API_KEY, profile: process.env.GPT_IMAGE_PROFILE, model: process.env.GPT_IMAGE_API_MODEL };
  process.env.OPENAI_API_KEY = "synthetic-test-key";
  process.env.GPT_IMAGE_API_MODEL = "gpt-image-2";
  process.env.GPT_IMAGE_PROFILE = join(dir, ".gptimage.json");
  await writeFile(process.env.GPT_IMAGE_PROFILE, JSON.stringify({ backend: "apikey", imageModel: "flare", style: { color: "profile colour must not restyle edits" } }));
  t.after(async () => {
    for (const [key, value] of Object.entries({ OPENAI_API_KEY: old.key, GPT_IMAGE_PROFILE: old.profile, GPT_IMAGE_API_MODEL: old.model })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });
  const models: string[] = [];
  const prompts: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(init.body as string);
    models.push(body.model); prompts.push(body.prompt);
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
  });
  const path = join(dir, "image.png");
  const first = await generateImage({ prompt: "a bird", outputPath: path, proof: false });
  assert.equal(first.imageModel, IMAGE_MODELS.flare);
  assert.equal(first.reportedImageModel, undefined, "do not invent provider confirmation");
  assert.equal(JSON.parse(await readFile(`${path}.json`, "utf8")).imageModel, IMAGE_MODELS.flare);
  await generateImage({ prompt: "a bird", imageModel: "sunburst", outputPath: join(dir, "override.png"), proof: false });
  await generateImage({ fromImage: path, outputPath: join(dir, "replay.png"), proof: false });
  await editImage({ imagePaths: [path], instruction: "make it blue", outputPath: join(dir, "edit.png"), proof: false });
  assert.ok(!prompts.at(-1)!.includes("profile colour"));
  await upscaleImage({ imagePath: path, imageModel: "sunburst", outputPath: join(dir, "upscale.png") });
  await generateImage({ prompt: "a bird", imageModel: "sunburst", series: 2, outputPath: join(dir, "series.png"), proof: false, autoPalette: false });
  assert.deepEqual(models, [IMAGE_MODELS.flare, IMAGE_MODELS.sunburst, IMAGE_MODELS.flare, IMAGE_MODELS.flare, IMAGE_MODELS.sunburst, IMAGE_MODELS.sunburst, IMAGE_MODELS.sunburst]);
});

test("CLI model choices reach real provider payloads through generation, edits and web source generation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gptimg-cli-models-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requestPath = join(dir, "request.json");
  const preload = join(dir, "mock.mjs");
  await writeFile(preload, `import { writeFile } from 'node:fs/promises';\nglobalThis.fetch = async (url, init) => { const body = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(init.body); await writeFile(${JSON.stringify(requestPath)}, JSON.stringify({url, model: body.model, quality: body.quality})); return new Response(JSON.stringify({data:[{b64_json:${JSON.stringify(png.toString("base64"))}}]})); };`);
  const run = promisify(execFile);
  const output = join(dir, "bird.png");
  const env = { ...process.env, OPENAI_API_KEY: "synthetic-test-key", GPT_IMAGE_PROFILE: join(dir, "absent.json"), GPT_IMAGE_API_MODEL: "gpt-image-2", GPT_IMAGE_NO_SIDECAR: "0" };
  for (const [args, model, quality] of [
    [["a bird", "--image-model", "flare", "--quality", "xhigh", "-o", output], IMAGE_MODELS.flare, "xhigh"],
    [["--edit", output, "--instruction", "make it blue", "--image-model", "sunburst", "--quality", "max", "-o", join(dir, "edit.png")], IMAGE_MODELS.sunburst, "max"],
    [["--web", "favicon", "--subject", "a bird", "--image-model", "flare", "--quality", "low", "-o", join(dir, "web")], IMAGE_MODELS.flare, "low"],
  ] as const) {
    await run(process.execPath, ["--import", pathToFileURL(preload).href, resolve("dist/cli.js"), "--backend", "apikey", "--no-proof", ...args], { env: { ...env, GPT_IMAGE_OUTPUT_DIR: dir }, timeout: 30000 });
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    assert.equal(request.model, model);
    assert.equal(request.quality, quality);
  }
});
