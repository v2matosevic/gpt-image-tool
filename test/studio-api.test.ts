// Studio phase 1d: the paid API as an explicit choice. Spend limits that a resume, a second run or a
// concurrent run cannot get past; grants and the ceiling; no fallback; the draft-approve-finish
// ladder; the key never written anywhere. Provider work uses the fakes, or the real executors with
// a mocked fetch (never a real request: every key here is a synthetic canary).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGraph, editGraph, budgetReport, statusReport, getGraph } from "../dist/studio/api.js";
import { startRun } from "../dist/studio/runner.js";
import { StudioError, graphDir, readBoth, readEvents } from "../dist/studio/store.js";
import { evaluate } from "../dist/studio/evaluate.js";
import { readLedger, budgetView } from "../dist/studio/budget.js";
import { realExecutors } from "../dist/studio/execute.js";
import { guide } from "../dist/studio/guide.js";
import { nodeRegistry } from "../dist/studio/nodes.js";
import { memoryBrief } from "../dist/studio/memory.js";
import { encodePng } from "../dist/bgremove.js";
// @ts-ignore - plain JS fixture
import { makeFakes, fakePng } from "./fixtures/studio-fakes.mjs";

const HOME = mkdtempSync(join(tmpdir(), "studio-api-home-"));
process.env.GPT_IMAGE_SECRETS_HOME = HOME;
process.env.GPT_IMAGE_STUDIO_HOME = HOME;
delete process.env.OPENAI_API_KEY;

function project(profile?: Record<string, unknown>): string {
  const p = mkdtempSync(join(tmpdir(), "studio-api-"));
  if (profile) writeFileSync(join(p, ".gptimage.json"), JSON.stringify(profile));
  return p;
}
async function refusal(p: Promise<unknown>, code: string): Promise<StudioError> {
  try { await p; } catch (e) { assert.ok(e instanceof StudioError, String(e)); assert.equal((e as StudioError).code, code, (e as Error).message); return e as StudioError; }
  assert.fail(`expected refusal ${code}`);
}
const run = (p: string, slug: string, extra: Record<string, unknown> = {}, fakes = makeFakes()) =>
  startRun(p, slug, { actor: "t", detach: false, executors: fakes.executors, ...extra } as any);
const lastRecord = async (p: string, slug: string) => (await statusReport(slug, { project: p })).record!;

/** A list of n items rendered on the API (flare low), one slot each. */
async function apiList(p: string, slug: string, n: number, settings: Record<string, unknown> = {}) {
  await createGraph({ name: slug, slug, nodes: [
    { ref: "items", type: "list", settings: { items: Array.from({ length: n }, (_, i) => `object ${i + 1}`) } },
    { ref: "draft", type: "generate", settings: { renderer: "api", model: "flare", quality: "low", size: "1024x1024", ...settings } },
  ], connections: [{ from: "items", to: "draft" }] }, { project: p });
}

test("API settings need renderer api; the subscription refuses them by name", async () => {
  const p = project();
  const bad = async (settings: Record<string, unknown>, rx: RegExp) => {
    const e = await refusal(createGraph({ name: "Bad", nodes: [{ ref: "g", type: "generate", settings: { prompt: "x", ...settings } }] }, { project: p }), "BAD_SETTINGS");
    assert.match(JSON.stringify(e.issues), rx);
  };
  await bad({ model: "flare" }, /picks its own model/);
  await bad({ complexity: "low" }, /subscription ignores it/);
  await bad({ quality: "max" }, /API-only/);
  await bad({ size: "2560x1440" }, /API-only/);
  await bad({ renderer: "api", size: "2050x1440" }, /multiples of 16/);
  await bad({ renderer: "api", model: "gpt-image-2", complexity: "low" }, /GPT-Image-2.6 setting/);
  await createGraph({ name: "Ok", nodes: [{ ref: "g", type: "generate", settings: { prompt: "x", renderer: "api", model: "sunburst", quality: "max", size: "2560x1440", complexity: "high" } }] }, { project: p });
});

