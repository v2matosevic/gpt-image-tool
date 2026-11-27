import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGraph, editGraph, getGraph, runGraph, statusReport, viewGraph } from "../dist/studio/api.js";
import { startRun, runStatus } from "../dist/studio/runner.js";
import { StudioError, graphDir, readBoth, readEvents } from "../dist/studio/store.js";
import { evaluate } from "../dist/studio/evaluate.js";
import { safeFile } from "../dist/studio/viewer.js";
import { guide } from "../dist/studio/guide.js";
// @ts-ignore - plain JS fixture
import { makeFakes, fakePng } from "./fixtures/studio-fakes.mjs";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
function project(): string {
  const p = mkdtempSync(join(tmpdir(), "studio-"));
  mkdirSync(join(p, "images"));
  writeFileSync(join(p, "images", "ref.png"), fakePng("reference", 64, 64));
  return p;
}
async function refusal(p: Promise<unknown>, code: string): Promise<StudioError> {
  try { await p; } catch (e) { assert.ok(e instanceof StudioError, String(e)); assert.equal((e as StudioError).code, code, (e as Error).message); return e as StudioError; }
  assert.fail(`expected refusal ${code}`);
}

const lookbook = {
  name: "Mug lookbook",
  nodes: [
    { ref: "subject", type: "prompt", settings: { text: "a sage mug on a {{item}} table" } },
    { ref: "surfaces", type: "list", settings: { items: ["marble", "oak", "linen"] } },
    { ref: "look", type: "style", settings: { preset: "product-studio", shot: { lens: "85mm" } } },
    { ref: "draft", type: "generate", settings: { quality: "low" } },
    { ref: "pick", type: "gallery" },
  ],
  connections: [{ from: "subject", to: "surfaces" }, { from: "surfaces", to: "draft" }, { from: "look", to: "draft" }, { from: "draft", to: "pick" }],
};

test("create validates settings strictly and names the fix; nothing is written on refusal", async () => {
  const p = project();
  const e = await refusal(createGraph({ name: "Bad", nodes: [{ ref: "g", type: "generate", settings: { qualty: "low" } }] }, { project: p }), "BAD_SETTINGS");
  assert.match(e.fix!, /Did you mean "quality"/);
  assert.match(e.fix!, /Valid generate settings: .*size/);
  const t = await refusal(createGraph({ name: "Bad", nodes: [{ ref: "g", type: "generator" }] }, { project: p }), "BAD_TYPE");
  assert.match(t.fix!, /Did you mean "generate"/);
  await refusal(createGraph({ name: "Bad", nodes: [{ ref: "g", type: "generate", settings: { quality: "max" } }] }, { project: p }), "BAD_SETTINGS");
  assert.equal(existsSync(graphDir(p, "bad")), false);
});

test("connection rules: typed handles, single text inputs, no cycles, notes are not edges", async () => {
  const p = project();
  await createGraph(lookbook, { project: p });
  const mismatch = await refusal(editGraph("mug-lookbook", [{ op: "connect", from: "subject", to: "pick" }], { project: p }), "TYPE_MISMATCH");
  assert.match(mismatch.fix!, /Inputs of gallery: images \(image, many\)/);
  const full = await refusal(editGraph("mug-lookbook", [{ op: "add", id: "p2", type: "prompt", settings: { text: "x" } }, { op: "connect", from: "p2", to: "draft" }], { project: p }), "INPUT_FULL");
  assert.match(full.fix!, /disconnect.*surfaces/);
  await refusal(editGraph("mug-lookbook", [{ op: "add", id: "e1", type: "edit", settings: { instruction: "x" } }, { op: "connect", from: "draft", to: "e1" }, { op: "connect", from: "e1", to: "draft", to_handle: "references" }], { project: p }), "CYCLE");
  await refusal(editGraph("mug-lookbook", [{ op: "note", on: "draft", text: "warmer" }, { op: "connect", from: "note1", to: "draft" }], { project: p }), "NOTE_EDGE");
  const r = await editGraph("mug-lookbook", [{ op: "add", id: "e1", type: "edit", settings: { instruction: "warmer" } }, { op: "connect", from: "draft", to: "e1" }], { project: p });
  assert.ok(r.applied.some((x: string) => x.includes("draft.image -> e1.image")));
});

test("an op list is all or nothing, and expect_revision refuses a stale edit", async () => {
  const p = project();
  await createGraph(lookbook, { project: p });
  const dir = graphDir(p, "mug-lookbook");
  const before = readFileSync(join(dir, "graph.json"), "utf8");
  await refusal(editGraph("mug-lookbook", [{ op: "set", node: "draft", settings: { quality: "high" } }, { op: "set", node: "nope", settings: {} }], { project: p }), "NO_NODE");
  assert.equal(readFileSync(join(dir, "graph.json"), "utf8"), before);
  const ok = await editGraph("mug-lookbook", [{ op: "set", node: "draft", settings: { quality: "medium" } }], { project: p, expectRevision: 1 });
  assert.equal(ok.revision, 2);
  const stale = await refusal(editGraph("mug-lookbook", [{ op: "set", node: "draft", settings: { quality: "high" } }], { project: p, expectRevision: 1 }), "STALE_REVISION");
  assert.match(stale.fix!, /studio_get/);
  const pe = await editGraph("mug-lookbook", [{ op: "prompt_edit", node: "subject", find: "sage", replace: "rust" }], { project: p });
  assert.match(pe.snapshot, /rust mug/);
  await refusal(editGraph("mug-lookbook", [{ op: "prompt_edit", node: "subject", find: "teal", replace: "x" }], { project: p }), "NOT_FOUND");
});

