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