test("a project cannot default to the API: studio.renderer in the profile is refused", async () => {
  const p = project({ studio: { renderer: "api" } });
  await apiList(p, "g", 1);
  // The API node carries the issue, so the run is blocked and names the fix.
  assert.equal((await run(p, "g")).status, "blocked");
  const plan = (await startRun(p, "g", { actor: "t", dryRun: true } as any)).message;
  assert.match(plan, /project-wide renderer is not supported/);
  // A subscription node in the same project still runs.
  await createGraph({ name: "Sub", nodes: [{ ref: "g", type: "generate", settings: { prompt: "x" } }] }, { project: p });
  const fakes = makeFakes();
  assert.equal((await run(p, "sub", {}, fakes)).status, "done");
  assert.deepEqual(fakes.calls.map((c: any[]) => c[3]), ["subscription"]);
});

test("renderer and model are in the fingerprint and on every take; limits do not touch caches", async () => {
  const p = project({ studio: { limits: { run: 2 } } });
  await createGraph({ name: "fp", nodes: [
    { ref: "sub", type: "generate", settings: { prompt: "a cup" } },
    { ref: "api", type: "generate", settings: { prompt: "a cup", renderer: "api", model: "flare" } },
  ] }, { project: p });
  const fps = async () => { const { graph, state } = await readBoth(graphDir(p, "fp")); const ev = await evaluate(graph, state, { dir: graphDir(p, "fp"), project: p }); return { sub: ev.get("sub")!.slots[0]!.fingerprint, api: ev.get("api")!.slots[0]!.fingerprint }; };
  const a = await fps();
  assert.notEqual(a.sub, a.api);
  writeFileSync(join(p, ".gptimage.json"), JSON.stringify({ studio: { limits: { run: 1.5, day: 7 } } }));
  assert.deepEqual(await fps(), a, "changing spend limits must not invalidate cached takes");
  writeFileSync(join(p, ".gptimage.json"), JSON.stringify({ studio: { limits: { run: 1.5 }, api: { quality: "medium" } } }));
  const b = await fps();
  assert.equal(b.sub, a.sub, "API defaults do not move subscription slots");
  assert.notEqual(b.api, a.api, "API defaults are part of API slots");
  await editGraph("fp", [{ op: "set", node: "api", settings: { model: "sunburst" } }], { project: p });
  assert.notEqual((await fps()).api, b.api, "the model is part of the fingerprint");
  await run(p, "fp");
  const { state } = await readBoth(graphDir(p, "fp"));
  assert.deepEqual(state.nodes.sub!.takes[0]!.render, { renderer: "subscription", model: "gpt-image-2 (server-chosen)" });
  const t = state.nodes.api!.takes[0]!;
  assert.equal(t.render!.renderer, "api");
  assert.equal(t.render!.model, "gpt-image-2.6-sunburst");
  assert.equal(t.render!.quality, "medium");
  assert.equal(t.cost!.dollars, (100 * 5 + 1000 * 30) / 1e6);
  assert.equal(t.cost!.funding, "limit");
  assert.equal(t.usage!.output_tokens, 1000);
});

test("a dry run estimates the cost; the run reports what it spent", async () => {
  const p = project();
  await apiList(p, "est", 3);
  const dry = await startRun(p, "est", { actor: "t", dryRun: true } as any);
  assert.equal(dry.plan.api.slots, 3);
  assert.ok(dry.plan.api.cost > 0.07 && dry.plan.api.cost < 0.09, String(dry.plan.api.cost));
  assert.match(dry.message, /Estimated paid API cost: \$0\.08 for 3 images .*It fits inside the limits/);
  await run(p, "est");
  const st = await statusReport("est", { project: p });
  assert.match(st.text, /Paid API: spent \$0\.09 in this run \(estimated \$0\.08 at start\)/);
  assert.match(st.text, /api 2\.6-flare low 1024x1024, saved .*cost \$0\.03/);
});

