// Every paid request goes through the ledger: direct tool calls as well as Studio, a user-level
// limit across projects that no project can raise, per-day files that fail closed, and the clock.
// No provider is ever called: fetch is mocked, keys are synthetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateImage } from "../dist/generate.js";
import { directCall } from "../dist/spend.js";
import { createGraph, budgetReport } from "../dist/studio/api.js";
import { startRun } from "../dist/studio/runner.js";
import { StudioError } from "../dist/studio/store.js";
import { readLedger, readUserLedger, reserve, budgetView, localDay, ledgerDir, userLedgerDir, DIRECT } from "../dist/studio/budget.js";
import { encodePng } from "../dist/bgremove.js";
// @ts-ignore - plain JS fixture
import { makeFakes } from "./fixtures/studio-fakes.mjs";

const png = encodePng({ width: 8, height: 8, data: Buffer.alloc(8 * 8 * 4, 200) });
const L = { run: 2, day: 10, ceiling: 50 };

/** A fresh user home (user ledger + config) and project with a synthetic key, for one test. */
function setup(t: any, opts: { profile?: Record<string, unknown>; user?: Record<string, unknown> } = {}) {
  const home = mkdtempSync(join(tmpdir(), "spend-home-"));
  const project = mkdtempSync(join(tmpdir(), "spend-project-"));
  writeFileSync(join(project, ".secrets"), "OPENAI_API_KEY=sk-test-spend-000\n");
  if (opts.profile) writeFileSync(join(project, ".gptimage.json"), JSON.stringify(opts.profile));
  if (opts.user) { mkdirSync(join(home, ".gptimage"), { recursive: true }); writeFileSync(join(home, ".gptimage", "config.json"), JSON.stringify(opts.user)); }
  const saved = { home: process.env.GPT_IMAGE_SECRETS_HOME, dir: process.env.GPT_IMAGE_PROJECT_DIR };
  process.env.GPT_IMAGE_SECRETS_HOME = home;
  process.env.GPT_IMAGE_PROJECT_DIR = project;
  t.after(() => { process.env.GPT_IMAGE_SECRETS_HOME = saved.home; process.env.GPT_IMAGE_PROJECT_DIR = saved.dir; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }], usage: { input_tokens: 20, output_tokens: 824, total_tokens: 844, input_tokens_details: { text_tokens: 20, image_tokens: 0 } } }));
  });
  return { home, project, calls: () => calls };
}
const direct = (project: string, extra: Record<string, unknown> = {}) =>
  generateImage({ subject: "a cup", backend: "apikey", imageModel: "flare", quality: "low", size: "1024x1024", outputPath: join(project, "out", "x.png"), ...extra } as any);

test("a direct API call is reserved and settled in the project and the user ledger", async (t) => {
  const s = setup(t);
  const out = await direct(s.project);
  assert.equal(s.calls(), 1);
  const p = await readLedger(s.project);
  const r = p.find((e: any) => e.t === "reserve") as any;
  assert.equal(r.graph, DIRECT);
  assert.equal(r.model, "gpt-image-2.6-flare");
  assert.ok(r.estimate > 0.02 && r.estimate < 0.03);
  const settle = p.find((e: any) => e.t === "settle") as any;
  assert.equal(settle.cost, out.cost!.dollars, "settled at the cost the usage implies");
  assert.ok(existsSync(join(ledgerDir(s.project), `${localDay()}.jsonl`)), "one file per local day");
  const u = await readUserLedger();
  assert.equal((u.find((e: any) => e.t === "reserve") as any).project, s.project);
  const view = (await budgetReport({ project: s.project })).text;
  assert.match(view, /Direct tool calls today \(generate_image, edit_image, \.\.\. outside Studio\): \$0\.02/);
  assert.match(view, /All projects \(user level\): spent today \$0\.02 of \$25\.00 a day; ceiling \$100\.00/);
});

