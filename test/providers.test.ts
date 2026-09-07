import { test } from "node:test";
import assert from "node:assert/strict";
import { configuredModels } from "../dist/models.js";
import { buildSubscriptionBody } from "../dist/providers/subscription.js";
import { ApiKeyProvider } from "../dist/providers/apikey.js";
import type { GenerateInput } from "../src/providers/types.ts";

const input: GenerateInput = { prompt: "a paper bird", size: "1024x1024", quality: "low", format: "webp" };

test("model defaults distinguish the subscription director from the API renderer and preserve overrides", () => {
  assert.deepEqual(configuredModels({}), { routing: "gpt-6-astra", image: "gpt-image-2", proof: "gpt-6-astra" });
  assert.deepEqual(configuredModels({ GPT_IMAGE_MODEL: " gpt-5.6-terra ", GPT_IMAGE_API_MODEL: " gpt-image-1.5 ", GPT_IMAGE_PROOF_MODEL: " custom-proof " }),
    { routing: "gpt-5.6-terra", image: "gpt-image-1.5", proof: "custom-proof" });
  assert.equal(configuredModels({ GPT_IMAGE_MODEL: "  " }).routing, "gpt-6-astra");
});

test("subscription forces image generation and keeps references, mask, and explicit model", () => {
  const ref = { bytes: Buffer.from("reference"), mime: "image/png" };
  const body = buildSubscriptionBody({ ...input, inputImages: [ref], maskImage: ref }, "gpt-6-astra");
  assert.equal(body.model, "gpt-6-astra");
  assert.deepEqual(body.tool_choice, { type: "image_generation" });
  assert.equal(body.tools[0].output_format, "webp");
  assert.equal(body.tools[0].size, "1024x1024");
  assert.equal(body.tools[0].quality, "low");
  assert.deepEqual(body.tools[0].input_image_mask, { image_url: "data:image/png;base64,cmVmZXJlbmNl" });
  assert.equal(body.input[0].content[1].image_url, "data:image/png;base64,cmVmZXJlbmNl");
  assert.equal(body.store, false);
});

test("API create and edit send GPT Image 2, selected format, transparency, references and mask", async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousModel = process.env.GPT_IMAGE_API_MODEL;
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.GPT_IMAGE_API_MODEL;
    else process.env.GPT_IMAGE_API_MODEL = previousModel;
  });
  process.env.OPENAI_API_KEY = "test-key";
  process.env.GPT_IMAGE_API_MODEL = "gpt-image-2";
  const requests: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("synthetic-image").toString("base64") }] }));
  });
  const provider = new ApiKeyProvider();
  await provider.generate({ ...input, background: "transparent" });
  const create = JSON.parse(requests[0].init.body as string);
  assert.equal(requests[0].url, "https://api.openai.com/v1/images/generations");
  assert.equal(create.model, "gpt-image-2");
  assert.equal(create.output_format, "webp");
  assert.equal(create.background, "transparent");
  const ref = { bytes: Buffer.from("reference"), mime: "image/png" };
  await provider.generate({ ...input, background: "transparent", inputImages: [ref, ref], maskImage: ref });
  assert.equal(requests[1].url, "https://api.openai.com/v1/images/edits");
  const edit = requests[1].init.body as FormData;
  assert.equal(edit.get("model"), "gpt-image-2");
  assert.equal(edit.get("output_format"), "webp");
  assert.equal(edit.get("background"), "transparent");
  assert.equal(edit.getAll("image[]").length, 2);
  assert.ok(edit.get("mask") instanceof Blob);
});