test("the run limit stops cleanly and resumably; resume, a fresh run and a lowered limit cannot get past it", async () => {
  const p = project({ studio: { limits: { run: 0.1, day: 10 } } });
  await apiList(p, "big", 6);
  const fakes = makeFakes();
  const r1 = await run(p, "big", {}, fakes);
  assert.equal(r1.status, "stopped");
  const rec1 = await lastRecord(p, "big");
  assert.equal(rec1.stopCode, "budget-run");
  assert.ok(rec1.budget!.spent <= 0.1 + 0.031, `spent ${rec1.budget!.spent}`);
  assert.ok(rec1.budget!.needed! > 0.05, "the result says what the rest needs");
  assert.match(rec1.stopFix!, /Ask the owner once, with that amount; do not work around the limit/);
  const done1 = fakes.calls.length;
  assert.ok(done1 >= 3 && done1 < 6);

  // Resume continues the same chain, so the run limit still counts what was spent.
  const r2 = await run(p, "big", { resume: true }, fakes);
  assert.equal(r2.status, "stopped");
  assert.equal(fakes.calls.length, done1, "a resume without a grant renders nothing");
  const rec2 = await lastRecord(p, "big");
  assert.equal(rec2.budget!.chain, rec1.id);

  // A fresh run would reset the run limit: refused after a spend stop the same day.
  const e = await refusal(run(p, "big", { newTake: true }, fakes), "BUDGET_STOPPED");
  assert.match(e.fix!, /Ask the owner once/);
  // Raising the limit per run is refused; only grants or the owner's profile edit raise it.
  await refusal(run(p, "big", { resume: true, limits: { run: 5 } }, fakes), "LIMIT_RAISE");

  // The owner approves in chat; the agent records it; the resume finishes on the grant.
  const g = await budgetReport({ project: p, grant: { amount: 0.5, words: "approve, half a dollar for the rest", approvedBy: "owner", graph: "big" } });
  assert.match(g.text, /Recorded grant g\w+ \$0\.50 for graph big/);
  const r3 = await run(p, "big", { resume: true }, fakes);
  assert.equal(r3.status, "done");
  assert.equal(fakes.calls.length, 6, "every slot rendered exactly once across the chain");
  const ledger = await readLedger(p);
  assert.ok(ledger.some((x: any) => x.t === "reserve" && x.funding === `grant:${g.grant}`));
  const view = await budgetView(p, { run: 0.1, day: 10, ceiling: 50 }, "big");
  assert.ok(view.grants[0]!.drawn > 0 && view.grants[0]!.source === "agent");
  const events = await readEvents(graphDir(p, "big"));
  assert.ok(events.some(ev => ev.type === "budget.grant"));
  assert.ok(events.some(ev => ev.type === "take.saved" && ev.funding === `grant:${g.grant}`));
});

test("the day limit holds across graphs and concurrent runs in the same project", async () => {
  const p = project({ studio: { limits: { run: 2, day: 0.12 } } });
  await apiList(p, "one", 5);
  await apiList(p, "two", 5);
  // No usage reported, so each request costs exactly its estimate: the bound is then exact.
  const fakes = makeFakes({ delayMs: 30, usage: () => undefined });
  await Promise.all([run(p, "one", { concurrency: 3 }, fakes), run(p, "two", { concurrency: 3 }, fakes)]);
  const v = await budgetView(p, { run: 2, day: 0.12, ceiling: 50 });
  assert.ok(v.spentToday <= 0.12 + 1e-9, `spent ${v.spentToday} past the day limit`);
  assert.ok(fakes.calls.length >= 4 && fakes.calls.length < 10, String(fakes.calls.length));
  const codes = [(await lastRecord(p, "one")).stopCode, (await lastRecord(p, "two")).stopCode];
  assert.ok(codes.includes("budget-day"), JSON.stringify(codes));
  const ledger = await readLedger(p);
  assert.ok(ledger.filter((x: any) => x.t === "settle").every((x: any) => x.uncertain), "unreported usage is marked uncertain");
});