test("runs reuse unchanged slots, regenerate only what changed, and keep take history", async () => {
  const p = project();
  await createGraph(lookbook, { project: p });
  const { calls, executors } = makeFakes();
  const first = await startRun(p, "mug-lookbook", { actor: "t", detach: false, executors });
  assert.equal(first.status, "done");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c: string[]) => c[2]), ["a sage mug on a marble table", "a sage mug on a oak table", "a sage mug on a linen table"]);
  const again = await startRun(p, "mug-lookbook", { actor: "t", detach: false, executors });
  assert.equal(again.status, "nothing-to-do");
  await editGraph("mug-lookbook", [{ op: "set", node: "surfaces", settings: { items: ["marble", "walnut", "linen"] } }, { op: "move", node: "pick", x: 900, y: 40 }, { op: "set", node: "draft", label: "Drafts" }], { project: p });
  const plan = await runGraph("mug-lookbook", { dryRun: true }, { project: p });
  assert.equal(plan.plan.generations, 1);
  await startRun(p, "mug-lookbook", { actor: "t", detach: false, executors });
  assert.equal(calls.length, 4);
  assert.equal(calls[3][2], "a sage mug on a walnut table");
  // A reordered list reuses takes by fingerprint.
  await editGraph("mug-lookbook", [{ op: "set", node: "surfaces", settings: { items: ["linen", "marble", "walnut"] } }], { project: p });
  assert.equal((await runGraph("mug-lookbook", { dryRun: true }, { project: p })).plan.generations, 0);
  // new_take adds to history.
  await startRun(p, "mug-lookbook", { actor: "t", detach: false, executors, scope: "draft", newTake: true });
  assert.equal(calls.length, 7);
  const { state } = await readBoth(graphDir(p, "mug-lookbook"));
  assert.equal(state.nodes.draft.takes.length, 7);
  // takes: 2 renders only the missing variant per slot.
  await editGraph("mug-lookbook", [{ op: "set", node: "draft", settings: { takes: 2 } }], { project: p });
  await startRun(p, "mug-lookbook", { actor: "t", detach: false, executors });
  assert.equal(calls.length, 10);
});

test("a change upstream invalidates downstream; selecting a take pins it", async () => {
  const p = project();
  await createGraph({ ...lookbook, nodes: [...lookbook.nodes, { ref: "warm", type: "edit", settings: { instruction: "warmer light" } }], connections: [...lookbook.connections, { from: "draft", to: "warm" }] }, { project: p });
  const { calls, executors } = makeFakes();
  await startRun(p, "mug-lookbook", { actor: "t", detach: false, executors });
  assert.equal(calls.filter((c: string[]) => c[0] === "edit").length, 3);
  await editGraph("mug-lookbook", [{ op: "set", node: "look", settings: { preset: "hero-3d" } }], { project: p });
  const snap = (await getGraph("mug-lookbook", { project: p })).snapshot as string;
  assert.match(snap, /draft {2}generate {2}stale/);
  assert.match(snap, /warm {2}edit {2}current \(upstream draft out of date\)/);
  await startRun(p, "mug-lookbook", { actor: "t", detach: false, executors, scope: "draft+" });
  assert.equal(calls.length, 12);
  const { state } = await readBoth(graphDir(p, "mug-lookbook"));
  const old = state.nodes.draft.takes[0];
  await editGraph("mug-lookbook", [{ op: "select", take: `draft/${old.id}` }], { project: p });
  const node = (await getGraph("mug-lookbook", { project: p, node: "draft" })).node as any;
  assert.equal(node.slots[0].take, old.id);
  assert.equal(node.slots[0].status, "pinned");
});

