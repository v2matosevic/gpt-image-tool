// GPT-Image-2.6 in the tool as a whole: models, complexity, custom sizes, usage and cost, and where
// the key comes from. Every request is a mocked fetch; nothing reaches a provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGE_MODELS, DEFAULT_API_MODEL, resolveImageModel, validateComplexity, validateSize, customSizeProblem } from "../dist/models.js";
import { outputTokens, costFromUsage, estimateCost, cleanUsage, dollars } from "../dist/pricing.js";
import { findApiKey, readSecret, redact, missingKeyMessage } from "../dist/secrets.js";
import { ApiKeyProvider } from "../dist/providers/apikey.js";
import { buildSubscriptionBody } from "../dist/providers/subscription.js";
import { generateImage } from "../dist/generate.js";
import { encodePng } from "../dist/bgremove.js";

// Never let a test find a real key: no user-level file, no inherited environment key.
const HOME = mkdtempSync(join(tmpdir(), "gptimg-secrets-home-"));
process.env.GPT_IMAGE_SECRETS_HOME = HOME;
delete process.env.OPENAI_API_KEY;

const png = encodePng({ width: 64, height: 64, data: Buffer.alloc(64 * 64 * 4, 200) });
const base = { prompt: "a paper bird", size: "1024x1024" as const, quality: "low" as const, format: "png" as const };
const usage = { input_tokens: 150, output_tokens: 823, total_tokens: 973, input_tokens_details: { text_tokens: 150, image_tokens: 0 } };
const project = () => mkdtempSync(join(tmpdir(), "gptimg-api26-"));

test("2.6 names resolve, 2.5 stays selectable, and the API default follows OpenAI's guide", () => {
  assert.equal(DEFAULT_API_MODEL, "gpt-image-2.6-sunburst");
  assert.equal(resolveImageModel(undefined, "apikey", {}), "gpt-image-2.6-sunburst");
  assert.equal(resolveImageModel("flare", "apikey", {}), "gpt-image-2.6-flare");
  assert.equal(resolveImageModel("sunburst-2.5", "apikey", {}), "gpt-image-2.5-sunburst");
  assert.equal(resolveImageModel("gpt-image-2.5-flare", "apikey", {}), "gpt-image-2.5-flare");
  assert.equal(IMAGE_MODELS["flare-2.5"], "gpt-image-2.5-flare");
  assert.throws(() => resolveImageModel("flare", "subscription", {}), /does not reliably enforce/);
});

test("complexity is a 2.6 API field: sent when set, refused on the subscription and older models", () => {
  validateComplexity(undefined, undefined);
  validateComplexity("low", "gpt-image-2.6-flare");
  assert.throws(() => validateComplexity("low", undefined), /subscription ignores it/);
  assert.throws(() => validateComplexity("low", "gpt-image-2.5-sunburst"), /GPT-Image-2.6 setting/);
  assert.throws(() => validateComplexity("extreme", "gpt-image-2.6-flare"), /Invalid complexity/);
  assert.throws(() => buildSubscriptionBody({ ...base, complexity: "low" }), /subscription ignores it/);
});

test("custom sizes follow the documented limits and need the API", () => {
  assert.equal(customSizeProblem("2048x1152"), null);
  assert.equal(customSizeProblem("3840x2160"), null);
  assert.match(customSizeProblem("2050x1152")!, /multiples of 16/);
  assert.match(customSizeProblem("3856x2160")!, /3840/);
  assert.match(customSizeProblem("3072x768")!, /1:3 and 3:1/);
  assert.match(customSizeProblem("512x512")!, /total pixels/);
  validateSize("2560x1440", "apikey", "gpt-image-2.6-sunburst");
  validateSize("1024x1024", "subscription", undefined);
  assert.throws(() => validateSize("2560x1440", "subscription", undefined), /needs backend apikey/);
  assert.throws(() => validateSize("2560x1440", "apikey", "gpt-image-2"), /needs GPT Image 2.5 or 2.6/);
  assert.throws(() => buildSubscriptionBody({ ...base, size: "2560x1440" as any }), /needs backend apikey/);
});

test("output tokens match OpenAI's calculator (values read from the guide on 2026-11-28)", () => {
  const m = "gpt-image-2.6-sunburst";
  const table: Array<[string, number, number, number]> = [
    ["low", 1024, 1024, 823], ["low", 1536, 1024, 664], ["low", 2048, 2048, 1667], ["low", 3840, 2160, 1558], ["low", 512, 1280, 269],
    ["medium", 1024, 1024, 1449], ["medium", 2048, 1152, 1211], ["high", 1024, 1024, 1756], ["high", 2048, 2048, 3568],
    ["high", 1024, 2048, 1180], ["xhigh", 1024, 1536, 2459], ["max", 1024, 1024, 7024], ["max", 3840, 2160, 13342],
  ];
  for (const [q, w, h, tokens] of table) assert.equal(outputTokens(m, q as any, w, h), tokens, `${q} ${w}x${h}`);
});