test("one direct call is bounded by the per-call limit, even with count; nothing past it is sent", async (t) => {
  const s = setup(t, { profile: { studio: { limits: { run: 0.06 } } } });
  await assert.rejects(direct(s.project, { count: 5 }), (e: Error) => {
    assert.match(e.message, /Spend limit: This tool call's spend limit of \$0\.06 would be passed/);
    assert.match(e.message, /No request was sent, and nothing was switched to the subscription/);
    assert.match(e.message, /Ask the owner once/);
    return true;
  });
  assert.equal(s.calls(), 2, "two fit, the third was refused before it was sent");
  // A second tool call gets its own per-call limit, but still counts against the day.
  await directCall("generate_image", () => direct(s.project));
  assert.equal(s.calls(), 3);
});

test("direct calls are refused at the project day limit; an owner grant funds the next one", async (t) => {
  const s = setup(t, { profile: { studio: { limits: { run: 1, day: 0.03 } } } });
  await directCall("generate_image", () => direct(s.project));
  await assert.rejects(directCall("generate_image", () => direct(s.project)), /Today's spend limit of \$0\.03 for this project/);
  assert.equal(s.calls(), 1);
  await budgetReport({ project: s.project, grant: { amount: 0.05, words: "approve, five cents", approvedBy: "owner" } });
  await directCall("generate_image", () => direct(s.project));
  assert.equal(s.calls(), 2);
  assert.ok((await readLedger(s.project)).some((e: any) => e.t === "reserve" && e.funding.startsWith("grant:")));
});

test("the user-level day limit holds across projects, and no project profile can raise it", async (t) => {
  const s = setup(t, { user: { limits: { day: 0.05, ceiling: 0.08 } } });
  const other = mkdtempSync(join(tmpdir(), "spend-project-b-"));
  writeFileSync(join(other, ".gptimage.json"), JSON.stringify({ studio: { limits: { run: 50, day: 50, ceiling: 50 } } }));
  writeFileSync(join(other, ".secrets"), "OPENAI_API_KEY=sk-test-spend-000\n");
  await directCall("a", () => direct(s.project));
  await directCall("b", () => direct(other, { keyProject: other, outputPath: join(other, "x.png") }));
  await assert.rejects(directCall("c", () => direct(other, { keyProject: other, outputPath: join(other, "y.png") })), (e: Error) => {
    assert.match(e.message, /Today's spend limit of \$0\.05 across all projects would be passed .*no project can change/);
    return true;
  });
  assert.equal(s.calls(), 2);
  // A grant may fund past the user day limit, but only up to the user ceiling.
  await budgetReport({ project: other, grant: { amount: 1, words: "approve", approvedBy: "owner" } });
  await directCall("d", () => direct(other, { keyProject: other, outputPath: join(other, "z.png") }));
  assert.equal(s.calls(), 3);
  await assert.rejects(directCall("e", () => direct(other, { keyProject: other, outputPath: join(other, "w.png") })), /user-level ceiling of \$0\.08 a day across all projects .*No grant can lift it/);
  const v = await budgetView(other, { run: 50, day: 50, ceiling: 50 });
  assert.equal(Object.keys(v.user.byProject).length, 2);
});

test("Studio requests are counted once (managed), in the user ledger too", async (t) => {
  const s = setup(t);
  await createGraph({ name: "g", nodes: [{ ref: "d", type: "generate", settings: { prompt: "x", renderer: "api", model: "flare", quality: "low", takes: 3 } }] }, { project: s.project });
  await startRun(s.project, "g", { actor: "t", detach: false, executors: makeFakes().executors } as any);
  const p = await readLedger(s.project);
  assert.equal(p.filter((e: any) => e.t === "reserve").length, 3);
  assert.ok(!p.some((e: any) => e.graph === DIRECT));
  assert.equal((await readUserLedger()).filter((e: any) => e.t === "reserve").length, 3);
});

test("a torn or hand-edited ledger line fails closed: nothing is sent, the file and line are named", async (t) => {
  const s = setup(t);
  await directCall("a", () => direct(s.project));
  const file = join(ledgerDir(s.project), `${localDay()}.jsonl`);
  appendFileSync(file, '{"t":"settle","id":"s1","cost":-5}\n');
  await assert.rejects(directCall("b", () => direct(s.project)), (e: Error) => {
    assert.ok(e instanceof StudioError && e.code === "BUDGET_LEDGER");
    assert.ok(e.message.includes(file) && /line 3 is a settlement without id or a valid cost/.test(e.message), e.message);
    return true;
  });
  writeFileSync(file, '{"t":"reserve","id":"s2","day":"' + localDay() + '","estimate":0.5,"funding":"limit"}\n{"t":"res');
  await createGraph({ name: "g", nodes: [{ ref: "d", type: "generate", settings: { prompt: "x", renderer: "api", model: "flare" } }] }, { project: s.project });
  const fakes = makeFakes();
  // Studio refuses at the start (the plan's cost line reads the ledger), before any worker exists.
  await assert.rejects(startRun(s.project, "g", { actor: "t", detach: false, executors: fakes.executors } as any), (e: Error) => {
    assert.ok(e instanceof StudioError && e.code === "BUDGET_LEDGER" && /line 2 is not valid JSON/.test(e.message), e.message);
    return true;
  });
  assert.equal(fakes.calls.length, 0);
  assert.equal(s.calls(), 1);
  // The user-level config fails closed too.
  writeFileSync(file, "");
  mkdirSync(join(s.home, ".gptimage"), { recursive: true });
  writeFileSync(join(s.home, ".gptimage", "config.json"), "{ day: 25 ");
  await assert.rejects(directCall("c", () => direct(s.project)), /config\.json is not valid JSON/);
});

test("clock set back: spend dated later still counts today; a grant dated later does not apply", async (t) => {
  const s = setup(t);
  const dir = ledgerDir(s.project);
  mkdirSync(dir, { recursive: true });
  const future = "2999-01-01";
  writeFileSync(join(dir, `${future}.jsonl`),
    JSON.stringify({ t: "reserve", id: "s29990101-x", ts: "2999-01-01T10:00:00Z", day: future, run: "c1", chain: "c1", graph: "g", node: "n", slot: "s", estimate: 9.99, model: "m", funding: "limit", by: "t" }) + "\n" +
    JSON.stringify({ t: "grant", id: "gfuture", ts: "2999-01-01T10:00:00Z", day: future, amount: 40, approvedBy: "x", words: "y", expires: "2999-01-01T23:00:00Z", source: "agent", by: "t" }) + "\n");
  const v = await budgetView(s.project, L);
  assert.equal(v.spentToday, 9.99, "the later-dated reservation counts against today");
  const r = await reserve({ project: s.project, run: "c2", chain: "c2", graph: "g", node: "n", slot: "s", estimate: 0.05, model: "m", limits: L, actor: "t" });
  assert.equal(r.ok, false, "and the future grant does not fund the request");
  assert.equal((r as any).code, "budget-day");
  // Old single-file ledgers are still read.
  writeFileSync(join(dir, "ledger.jsonl"), JSON.stringify({ t: "reserve", id: "sold", ts: "x", day: localDay(), run: "c0", chain: "c0", graph: "g", node: "n", slot: "s", estimate: 0.01, model: "m", funding: "limit", by: "t" }) + "\n");
  assert.equal((await budgetView(s.project, L)).spentToday, 10);
  assert.deepEqual(readdirSync(userLedgerDir()).filter(f => f.endsWith(".jsonl")), [], "nothing was reserved");
});