test("the ceiling caps any grant; grants need words, an approver and end with the day", async () => {
  const p = project({ studio: { limits: { run: 0.03, day: 0.03, ceiling: 0.08 } } });
  await refusal(budgetReport({ project: p, grant: { amount: 0.5, words: "approve", approvedBy: "owner" } }), "BAD_GRANT");
  await refusal(budgetReport({ project: p, grant: { amount: 0.05, words: " ", approvedBy: "owner" } }), "BAD_GRANT");
  await refusal(budgetReport({ project: p, grant: { amount: 0.05, words: "approve", approvedBy: "owner", expires: new Date(Date.now() + 3 * 86_400_000).toISOString() } }), "BAD_GRANT");
  await budgetReport({ project: p, grant: { amount: 0.08, words: "approve", approvedBy: "owner" } });
  await apiList(p, "cap", 6);
  const fakes = makeFakes({ usage: () => undefined });
  await run(p, "cap", {}, fakes);
  const rec = await lastRecord(p, "cap");
  assert.equal(rec.stopCode, "budget-ceiling");
  const v = await budgetView(p, { run: 0.03, day: 0.03, ceiling: 0.08 });
  assert.ok(v.spentToday <= 0.08 + 1e-9, String(v.spentToday));
  assert.match(rec.stopFix!, /only be raised by the owner editing studio\.limits\.ceiling/);
});

test("lowering a limit for one run works; it never raises", async () => {
  const p = project();
  await apiList(p, "low", 4);
  const fakes = makeFakes({ usage: () => undefined });
  await run(p, "low", { limits: { run: 0.05 } }, fakes);
  const rec = await lastRecord(p, "low");
  assert.equal(rec.budget!.limits.run, 0.05);
  assert.equal(rec.stopCode, "budget-run");
  assert.equal(fakes.calls.length, 1);
});

// ---------------------------------------------------------------- real executors, mocked fetch

const draftPng = encodePng({ width: 96, height: 64, data: Buffer.from(Array.from({ length: 96 * 64 * 4 }, (_, i) => (i % 4 === 3 ? 255 : (i * 7) % 251))) });
type Req = { url: string; body: any };
function mockApi(t: any, opts: { status?: number; body?: (url: string) => string } = {}) {
  const reqs: Req[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const body = init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `<blob ${(v as Blob).size}>`])) : JSON.parse(String(init.body));
    reqs.push({ url: String(url), body });
    if (opts.status) return new Response(opts.body?.(String(url)) ?? "{}", { status: opts.status });
    return new Response(JSON.stringify({ data: [{ b64_json: draftPng.toString("base64") }], usage: { input_tokens: 220, output_tokens: 664, total_tokens: 884, input_tokens_details: { text_tokens: 220, image_tokens: 0 } } }));
  });
  return reqs;
}

test("no key: the run stops with the fix, sends nothing, and never renders on the subscription", async (t) => {
  const p = project();
  await apiList(p, "nokey", 2);
  const reqs = mockApi(t);
  const r = await startRun(p, "nokey", { actor: "t", detach: false, executors: realExecutors } as any);
  assert.equal(r.status, "stopped");
  assert.equal(reqs.length, 0, "no request to any backend");
  const rec = await lastRecord(p, "nokey");
  assert.match(rec.stopReason!, /needs OPENAI_API_KEY and none was found/);
  assert.match(rec.stopFix!, /\.secrets.*Nothing was rendered on the subscription instead/s);
  const ledger = await readLedger(p);
  assert.ok(ledger.filter((x: any) => x.t === "settle").every((x: any) => x.cost === 0), "a request never sent is not charged");
});