test("cost comes from reported usage at the dated rates; unsplit input is charged at the image rate", () => {
  assert.equal(costFromUsage("gpt-image-2.6-flare", usage), (150 * 5 + 823 * 30) / 1e6);
  assert.equal(costFromUsage("gpt-image-2.6-flare", { input_tokens: 1000, output_tokens: 0 }), 1000 * 8 / 1e6);
  assert.equal(costFromUsage("gpt-image-2.6-flare", { input_tokens: 1000, output_tokens: 0, input_tokens_details: { text_tokens: 200, image_tokens: 800 } }), (200 * 5 + 800 * 8) / 1e6);
  const e = estimateCost({ model: "gpt-image-2.6-sunburst", quality: "auto", size: "auto", promptChars: 400 });
  assert.deepEqual(e.assumed, ["quality auto taken as high", "size auto taken as 1024x1024"]);
  assert.equal(e.outputTokens, 1756);
  assert.deepEqual(cleanUsage({ input_tokens: 5, output_tokens: 7, secret: "x", input_tokens_details: { text_tokens: 5, evil: "y" } }), { input_tokens: 5, output_tokens: 7, input_tokens_details: { text_tokens: 5 } });
  assert.equal(dollars(0.001), "<$0.01");
  assert.equal(dollars(0.0612), "$0.06");
});

test("the key comes from the environment, then the project's .secrets (both formats), then the user file", () => {
  const p = project();
  writeFileSync(join(p, ".secrets"), "# keys\nOTHER=1\nOPENAI_API_KEY: 'sk-test-colon-format-0001'\n");
  assert.equal(readSecret(join(p, ".secrets")), "sk-test-colon-format-0001");
  const q = project();
  writeFileSync(join(q, ".secrets"), "export OPENAI_API_KEY=sk-test-equals-format-0002\n");
  assert.equal(findApiKey(q, {})!.key, "sk-test-equals-format-0002");
  assert.match(findApiKey(q, {})!.source, /\.secrets$/);
  assert.equal(findApiKey(q, { OPENAI_API_KEY: "sk-test-env-0003" })!.source, "OPENAI_API_KEY in the environment");
  const empty = project();
  assert.equal(findApiKey(empty, { GPT_IMAGE_SECRETS_HOME: HOME }), undefined, "an explicit project never borrows a key from cwd");
  const home = project();
  mkdirSync(join(home, ".gptimage"));
  writeFileSync(join(home, ".gptimage", "secrets"), "OPENAI_API_KEY=sk-test-user-file-0004\n");
  assert.match(findApiKey(empty, { GPT_IMAGE_SECRETS_HOME: home })!.source, /secrets$/);
  const msg = missingKeyMessage(empty, { GPT_IMAGE_SECRETS_HOME: HOME });
  assert.match(msg, /No request was sent, and nothing was switched to the subscription/);
});

test("redaction removes the key and masked echoes of it", () => {
  const key = "sk-proj-ABCDEFGHIJKLMNOP0123456789wxyz";
  const echo = `Incorrect API key provided: sk-proj-ABCD************************wxyz. Also ${key}.`;
  const out = redact(echo, key);
  assert.ok(!out.includes(key));
  assert.ok(!out.includes("ABCDEFGH"));
  assert.ok(!out.includes("wxyz"), out);
  assert.ok(!/sk-[A-Za-z0-9]{6,}/.test(redact("leak sk-other1234567890 here")));
});

test("API payloads carry the 2.6 model, complexity and custom size; usage and the key source come back", async (t) => {
  const p = project();
  writeFileSync(join(p, ".secrets"), "OPENAI_API_KEY=sk-test-payload-key-0005\n");
  const requests: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }], usage: { ...usage, extra: "ignored" } }));
  });
  const provider = new ApiKeyProvider();
  const r = await provider.generate({ ...base, imageModel: "flare", complexity: "low", size: "2560x1440" as any, keyProject: p });
  const body = JSON.parse(requests[0]!.init.body as string);
  assert.equal(body.model, "gpt-image-2.6-flare");
  assert.equal(body.complexity, "low");
  assert.equal(body.size, "2560x1440");
  assert.equal((requests[0]!.init.headers as any).Authorization, "Bearer sk-test-payload-key-0005");
  assert.deepEqual(r.usage, usage);
  assert.match(r.keySource!, /\.secrets$/);
  assert.ok(!JSON.stringify(r.keySource).includes("sk-test"));
  await provider.generate({ ...base, imageModel: "sunburst", complexity: "medium", inputImages: [{ bytes: png, mime: "image/png" }], keyProject: p });
  const form = requests[1]!.init.body as FormData;
  assert.equal(form.get("model"), "gpt-image-2.6-sunburst");
  assert.equal(form.get("complexity"), "medium");
  assert.match(requests[1]!.url, /images\/edits$/);
});