test("several processes editing one graph at once never lose or corrupt a write", async () => {
  const p = project();
  await createGraph({ name: "Busy" }, { project: p });
  const writers = ["a", "b", "c", "d", "e"].map(w => new Promise<number>((res, rej) => {
    const c = spawn(process.execPath, [fixture("studio-writer.mjs"), p, "busy", w, "6"], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", d => (err += d));
    c.on("exit", code => (code === 0 ? res(code) : rej(new Error(err))));
  }));
  await Promise.all(writers);
  const dir = graphDir(p, "busy");
  const { graph, state } = await readBoth(dir);
  assert.equal(graph.nodes.length, 30);
  assert.equal(graph.revision, 31);
  const seqs = (await readEvents(dir, 0, 1000)).map(e => e.seq);
  assert.equal(new Set(seqs).size, seqs.length, "event seqs are unique");
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.ok(state.eventSeq >= seqs.at(-1)!);
  assert.equal(readdirSync(dir).filter(f => f.includes(".tmp-") || f.startsWith(".lock")).length, 0);
});

test("a killed run is reported interrupted, refuses a second run while alive, and resumes without redoing finished slots", async () => {
  const p = project();
  await createGraph({ ...lookbook, nodes: lookbook.nodes.map(n => (n.ref === "surfaces" ? { ...n, settings: { items: ["a", "b", "c", "d", "e", "f"] } } : n)) }, { project: p });
  const dir = graphDir(p, "mug-lookbook");
  const child = spawn(process.execPath, [fixture("studio-worker.mjs"), p, "mug-lookbook", "500"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    const { state } = await readBoth(dir);
    if ((state.nodes.draft?.takes.length ?? 0) >= 2) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const busy = await refusal(startRun(p, "mug-lookbook", { actor: "t", detach: false, executors: makeFakes().executors }), "RUN_ACTIVE");
  assert.match(busy.fix!, /studio_status/);
  child.kill("SIGKILL");
  await new Promise(r => child.on("exit", r));
  const done = (await readBoth(dir)).state.nodes.draft.takes.length;
  assert.ok(done >= 2 && done < 6, `killed mid-run with ${done} takes`);
  const st = await runStatus(p, "mug-lookbook");
  assert.equal(st.status, "interrupted");
  const { calls, executors } = makeFakes();
  const resumed = await startRun(p, "mug-lookbook", { actor: "t", detach: false, executors, resume: true });
  assert.equal(resumed.status, "done");
  assert.equal(calls.length, 6 - done);
  const { state } = await readBoth(dir);
  assert.equal(state.nodes.draft.takes.length, 6);
  assert.equal(new Set(state.nodes.draft.takes.map(t => t.fingerprint)).size, 6);
  assert.equal(existsSync(join(dir, "run.lock")), false);
});

test("a quota error stops the run cleanly with a resumable state", async () => {
  const p = project();
  await createGraph(lookbook, { project: p });
  const { executors } = makeFakes({ fail: (_x: unknown, calls: unknown[]) => { if (calls.length === 1) throw new Error("subscription request failed: 429 rate limited"); } });
  const r = await startRun(p, "mug-lookbook", { actor: "t", detach: false, executors });
  assert.equal(r.status, "stopped");
  const st = await statusReport("mug-lookbook", { project: p });
  assert.match(st.text as string, /Resume with studio_run/);
  assert.equal((st as any).record.progress.slotsDone, 1);
  const again = makeFakes();
  await startRun(p, "mug-lookbook", { actor: "t", detach: false, executors: again.executors, resume: true });
  assert.equal(again.calls.length, 2);
});

test("handoff packages only approved images, with measured colours and lineage; implementation compares", async () => {
  const p = project();
  await createGraph({
    name: "Hero",
    nodes: [
      { ref: "ref", type: "reference", settings: { path: "images/ref.png", role: "style" } },
      { ref: "gen", type: "generate", settings: { prompt: "a hero illustration" } },
      { ref: "cut", type: "process", settings: { op: "remove-background" } },
      { ref: "hand", type: "handoff", settings: { intent: "Landing hero", target: "Next.js hero", must_match: ["warm palette"] } },
    ],
    connections: [{ from: "ref", to: "gen", to_handle: "references" }, { from: "gen", to: "cut" }, { from: "gen", to: "hand" }],
  }, { project: p });
  const { executors } = makeFakes();
  const r = await startRun(p, "hero", { actor: "t", detach: false, executors });
  assert.equal(r.status, "done");
  const pre = await getGraph("hero", { project: p });
  assert.match(pre.snapshot as string, /no approved image reaches this handoff/);
  const dir = graphDir(p, "hero");
  const take = (await readBoth(dir)).state.nodes.gen.takes[0];
  await editGraph("hero", [{ op: "approve", take: `gen/${take.id}`, note: "this one" }], { project: p, actor: "marko", human: true });
  await startRun(p, "hero", { actor: "t", detach: false, executors, scope: "hand" });
  const md = readFileSync(join(dir, "handoff", "hand", "handoff.md"), "utf8");
  assert.match(md, /## Intent\n\nLanding hero/);
  assert.match(md, /mock-1\.png`: 48x32/);
  assert.match(md, /approved by marko \("this one"\)/);
  assert.match(md, /not design tokens/);
  assert.match(md, /#[0-9a-f]{6}/i);
  assert.match(md, /ref\/t\d+ \(reference, as style\) from images\/ref\.png/);
  const manifest = JSON.parse(readFileSync(join(dir, "handoff", "hand", "manifest.json"), "utf8"));
  assert.equal(manifest.cutouts.length, 1);
  writeFileSync(join(p, "shot.png"), fakePng("build", 96, 64));
  await editGraph("hero", [{ op: "add", id: "build", type: "implementation", settings: { screenshot: "shot.png" } }, { op: "connect", from: "hand", to: "build" }], { project: p });
  await startRun(p, "hero", { actor: "t", detach: false, executors, scope: "build" });
  const impl = (await readBoth(dir)).state.nodes.build.takes[0];
  assert.ok(impl.files?.[0]?.endsWith("-compare.png"));
  assert.ok(existsSync(join(dir, impl.files![0]!)));
  const feedback = readFileSync(join(dir, "feedback.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  assert.equal(feedback[0].action, "approve");
  assert.equal(feedback[0].by, "marko");
});

test("files store only relative paths, and a moved project still resolves and stays cached", async () => {
  const p = project();
  const outside = mkdtempSync(join(tmpdir(), "studio-outside-"));
  writeFileSync(join(outside, "far.png"), fakePng("far"));
  await createGraph({ ...lookbook, nodes: [...lookbook.nodes, { ref: "far", type: "reference", settings: { path: join(outside, "far.png") } }], connections: [...lookbook.connections, { from: "far", to: "draft", to_handle: "references" }] }, { project: p });
  await startRun(p, "mug-lookbook", { actor: "t", detach: false, executors: makeFakes().executors });
  const dir = graphDir(p, "mug-lookbook");
  for (const f of ["graph.json", "state.json", "events.jsonl"]) {
    const text = readFileSync(join(dir, f), "utf8");
    assert.doesNotMatch(text, /[A-Za-z]:[\\/]|"\/(tmp|Users|home)\//, `${f} has an absolute path`);
  }
  const moved = mkdtempSync(join(tmpdir(), "studio-moved-"));
  cpSync(p, moved, { recursive: true });
  const { graph, state } = await readBoth(graphDir(moved, "mug-lookbook"));
  const evals = await evaluate(graph, state, { dir: graphDir(moved, "mug-lookbook"), project: moved });
  assert.equal(evals.get("draft")!.status, "current");
  assert.equal((await runGraph("mug-lookbook", { dryRun: true }, { project: moved })).plan.generations, 0);
});

test("viewer serves only files inside a graph's served folders", async () => {
  const p = project();
  await createGraph(lookbook, { project: p });
  await startRun(p, "mug-lookbook", { actor: "t", detach: false, executors: makeFakes().executors });
  const take = (await readBoth(graphDir(p, "mug-lookbook"))).state.nodes.draft.takes[0];
  assert.ok(safeFile(p, "mug-lookbook", take.asset));
  for (const bad of ["graph.json", "../mug-lookbook/graph.json", "assets/../graph.json", "assets/../../../images/ref.png", "C:/Windows/win.ini", "/etc/passwd", "runs/x.json"]) {
    assert.equal(safeFile(p, "mug-lookbook", bad), null, bad);
  }
  assert.equal(safeFile(p, "../x", take.asset), null);
});

test("view writes previews and the guide documents every node type", async () => {
  const p = project();
  await createGraph(lookbook, { project: p });
  await startRun(p, "mug-lookbook", { actor: "t", detach: false, executors: makeFakes().executors });
  const v = await viewGraph("mug-lookbook", { project: p });
  assert.equal(v.images.length, 3);
  assert.ok(v.images.every((i: any) => i.preview && existsSync(i.preview)));
  const g = guide();
  for (const t of ["prompt", "style", "list", "reference", "generate", "edit", "process", "gallery", "handoff", "implementation", "note"]) assert.match(g, new RegExp(`## ${t}\\n`));
  assert.match(g, /quality low/);
});

test("takes carry a reading, request deviations and a checklist; an agent must look before approving", async () => {
  const p = project();
  await createGraph({
    name: "Craft",
    nodes: [{ ref: "gen", type: "generate", settings: { prompt: "a moody low-key portrait lit by warm candle light, with a brass lamp" } }],
    connections: [],
  }, { project: p });
  const { executors } = makeFakes();
  const { encodePng } = await import("../dist/bgremove.js");
  // A bright, cool image: the opposite of what the prompt asks for.
  executors.generate = async (x: any) => {
    const w = 64, h = 64, data = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set([170, 205, 245, 255], i * 4);
    const path = `${x.outBase}.png`;
    writeFileSync(path, encodePng({ width: w, height: h, data }));
    return { path, generations: 1, compiledPrompt: x.slot.text };
  };
  const r = await startRun(p, "craft", { actor: "t", detach: false, executors });
  assert.equal(r.status, "done");
  const dir = graphDir(p, "craft");
  const take = (await readBoth(dir)).state.nodes.gen.takes[0];
  assert.equal(take.reading?.source, "local");
  assert.equal(take.reading?.version, 1);
  const devs = (take.deviations ?? []).map((d: any) => d.measure).sort();
  assert.deepEqual(devs, ["key", "temperature"], JSON.stringify(take.deviations));
  assert.ok(take.checklist!.some((c: any) => /brass lamp/.test(c.question)), JSON.stringify(take.checklist));
  assert.ok(take.checklist!.some((c: any) => c.from === "defects"));
  const rec = JSON.parse(readFileSync(join(dir, "runs", `${r.job}.json`), "utf8"));
  assert.ok(rec.sheet && existsSync(join(dir, rec.sheet)), rec.sheet);

  const e = await refusal(editGraph("craft", [{ op: "approve", take: `gen/${take.id}` }], { project: p }), "NO_LOOK");
  assert.match(e.fix ?? "", /op:"answer"/);
  await refusal(editGraph("craft", [{ op: "answer", take: `gen/${take.id}`, answers: { c99: "yes" } }], { project: p }), "BAD_OP");
  await editGraph("craft", [
    { op: "answer", take: `gen/${take.id}`, answers: { c1: "no", c2: { answer: "unsure", note: "small" } } },
    { op: "approve", take: `gen/${take.id}` },
  ], { project: p });
  const after = (await readBoth(dir)).state.nodes.gen.takes[0];
  assert.equal(after.checklist![0].answer, "no");
  assert.equal(after.checklist![1].note, "small");
  assert.equal(after.verdict?.decision, "approved");
  // A person approves without a recorded look.
  await editGraph("craft", [{ op: "clear_verdict", take: `gen/${take.id}` }], { project: p });
  await startRun(p, "craft", { actor: "t", detach: false, executors, newTake: true });
  const second = (await readBoth(dir)).state.nodes.gen.takes[1];
  await editGraph("craft", [{ op: "approve", take: `gen/${second.id}` }], { project: p, actor: "marko", human: true });
  await editGraph("craft", [{ op: "critique", take: `gen/${second.id}`, summary: "same flat blue as t1", against: `gen/${take.id}`, preferred: `gen/${take.id}` }], { project: p });
  assert.equal((await readBoth(dir)).state.nodes.gen.takes[1].critiques[0].preferred, `gen/${take.id}`);
});

test("a live holder that stalls past the stale limit keeps its lock; release deletes only its own lock", async () => {
  const p = project();
  await createGraph({ name: "Locky", nodes: [{ ref: "a", type: "prompt", settings: { text: "x" } }], connections: [] }, { project: p });
  const dir = graphDir(p, "locky");
  const env = { ...process.env, GPT_IMAGE_STUDIO_LOCK_STALE_MS: "200" };
  const run = (hold: string, name: string) => spawn(process.execPath, [fixture("studio-slowlock.mjs"), dir, hold, name], { stdio: ["ignore", "pipe", "inherit"], env });
  const exited = (c: ReturnType<typeof spawn>) => new Promise<number | null>(res => c.on("exit", res));
  const slow = run("1500", "slow");
  const slowDone = exited(slow);
  await new Promise<void>(res => slow.stdout!.once("data", () => res()));
  const t0 = Date.now();
  const fast = run("0", "fast");
  assert.equal(await exited(fast), 0);
  // The second writer waited for the live holder instead of stealing the lock after 200 ms.
  assert.ok(Date.now() - t0 > 900, `waited ${Date.now() - t0} ms`);
  assert.equal(await slowDone, 0);
  const { state } = await readBoth(dir);
  assert.ok(state.nodes.slow && state.nodes.fast, `both writes kept: ${Object.keys(state.nodes)}`);
  const { releaseLock, paths } = await import("../dist/studio/store.js");

  const lock = paths(dir).lock;
  writeFileSync(lock, JSON.stringify({ token: "peer", pid: 1, host: "h", actor: "p", at: "" }));
  await releaseLock(lock, "mine");
  assert.ok(existsSync(lock), "a peer's lock is left alone");
  writeFileSync(lock, "");
  await releaseLock(lock, "mine");
  assert.ok(existsSync(lock), "an unreadable lock (a peer mid-write) is left alone");
  writeFileSync(lock, JSON.stringify({ token: "mine", pid: process.pid, host: "h", actor: "me", at: "" }));
  await releaseLock(lock, "mine");
  assert.ok(!existsSync(lock));
});

test("a run started over MCP finishes after the MCP server is closed the way ToolHub closes it", async () => {
  const p = project();
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: process.execPath, args: [fixture("../../dist/mcp.js")], cwd: p, stderr: "ignore",
    env: { ...process.env, GPT_IMAGE_STUDIO_CLI: fixture("studio-fake-cli.mjs"), FAKE_DELAY_MS: "1200" } as Record<string, string>,
  });
  const client = new Client({ name: "studio-close-test", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: { project: p, ...args } });
    assert.ok(!r.isError, r.content?.[0]?.text);
    return r.content[0].text as string;
  };
  await call("studio_create", { name: "Survive", nodes: [
    { ref: "subj", type: "prompt", settings: { text: "a {{item}} cup" } },
    { ref: "kinds", type: "list", settings: { items: ["red", "green", "blue"] } },
    { ref: "gen", type: "generate" }], connections: [{ from: "subj", to: "kinds" }, { from: "kinds", to: "gen" }] });
  const started = await call("studio_run", { graph: "survive", wait_seconds: 0 });
  const job = /r\d{8}-\d{6}-[0-9a-f]{4}/.exec(started)![0];
  const serverPid = transport.pid!;
  await client.close(); // stdin end, then SIGTERM: what the SDK client close (and so ToolHub) does
  const { pidAlive } = await import("../dist/studio/store.js");
  assert.equal(pidAlive(serverPid), false, "the MCP server is gone");
  const dir = graphDir(p, "survive");
  const before = JSON.parse(readFileSync(join(dir, "runs", `${job}.json`), "utf8"));
  assert.ok(before.progress.slotsDone < 3, `still mid-run when the server closed (${before.progress.slotsDone}/3)`);
  let rec: any;
  for (let i = 0; i < 100; i++) {
    rec = JSON.parse(readFileSync(join(dir, "runs", `${job}.json`), "utf8"));
    if (!["starting", "running"].includes(rec.status)) break;
    await new Promise(r => setTimeout(r, 200));
  }
  assert.equal(rec.status, "done", JSON.stringify(rec.errors));
  assert.equal(rec.takes.length, 3);
  assert.notEqual(rec.pid, serverPid, "the worker is its own process");
});

test("an image-cap 429 names its reset time in the provider error and the run's stop fix", async () => {
  const { usageLimitNote } = await import("../dist/providers/subscription.js");
  const now = Date.parse("2026-11-28T10:00:00Z");
  const body = JSON.stringify({ error: { type: "usage_limit_reached", message: "limit", resets_at: now / 1000 + 5400, resets_in_seconds: 5400 } });
  const note = usageLimitNote(body, now)!;
  assert.equal(note, "Usage limit (usage_limit_reached): resets at 2026-11-28T11:30:00.000Z (in 1h 30m).");
  assert.equal(usageLimitNote(JSON.stringify({ error: { resets_in_seconds: 60 } }), now), "Usage limit: resets at 2026-11-28T10:01:00.000Z (in 0h 1m).");
  assert.equal(usageLimitNote("not json"), undefined);
  const p = project();
  await createGraph(lookbook, { project: p });
  const { executors } = makeFakes({ fail: () => { throw new Error(`subscription image request failed: HTTP 429 — ${note} ${body}`); } });
  const r = await startRun(p, "mug-lookbook", { actor: "t", detach: false, executors });
  assert.equal(r.status, "stopped");
  const rec = JSON.parse(readFileSync(join(graphDir(p, "mug-lookbook"), "runs", `${r.job}.json`), "utf8"));
  assert.match(rec.stopFix, /resets at 2026-11-28T11:30:00\.000Z \(in 1h 30m\)/);
});

test("a sweep varies one look dimension per slot, reuses unchanged values and refuses a list", async () => {
  const p = project();
  const values = ["from camera left", "backlight", "top light"];
  await createGraph({ name: "Sweep", nodes: [{ ref: "gen", type: "generate", settings: { prompt: "a glass bottle", shot: { lens: "85mm" }, sweep: { dim: "shot.key_light", values } } }], connections: [] }, { project: p });
  const fakes = makeFakes();
  const r = await startRun(p, "sweep", { actor: "t", detach: false, executors: fakes.executors });
  assert.equal(r.status, "done");
  assert.equal(fakes.calls.length, 3);
  const dir = graphDir(p, "sweep");
  const takes = (await readBoth(dir)).state.nodes.gen.takes;
  assert.deepEqual(takes.map((t: any) => t.settings.shot.key_light), values);
  assert.ok(takes.every((t: any) => t.settings.shot.lens === "85mm"));
  const sheet = JSON.parse(readFileSync(join(dir, JSON.parse(readFileSync(join(dir, "runs", `${r.job}.json`), "utf8")).sheet + ".json"), "utf8"));
  assert.deepEqual(sheet.items.map((i: any) => i.detail), values.map(v => `shot.key_light: ${v}`));
  await editGraph("sweep", [{ op: "set", node: "gen", settings: { sweep: { dim: "shot.key_light", values: ["from camera left", "rim light", "top light"] } } }], { project: p });
  const again = makeFakes();
  await startRun(p, "sweep", { actor: "t", detach: false, executors: again.executors });
  assert.equal(again.calls.length, 1, "only the changed value renders");
  const bad = await refusal(editGraph("sweep", [{ op: "set", node: "gen", settings: { sweep: { dim: "shot.keylight", values: ["a", "b"] } } }], { project: p }), "BAD_SETTINGS");
  assert.match(String(bad.issues?.[0]?.message), /Did you mean "shot.key_light"/);
  // Review 2 #3: a sweep on a list-fed generator is refused when the edit is made, in either order.
  const fan = await refusal(editGraph("sweep", [
    { op: "set", node: "gen", settings: { prompt: null } },
    { op: "add", id: "kinds", type: "list", settings: { items: ["red", "blue"] } },
    { op: "connect", from: "kinds", to: "gen" },
  ], { project: p }), "SWEEP_FANOUT");
  assert.match(fan.message, /a sweep needs a single prompt, but its prompt comes from list "kinds"/);
  assert.match(fan.fix ?? "", /\{op:"disconnect", from:"kinds", to:"gen"\}/);
  await editGraph("sweep", [{ op: "set", node: "gen", settings: { sweep: null, prompt: null } }, { op: "add", id: "kinds", type: "list", settings: { items: ["red", "blue"] } }, { op: "connect", from: "kinds", to: "gen" }], { project: p });
  await refusal(editGraph("sweep", [{ op: "set", node: "gen", settings: { sweep: { dim: "shot.lens", values: ["35mm", "85mm"] } } }], { project: p }), "SWEEP_FANOUT");
});

test("a canon entry saved in one project is used from another; its description reaches the compiled prompt verbatim", async () => {
  const a = project();
  await createGraph({ name: "Source", nodes: [{ ref: "gen", type: "generate", settings: { prompt: "a teapot" } }], connections: [] }, { project: a });
  await startRun(a, "source", { actor: "t", detach: false, executors: makeFakes().executors });
  const description = "Mira the teapot: small and round, deep cobalt glaze, cream lid knob, a hairline chip on the spout.";
  await refusal(editGraph("source", [{ op: "canon_save", name: "mira", takes: ["gen/t1"], description }], { project: a }), "NOT_APPROVED");
  await editGraph("source", [{ op: "approve", take: "gen/t1" }, { op: "canon_save", name: "mira", kind: "character", takes: ["gen/t1"], description }], { project: a, human: true });
  await refusal(editGraph("source", [{ op: "canon_save", name: "mira", takes: ["gen/t1"], description: "other" }], { project: a }), "CANON_EXISTS");
  const listed = await (await import("../dist/studio/api.js")).listGraphs({ project: a });
  assert.equal((listed as any).canon[0].name, "mira");

  const b = project();
  await createGraph({ name: "User", nodes: [
    { ref: "mira", type: "canon", settings: { name: "mira", project: a } },
    { ref: "gen", type: "generate", settings: { prompt: "on a sunny windowsill" } },
  ], connections: [{ from: "mira", to: "gen", to_handle: "references" }] }, { project: b });
  const gdir = graphDir(b, "user");
  const graph = JSON.parse(readFileSync(join(gdir, "graph.json"), "utf8"));
  assert.ok(!/^[A-Za-z]:|^\//.test(graph.nodes.find((n: any) => n.id === "mira").settings.project), "stored relative");
  const fakes = makeFakes();
  await startRun(b, "user", { actor: "t", detach: false, executors: fakes.executors });
  const take = (await readBoth(gdir)).state.nodes.gen.takes[0];
  assert.ok(take.text.prompt.includes(description), take.text.prompt);
  assert.equal(take.inputs.find((i: any) => i.handle === "references").role, "subject");
  // The real compiler (no network): the description survives verbatim into the compiled prompt.
  const { readBoth: rb } = await import("../dist/studio/store.js");
  const { state, graph: g2 } = await rb(gdir);
  const ev = (await evaluate(g2, state, { dir: gdir, project: b })).get("gen")!;
  const { previewImageRequest } = await import("../dist/generate.js");
  const pre = await previewImageRequest({ subject: ev.slots[0]!.text, references: ev.slots[0]!.refs.map((r: any) => ({ path: join(gdir, r.asset), role: r.role })), backend: "subscription", imageModel: "auto", quality: "low", format: "png" } as any);
  assert.ok(pre.compiledPrompt.includes(description), pre.compiledPrompt);

  await editGraph("source", [{ op: "canon_save", name: "mira", takes: ["gen/t1"], description: description + " Always smiling.", replace: true }], { project: a });
  assert.equal(readdirSync(join(a, ".gptimage", "studio", "_canon", "mira", "history")).length, 1);
  const again = makeFakes();
  await startRun(b, "user", { actor: "t", detach: false, executors: again.executors });
  assert.equal(again.calls.length, 1, "a replaced description re-renders the user");
  assert.ok((await readBoth(gdir)).state.nodes.gen.takes[1].text.prompt.includes("Always smiling."));
});

test("lessons need two takes and are superseded, not edited; taste and calibration come back with create", async () => {
  const home = mkdtempSync(join(tmpdir(), "studio-home-"));
  process.env.GPT_IMAGE_STUDIO_HOME = home;
  try {
    const p = project();
    await createGraph({ name: "Mem", nodes: [{ ref: "gen", type: "generate", settings: { prompt: "a glass bottle", takes: 3, shot: { key_light: "backlight" } } }], connections: [] }, { project: p });
    await startRun(p, "mem", { actor: "t", detach: false, executors: makeFakes().executors });
    await refusal(editGraph("mem", [{ op: "lesson", claim: "x", dimension: "shot.key_light", takes: ["gen/t1"] }], { project: p }), "ONE_TAKE");
    const first = await editGraph("mem", [{ op: "lesson", claim: "backlight makes glass glow", dimension: "shot.key_light", takes: ["gen/t1", "gen/t2"] }], { project: p });
    const id = /lesson (l[a-z0-9]+)/.exec(first.applied[0]!)![1]!;
    await editGraph("mem", [{ op: "lesson", claim: "backlight makes glass glow but hides the label", dimension: "shot.key_light", takes: ["gen/t1", "gen/t2", "gen/t3"], supersedes: id }], { project: p });
    await refusal(editGraph("mem", [{ op: "lesson", claim: "y", dimension: "d", takes: ["gen/t1", "gen/t2"], supersedes: id }], { project: p }), "ALREADY_SUPERSEDED");
    await editGraph("mem", [{ op: "lesson", claim: "users like warm light", dimension: "temperature", takes: ["gen/t1", "gen/t3"], scope: "user" }], { project: p });
    const { activeLessons, allLessons } = await import("../dist/studio/memory.js");
    assert.equal((await allLessons(p)).length, 3, "the superseded lesson is kept");
    const active = await activeLessons(p);
    assert.deepEqual(active.map((l: any) => l.claim).sort(), ["backlight makes glass glow but hides the label", "users like warm light"]);
    assert.equal(active[0]!.support, 3, "most supported first");
    assert.ok(existsSync(join(home, ".gptimage", "studio", "_lessons")), "user lessons live in the user store");

    // Calibration: predictions before the person's decision count; one after does not.
    await editGraph("mem", [{ op: "predict", take: "gen/t1", decision: "approved", reason: "clean glow" }, { op: "predict", take: "gen/t2", decision: "rejected", reason: "flat" }], { project: p, actor: "agent-a" });
    await editGraph("mem", [{ op: "approve", take: "gen/t1" }, { op: "approve", take: "gen/t2" }, { op: "reject", take: "gen/t3" }], { project: p, actor: "marko", human: true });
    await editGraph("mem", [{ op: "predict", take: "gen/t3", decision: "rejected", reason: "late" }], { project: p, actor: "agent-a" });
    const { calibration, tasteSummary } = await import("../dist/studio/memory.js");
    const cal = await calibration(p);
    assert.deepEqual(cal.project, { agree: 1, total: 2 });
    assert.deepEqual(cal.overall, { agree: 1, total: 2 });
    const taste = await tasteSummary(p);
    assert.match(taste[0]!, /From 3 human decision/);
    assert.ok(taste.some((l: string) => /shot\.key_light "backlight": kept 2 of 3/.test(l)), taste.join("\n"));
    const created = await createGraph({ name: "Next", nodes: [{ ref: "a", type: "prompt", settings: { text: "x" } }], connections: [] }, { project: p });
    assert.match(created.snapshot, /Lessons \(most supported first/);
    assert.match(created.snapshot, /hides the label/);
    assert.match(created.snapshot, /matched the person's later decision: 1 of 2 here, 1 of 2 overall/);
  } finally { delete process.env.GPT_IMAGE_STUDIO_HOME; }
});

test("study returns the reading and vision shot language as a ready style node, and degrades to the reading", async () => {
  const p = project();
  const { studyImage } = await import("../dist/studio/api.js");
  const ask = async (_imgs: unknown, q: string) => {
    assert.match(q, /key_light/);
    return 'Sure: {"key_light":"soft window light from camera left","palette":"warm creams","bogus":"x","lens":""}';
  };
  const r = await studyImage("images/ref.png", { project: p, ask });
  assert.deepEqual(r.shot, { key_light: "soft window light from camera left", palette: "warm creams" });
  assert.equal(r.op.type, "style");
  assert.match(r.text, /Measured: .*key/);
  assert.match(r.text, /Ready to use: \{"op":"add"/);
  await createGraph({ name: "Use", nodes: [{ ref: "look", type: "style", settings: r.op.settings }], connections: [] }, { project: p });
  const failed = await studyImage("images/ref.png", { project: p, ask: async () => { throw new Error("offline"); } });
  assert.deepEqual(failed.shot, {});
  assert.match(failed.text, /Vision description failed \(offline\)/);
  await refusal(studyImage("images/nope.png", { project: p }), "NO_FILE");
});

test("every recipe builds a valid graph that plans a run; bad recipe input names its fix", async () => {
  const p = project();
  const { RECIPE_NAMES } = await import("../dist/studio/recipes.js");
  for (const recipe of RECIPE_NAMES) {
    const c = await createGraph({ name: `R ${recipe}`, recipe, subject: "a ceramic teapot", path: "images/ref.png" } as any, { project: p });
    assert.match(c.snapshot, new RegExp(`Recipe "${recipe}"`));
    const plan: any = await startRun(p, c.slug, { actor: "t", detach: false, dryRun: true });
    assert.ok(plan.plan.generations > 0 || plan.plan.localSteps > 0, `${recipe}: ${JSON.stringify(plan.plan)}`);
  }
  await refusal(createGraph({ name: "x", recipe: "nope", subject: "s" } as any, { project: p }), "NO_RECIPE");
  await refusal(createGraph({ name: "y", recipe: "lookbook" } as any, { project: p }), "BAD_INPUT");
  await refusal(createGraph({ name: "z", recipe: "product-set", subject: "s" } as any, { project: p }), "BAD_INPUT");
  // The lookbook flows once an anchor is picked.
  const fakes = makeFakes();
  await startRun(p, "r-lookbook", { actor: "t", detach: false, executors: fakes.executors, scope: "thumbs" });
  await editGraph("r-lookbook", [{ op: "pick", node: "anchor", takes: ["thumbs/t2"] }], { project: p });
  const r: any = await startRun(p, "r-lookbook", { actor: "t", detach: false, executors: fakes.executors });
  assert.equal(r.status, "done");
  assert.equal((await readBoth(graphDir(p, "r-lookbook"))).state.nodes.variants.takes.length, 2);
  assert.match(guide("recipes"), /Composition: many low-quality thumbnails/);
});

test("review 2 #1: set merges shot/style/brief key by key, null removes one key, and the result says what was kept", async () => {
  const p = project();
  await createGraph({ name: "Merge", nodes: [{ ref: "look", type: "style", settings: { preset: "product-studio", shot: { lens: "85mm", aperture: "f/2", grade: "cool" } } }], connections: [] }, { project: p });
  const r = await editGraph("merge", [{ op: "set", node: "look", settings: { shot: { grade: "warm print", aperture: null } } }], { project: p });
  const look = (await readBoth(graphDir(p, "merge"))).graph.nodes[0].settings;
  assert.deepEqual(look.shot, { lens: "85mm", grade: "warm print" });
  assert.equal(look.preset, "product-studio");
  assert.equal(r.applied[0], "look: set shot.grade; removed shot.aperture; kept shot.lens");
  const r2 = await editGraph("merge", [{ op: "set", node: "look", settings: { preset: null } }], { project: p });
  assert.equal(r2.applied[0], "look: removed preset");
});

test("review 2 #2: a dry run lists nodes it skips with their fix, and Next says to fix them first", async () => {
  const p = project();
  const c = await createGraph({ name: "Broken", nodes: [{ ref: "gen", type: "generate", settings: { quality: "low" } }, { ref: "pick", type: "gallery" }], connections: [{ from: "gen", to: "pick" }] }, { project: p });
  assert.match(c.snapshot, /Next:\n  Fix gen first/);
  assert.doesNotMatch(c.snapshot, /studio_run \{graph:"broken"\} renders/);
  const r: any = await startRun(p, "broken", { actor: "t", detach: false, dryRun: true });
  assert.match(r.message, /Skipped gen: generate needs a prompt\. Fix: Connect a prompt/);
  assert.match(r.message, /Nothing in scope can run until the skipped nodes are fixed/);
});

test("review 2 #4: overlays draw on images without a stored reading, and unknown overlays are refused", async () => {
  const { reviewSheet } = await import("../dist/studio/craft.js");
  const { encodePng } = await import("../dist/bgremove.js");
  const { decodeRGBA } = await import("../dist/imageops.js");
  const dir = mkdtempSync(join(tmpdir(), "studio-overlay-"));
  const data = Buffer.alloc(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) data.set([220, 30, 30, 255], i * 4);
  writeFileSync(join(dir, "red.png"), encodePng({ width: 64, height: 64, data }));
  const px = (img: any, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
  // Cell geometry: pad 14, image 420x420 at (14,14), strip from y = 14 + 420 + 4.
  const only = await decodeRGBA(readFileSync(await reviewSheet([{ path: join(dir, "red.png"), title: "red" }], join(dir, "p.png"), ["palette"])));
  const strip = px(only, 40, 446);
  assert.ok(strip[0]! > 180 && strip[1]! < 80, `palette strip is red: ${strip}`);
  const all = await decodeRGBA(readFileSync(await reviewSheet([{ path: join(dir, "red.png"), title: "red" }], join(dir, "a.png"), ["grid", "palette", "histogram"])));
  const gridHits = [...Array(40).keys()].map(y => px(all, 153, 60 + y)).filter(c => c[0]! > 200 && c[1]! < 120 && c[2]! > 70);
  assert.ok(gridHits.length >= 10, `thirds grid line is drawn (${gridHits.length} of 40 px)`);
  assert.ok(px(all, 40, 446)[0]! > 180, "palette strip with histogram on");
  const hist = [...Array(40).keys()].map(i => px(all, 318 + i * 2.8 | 0, 450)).filter(c => Math.abs(c[0]! - c[1]!) < 10 && c[0]! < 235);
  assert.ok(hist.length >= 1, "a grey histogram bar is drawn");
  const p = project();
  await createGraph({ name: "Ov", nodes: [{ ref: "ref", type: "reference", settings: { path: "images/ref.png" } }], connections: [] }, { project: p });
  await refusal(viewGraph("ov", { project: p, overlays: ["reading"] as any }), "BAD_OVERLAY");
});