test("the ladder end to end: cheap drafts, approve one, finish it from the image at 2048 px", async (t) => {
  const p = project();
  writeFileSync(join(p, ".secrets"), "OPENAI_API_KEY=sk-test-ladder-canary-000111\n");
  await createGraph({ name: "ladder", nodes: [
    { ref: "draft", type: "generate", settings: { prompt: "a green glass bottle on grey", renderer: "api", model: "flare", quality: "low", size: "1536x1024", takes: 2 } },
    { ref: "final", type: "finish" },
  ], connections: [{ from: "draft", to: "final" }] }, { project: p });
  const reqs = mockApi(t);
  // The finish waits for an approval and says so.
  const dry0 = await startRun(p, "ladder", { actor: "t", dryRun: true } as any);
  assert.match(dry0.message, /finish waits for an approved take from draft/);
  assert.equal(dry0.plan.api.slots, 2, "the finish is not priced before a draft is approved");
  await startRun(p, "ladder", { actor: "t", detach: false, executors: realExecutors, scope: "draft" } as any);
  assert.equal(reqs.length, 2);
  assert.match(reqs[0]!.url, /images\/generations$/);
  assert.equal(reqs[0]!.body.model, "gpt-image-2.6-flare");
  assert.equal(reqs[0]!.body.quality, "low");
  assert.equal(reqs[0]!.body.size, "1536x1024");
  await editGraph("ladder", [{ op: "approve", take: "draft/t2" }], { project: p, actor: "owner", human: true });
  const dry = await startRun(p, "ladder", { actor: "t", dryRun: true } as any);
  assert.match(dry.message, /final: api 2\.6-sunburst high 2048x1360 complexity low/);
  assert.match(dry.message, /Prompt for final .*Re-render this exact image/);
  await startRun(p, "ladder", { actor: "t", detach: false, executors: realExecutors } as any);
  assert.equal(reqs.length, 3, "only the approved draft is finished");
  const fin = reqs[2]!;
  assert.match(fin.url, /images\/edits$/, "a finish goes through the edit endpoint, from the image");
  assert.equal(fin.body.model, "gpt-image-2.6-sunburst");
  assert.equal(fin.body.quality, "high");
  assert.equal(fin.body.size, "2048x1360", "the draft's 3:2 aspect at 2048 px, multiples of 16");
  assert.equal(fin.body.complexity, "low");
  assert.match(fin.body["image[]"], /^<blob \d+>$/);
  assert.match(fin.body.prompt, /Keep the composition, framing, camera angle, subject/);
  const { state } = await readBoth(graphDir(p, "ladder"));
  const take = state.nodes.final!.takes[0]!;
  assert.equal(take.inputs[0]!.take, "t2");
  assert.equal(take.render!.size, "2048x1360");
  assert.ok(take.reading, "the finish has a reading, so drift from the draft is measured");
  assert.equal(take.cost!.dollars, (220 * 5 + 664 * 30) / 1e6);
  const st = await statusReport("ladder", { project: p });
  assert.match(st.text, /final\/t3/);
});