test("no key is a refusal that names the fix; nothing is sent and nothing falls back", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("{}"); });
  const p = project();
  await assert.rejects(new ApiKeyProvider().generate({ ...base, keyProject: p }), /needs OPENAI_API_KEY and none was found.*nothing was switched to the subscription/s);
  assert.equal(calls, 0);
});

test("a refused key's echo never reaches the error", async (t) => {
  const key = "sk-test-LEAKCANARY-9f8e7d6c5b4a3210";
  const p = project();
  writeFileSync(join(p, ".secrets"), `OPENAI_API_KEY=${key}\n`);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${key.slice(0, 10)}****${key.slice(-4)}. Full: ${key}` } }), { status: 401 }));
  const err = await new ApiKeyProvider().generate({ ...base, keyProject: p }).catch(e => e as Error);
  assert.ok(err instanceof Error);
  assert.match(err.message, /HTTP 401/);
  for (const frag of [key, key.slice(0, 10), key.slice(-4), "LEAKCANARY"]) assert.ok(!err.message.includes(frag), `error leaks ${frag}: ${err.message}`);
});

test("a direct API generation records usage and cost in its result and sidecar, never the key", async (t) => {
  const p = project();
  const key = "sk-test-SIDECARCANARY-1234567890";
  writeFileSync(join(p, ".secrets"), `OPENAI_API_KEY=${key}\n`);
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }], usage })));
  const old = { profile: process.env.GPT_IMAGE_PROFILE, sidecar: process.env.GPT_IMAGE_NO_SIDECAR };
  process.env.GPT_IMAGE_PROFILE = join(p, "absent.json");
  t.after(() => { for (const [k, v] of Object.entries({ GPT_IMAGE_PROFILE: old.profile })) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const out = await generateImage({ prompt: "a bird", backend: "apikey", imageModel: "flare", quality: "low", complexity: "low", keyProject: p, outputPath: join(p, "bird.png"), proof: false, autoPalette: false });
  assert.equal(out.cost!.dollars, costFromUsage("gpt-image-2.6-flare", usage));
  assert.equal(out.requests, 1);
  const sidecar = readFileSync(`${out.path}.json`, "utf8");
  assert.match(sidecar, /"complexity": "low"/);
  assert.match(sidecar, /"output_tokens": 823/);
  assert.ok(!sidecar.includes(key) && !sidecar.includes("SIDECARCANARY"));
});

test("a profile's complexity applies only to API calls; a subscription call in that project is not refused", async () => {
  const { overlay } = await import("../dist/generate.js");
  const profile = { complexity: "low" };
  assert.equal(overlay(profile as any, { subject: "a cup" } as any).complexity, undefined);
  assert.equal(overlay(profile as any, { subject: "a cup", backend: "subscription" } as any).complexity, undefined);
  assert.equal(overlay(profile as any, { subject: "a cup", backend: "apikey" } as any).complexity, "low");
  assert.equal(overlay({ ...profile, backend: "apikey" } as any, { subject: "a cup" } as any).complexity, "low");
  assert.equal(overlay(profile as any, { subject: "a cup", backend: "apikey", complexity: "high" } as any).complexity, "high");
});

test("a v0.6.0 sidecar replays its recorded 2.5 model, though flare now means 2.6", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "replay-"));
  writeFileSync(join(dir, ".secrets"), "OPENAI_API_KEY=sk-test-replay-000\n");
  const old = join(dir, "old.png");
  writeFileSync(`${old}.json`, JSON.stringify({ operation: "generate", subject: "a folded paper bird", backend: "apikey", imageModel: "gpt-image-2.5-flare", quality: "low", size: "1024x1024", format: "png" }));
  const bodies: any[] = [];
  const png = encodePng({ width: 4, height: 4, data: Buffer.alloc(64, 128) });
  t.mock.method(globalThis, "fetch", async (_u: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }], usage: { input_tokens: 10, output_tokens: 196 } }));
  });
  await generateImage({ fromImage: old, outputPath: join(dir, "again.png"), keyProject: dir } as any);
  await generateImage({ subject: "a folded paper bird", backend: "apikey", imageModel: "flare", quality: "low", outputPath: join(dir, "new.png"), keyProject: dir } as any);
  assert.deepEqual(bodies.map(b => b.model), ["gpt-image-2.5-flare", "gpt-image-2.6-flare"]);
});