test("the key never reaches a written file or a result, in success or failure", async (t) => {
  const key = "sk-test-LEAKCANARY-a1b2c3d4e5f60718293a";
  const p = project();
  writeFileSync(join(p, ".secrets"), `OPENAI_API_KEY: ${key}\n`);
  await createGraph({ name: "leak", nodes: [
    { ref: "draft", type: "generate", settings: { prompt: "a red cube", renderer: "api", model: "flare", quality: "low" } },
    { ref: "up", type: "process", settings: { op: "upscale", renderer: "api" } },
  ], connections: [{ from: "draft", to: "up" }] }, { project: p });
  mockApi(t);
  await startRun(p, "leak", { actor: "t", detach: false, executors: realExecutors } as any);
  const texts: string[] = [(await statusReport("leak", { project: p })).text, (await getGraph("leak", { project: p })).snapshot!, (await budgetReport({ project: p })).text];
  // Now the API refuses the key and echoes it (masked and in full) in its error body.
  t.mock.restoreAll();
  mockApi(t, { status: 401, body: () => JSON.stringify({ error: { message: `Incorrect API key provided: ${key.slice(0, 12)}********${key.slice(-4)} (${key})`, code: "invalid_api_key" } }) });
  await editGraph("leak", [{ op: "set", node: "draft", settings: { quality: "medium" } }], { project: p });
  const r = await startRun(p, "leak", { actor: "t", detach: false, executors: realExecutors } as any);
  assert.equal(r.status, "stopped");
  texts.push((await statusReport("leak", { project: p })).text);
  const rec = await lastRecord(p, "leak");
  assert.match(rec.stopReason!, /HTTP 401/);
  assert.match(rec.stopFix!, /key was refused/);

  const frags = [key, key.slice(0, 12), key.slice(-8), "LEAKCANARY"];
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const x = join(d, f); if (statSync(x).isDirectory()) walk(x); else files.push(x); } };
  walk(join(p, ".gptimage"));
  assert.ok(files.length > 10, `walked ${files.length} files`);
  for (const f of files) {
    const text = readFileSync(f).toString("latin1");
    for (const frag of frags) assert.ok(!text.includes(frag), `${f} contains ${frag}`);
  }
  for (const text of texts) for (const frag of frags) assert.ok(!text.includes(frag), `a result contains ${frag}`);
});

test("lessons carry the renderer they were learned on; the guide lists the one in use first", async () => {
  const p = project();
  await apiList(p, "les", 2);
  await createGraph({ name: "sub", nodes: [{ ref: "items", type: "list", settings: { items: ["a", "b"] } }, { ref: "draft", type: "generate", settings: {} }], connections: [{ from: "items", to: "draft" }] }, { project: p });
  await run(p, "les");
  await run(p, "sub");
  await editGraph("les", [{ op: "lesson", claim: "flare drafts keep labels legible", dimension: "text", takes: ["draft/t1", "draft/t2"] }], { project: p });
  await editGraph("sub", [{ op: "lesson", claim: "subscription drafts soften labels", dimension: "text", takes: ["draft/t1", "draft/t2"] }], { project: p });
  const api = await memoryBrief(p, 5, "api");
  const lines = api.split("\n");
  assert.match(lines[1]!, /api gpt-image-2\.6-flare\] text: flare drafts/);
  assert.match(lines[2]!, /subscription gpt-image-2\] text: subscription drafts .*not checked on the api renderer/);
  const sub = await memoryBrief(p, 5, "subscription");
  assert.match(sub.split("\n")[1]!, /subscription drafts/);
});

test("the guide teaches the renderer rule and the ladder; the registry lists finish", () => {
  const g = guide();
  assert.match(g, /## finish\n/);
  assert.match(g, /# Renderer: subscription by default/);
  assert.match(g, /will anyone look at this image at full size/);
  assert.match(g, /Never regenerate a final from the prompt/);
  const reg = nodeRegistry();
  const fin = reg.find((n: any) => n.type === "finish")!;
  assert.equal(fin.work, "provider");
  assert.deepEqual(fin.inputs.map((h: any) => h.name), ["image"]);
  assert.equal(reg.find((n: any) => n.type === "process")!.work, "depends");
});

test("runs started in the same second are ordered by their created time, not their random suffix", async () => {
  const { listRecords } = await import("../dist/studio/runner.js");
  const dir = mkdtempSync(join(tmpdir(), "studio-runs-"));
  mkdirSync(join(dir, "runs"));
  writeFileSync(join(dir, "runs", "r20261128-031155-ffff.json"), JSON.stringify({ created: "2026-11-28T03:11:55.100Z" }));
  writeFileSync(join(dir, "runs", "r20261128-031155-0000.json"), JSON.stringify({ created: "2026-11-28T03:11:55.900Z" }));
  writeFileSync(join(dir, "runs", "r20261128-031154-aaaa.json"), JSON.stringify({ created: "2026-11-28T03:11:54.000Z" }));
  assert.deepEqual(await listRecords(dir), ["r20261128-031154-aaaa", "r20261128-031155-ffff", "r20261128-031155-0000"]);
});
