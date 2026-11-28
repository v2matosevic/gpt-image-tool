// Round 5: what the first real Studio run exposed. Letterbox bars measured and flagged, mixed
// temperature as one request, a checklist of real yes/no questions, a finish that changes the aspect
// warned in the plan, takes listed by slot. No provider calls: fakes only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameBars } from "../dist/imageqa.js";
import { promptQuestions, requestDeviations } from "../dist/studio/craft.js";
import { aspectNote, sameAspectSize } from "../dist/studio/render.js";
import { createGraph, editGraph, statusReport } from "../dist/studio/api.js";
import { startRun } from "../dist/studio/runner.js";
// @ts-ignore - plain JS fixture
import { makeFakes } from "./fixtures/studio-fakes.mjs";

function img(w: number, h: number, paint: (x: number, y: number) => [number, number, number, number]) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(paint(x, y), (y * w + x) * 4);
  return { width: w, height: h, data };
}
const noisy = (x: number, y: number): [number, number, number, number] => [(x * 37 + y * 11) % 200 + 40, (x * 13 + y * 29) % 180 + 50, (x * 7 + y * 17) % 160 + 60, 255];

test("letterbox and pillarbox bars are measured; margins, frame lines and transparency are not bars", () => {
  const letter = img(300, 200, (x, y) => (y < 14 || y >= 186 ? [0, 0, 0, 255] : noisy(x, y)));
  assert.deepEqual(frameBars(letter as any), { kind: "letterbox", top: 14, bottom: 14, left: 0, right: 0, colour: "#000000", picture: { width: 300, height: 172 } });
  const pillar = img(300, 200, (x, y) => (x < 20 || x >= 280 ? [8, 8, 10, 255] : noisy(x, y)));
  assert.equal(frameBars(pillar as any)?.kind, "pillarbox");
  // A centred logo on white: the edges are uniform but the boundary is not a straight line.
  const logo = img(300, 200, (x, y) => (Math.hypot(x - 150, y - 100) < 50 ? [80, 20, 140, 255] : [255, 255, 255, 255]));
  assert.equal(frameBars(logo as any), undefined);
  // A dark card with a thin gold frame line near the edge: the picture beyond the line is still dark.
  const framed = img(300, 200, (x, y) => (x === 18 || x === 281 ? [200, 150, 60, 255] : [10, 10, 14, 255]));
  assert.equal(frameBars(framed as any), undefined);
  // Transparent padding reads as black but is not a bar.
  const padded = img(300, 200, (x, y) => (y < 14 || y >= 186 ? [0, 0, 0, 0] : noisy(x, y)));
  assert.equal(frameBars(padded as any), undefined);
  // Bars on one edge only are a design, not a letterbox.
  const one = img(300, 200, (x, y) => (y < 14 ? [0, 0, 0, 255] : noisy(x, y)));
  assert.equal(frameBars(one as any), undefined);
});

const reading = (over: Record<string, unknown>) => ({
  version: 1, source: "local", width: 1536, height: 1024,
  palette: [{ hex: "#c08040", share: 0.3 }, { hex: "#30506a", share: 0.4 }, { hex: "#808080", share: 0.3 }],
  luminance: { mean: 30, median: 30, p5: 5, p95: 80, key: "low", histogram: [] }, contrast: { rms: 0.3, range: 70 },
  color: { warmth: 3, temperature: "neutral", chroma: 20, saturation: "moderate" },
  composition: { thirds: [], centroid: { x: 0.5, y: 0.5 }, heaviest: "centre", negativeSpace: 0.1 },
  sharpness: { thirds: [], sharpest: "centre", separation: 2 }, detail: { edgeDensity: 0.1 }, ...over,
});

test("warm and cool asked together is one mixed request; bars are a deviation unless asked for", () => {
  const street = "Wide cinematic shot of a street at blue hour, warm lit windows, muted teal and amber grade.";
  assert.deepEqual(requestDeviations(reading({}) as any, street).map(d => d.measure), [], "both temperatures are in the palette");
  const allWarm = reading({ palette: [{ hex: "#c08040", share: 0.9 }, { hex: "#808080", share: 0.1 }] });
  const d = requestDeviations(allWarm as any, street);
  assert.equal(d.length, 1);
  assert.equal(d[0]!.expected, "mixed warm and cool");
  const bars = reading({ frame: { kind: "letterbox", top: 74, bottom: 74, left: 0, right: 0, colour: "#000000", picture: { width: 1536, height: 876 } } });
  assert.match(requestDeviations(bars as any, street).find(x => x.measure === "frame")!.measured, /letterboxed: #000000 bars 74 px top, 74 px bottom; picture 1536x876 of 1536x1024/);
  assert.equal(requestDeviations(bars as any, `${street} Letterboxed with black bars.`).filter(x => x.measure === "frame").length, 0);
});

const PROMPTS = [
  "A woman in her thirties at a pottery wheel, both hands shaping a wet clay bowl, fingers clearly visible and covered in slip, looking down at her work with a slight smile. Late afternoon window light from camera right, 50mm lens at f/2, workshop shelves softly out of focus behind her. Natural documentary photograph.",
  "Top-down photograph of a wooden desk. Exactly five objects: a closed red notebook in the top left corner, a white coffee cup on a saucer in the top right corner, a pair of round wire glasses in the centre, a yellow pencil lying horizontally below the glasses, and a small potted succulent in the bottom left corner. Nothing else on the desk. Soft even daylight.",
  "A clean landing page mockup for a bike repair shop called 'Spoke & Chain', shown as a flat desktop screenshot. Top navigation with the links 'Services', 'Pricing', 'Book', 'Contact'. Hero headline 'Back on the road by Friday', a subheadline 'Same-week repairs for city bikes and e-bikes', and a dark green button labelled 'Book a repair'. Below, three cards titled 'Tune-up', 'Brake service', 'Wheel truing' with the prices '39 EUR', '25 EUR', '18 EUR'. White background, dark green accent, generous spacing.",
  "Character sheet of a friendly cartoon fox courier wearing a teal jacket and a small orange satchel. Three full-body views of the same character side by side on a plain light background: front view, side view, back view. Identical proportions, colours and outfit in all three. Flat colour illustration with clean outlines.",
  "Wide cinematic shot of a narrow rain-soaked street at blue hour. Foreground: a bicycle leaning on a lamp post, sharp. Midground: a person with a clear umbrella walking away from camera. Background: shopfronts with warm lit windows fading into mist. Wet cobblestones reflecting the lights. 35mm lens, anamorphic feel, muted teal and amber grade.",
  "A minimal flat logo mark for a studio called Version2: the numeral 2 formed from a single continuous ribbon that folds once, in solid deep violet on a white background, centred with generous margin. No text, no gradients, no shadows.",
];

test("the checklist asks only well-formed questions about checkable parts of the prompt", () => {
  const all = PROMPTS.map(p => promptQuestions(p).map(q => q.question));
  for (const q of all.flat()) {
    assert.match(q, /^(Is|Are|Does|Do|In) .+\?$/, q);
    assert.doesNotMatch(q, /show (shown|in|covered|with|and|the image)\b|\?\?|read as an? [A-Z]/, q);
  }
  assert.ok(all[0]!.includes("Are both hands visible?"));
  assert.deepEqual(all[1]!.filter(q => /^Is the /.test(q)), [
    "Is the closed red notebook in the top left corner?", "Is the white coffee cup on a saucer in the top right corner?",
    "Is the pair of round wire glasses in the centre?", "Is the yellow pencil lying horizontally below the glasses?",
    "Is the small potted succulent in the bottom left corner?"]);
  assert.ok(all[1]!.includes("Are there exactly five objects?"));
  assert.ok(all[2]!.some(q => q.includes('"Tune-up", "Brake service", "Wheel truing", "39 EUR", "25 EUR", "18 EUR"')));
  assert.ok(all[3]!.includes("Are there exactly three full-body views?"));
  assert.ok(!all[3]!.some(q => /In the background/.test(q)), "a background colour is not a labelled layer");
  assert.ok(all[4]!.includes("In the foreground, is there a bicycle leaning on a lamp post?"));
  assert.deepEqual(all[5]!.filter(q => q.startsWith("Is it free of")), ["Is it free of text?", "Is it free of gradients?", "Is it free of shadows?"]);
  for (const qs of all) assert.ok(qs.length <= 10);
});

test("a finish that changes the aspect is warned in the plan, naming the nearest same-aspect size", async () => {
  assert.equal(sameAspectSize(1536, 1024, 3840), "3520x2352");
  assert.match(aspectNote("3840x2160", 1536, 1024)!, /aspect 1\.78 but the draft \(1536x1024\) has 1\.50.*nearest size with the draft's aspect is 3520x2352/);
  assert.equal(aspectNote("2048x1360", 1536, 1024), undefined, "within 2 percent is the same aspect");
  const p = mkdtempSync(join(tmpdir(), "studio-review-"));
  writeFileSync(join(p, ".secrets"), "OPENAI_API_KEY=sk-test-review-000\n");
  await createGraph({ name: "asp", nodes: [
    { ref: "d", type: "generate", settings: { prompt: "a cup", renderer: "api", model: "flare", quality: "low", size: "1536x1024" } },
    { ref: "f", type: "finish", settings: { size: "3840x2160" } },
  ], connections: [{ from: "d", to: "f" }] }, { project: p });
  const fakes = makeFakes(); // fake drafts are 48x32, the same 3:2 aspect
  await startRun(p, "asp", { actor: "t", detach: false, executors: fakes.executors, scope: "d" } as any);
  await editGraph("asp", [{ op: "approve", take: "d/t1" }], { project: p, human: true, actor: "owner" });
  const dry = await startRun(p, "asp", { actor: "t", dryRun: true } as any);
  assert.match(dry.message, /Note: f \(d\/t1\): 3840x2160 has aspect 1\.78 but the draft \(48x32\) has 1\.50.*3520x2352/);
  assert.doesNotMatch(dry.message, /Prompt for d /, "a cached slot's prompt is not printed");
});

test("status lists takes by slot with the item, and subscription takes say what made them", async () => {
  const p = mkdtempSync(join(tmpdir(), "studio-review-"));
  await createGraph({ name: "ord", nodes: [
    { ref: "items", type: "list", settings: { items: ["a red cup", "a blue bowl", "a green vase"] } },
    { ref: "g", type: "generate", settings: {} },
  ], connections: [{ from: "items", to: "g" }] }, { project: p });
  await startRun(p, "ord", { actor: "t", detach: false, concurrency: 3, executors: makeFakes({ delayMs: (i: number) => 30 - i * 10 }).executors } as any);
  const text = (await statusReport("ord", { project: p })).text;
  const order = [...text.matchAll(/^ {2}g\/t\d+ \(slot (\d)/gm)].map(m => Number(m[1]));
  assert.deepEqual(order, [1, 2, 3]);
  assert.match(text, /g\/t\d+ \(slot 2: a blue bowl\)/);
  assert.match(text, /subscription gpt-image-2 \(server-chosen\), saved \d+x\d+, no API cost/);
});

test("studio page: cases side by side with readable names, crops, costs and no verdicts; never overwrites a foreign page", async () => {
  const { pageGraph } = await import("../dist/studio/api.js");
  const { readFileSync, existsSync, mkdirSync } = await import("node:fs");
  const p = mkdtempSync(join(tmpdir(), "studio-review-"));
  writeFileSync(join(p, ".secrets"), "OPENAI_API_KEY=sk-test-page-000\n");
  await createGraph({ name: "page test", nodes: [
    { ref: "items", type: "list", settings: { items: ["A red cup on a table.", "A blue bowl, studio light."] } },
    { ref: "sub", type: "generate", settings: {} },
    { ref: "api", type: "generate", settings: { renderer: "api", model: "flare", quality: "low", size: "1536x1024" } },
  ], connections: [{ from: "items", to: "sub" }, { from: "items", to: "api" }] }, { project: p });
  await startRun(p, "page-test", { actor: "t", detach: false, executors: makeFakes().executors } as any);
  const { readBoth, graphDir } = await import("../dist/studio/store.js");
  const apiTake = (await readBoth(graphDir(p, "page-test"))).state.nodes.api!.takes[0]!.id;
  await editGraph("page-test", [{ op: "approve", take: `api/${apiTake}` }], { project: p, human: true, actor: "owner" });
  const r = await pageGraph("page-test", { project: p, out: "cmp", zoom: ["0,0,0.5,0.5=left corner", "2:0.5,0.5,0.5,0.5"] });
  const html = readFileSync(r.path, "utf8");
  assert.equal(r.cases, 2);
  assert.equal(r.images, 4);
  for (const f of ["img/01-a-red-cup-on-a-sub.png", "img/01-a-red-cup-on-a-api.png", "img/02-a-blue-bowl-studio-light-api-left-corner.png", "img/02-a-blue-bowl-studio-light-sub-crop2.png"]) assert.ok(existsSync(join(p, "cmp", f)), f);
  assert.ok(!existsSync(join(p, "cmp", "img/01-a-red-cup-on-a-sub-crop2.png")), "a case-limited crop only in its case");
  assert.equal((html.match(/<section /g) ?? []).length, 2);
  assert.equal((html.match(/<div class="row c2">/g) ?? []).length, 5, "two pairs, three crop pairs");
  assert.match(html, /<h2>1\. A red cup on a table\.<\/h2>/);
  assert.match(html, /\$0\.0305 from the usage the API reported \(1000 output tokens/);
  assert.match(html, /no API cost \(subscription allowance\)/);
  assert.match(html, /<a href="img\/01-a-red-cup-on-a-api\.png" target="_blank"/);
  assert.doesNotMatch(html, /approved|critique|verdict:/i, "no verdict text, even for an approved take");
  // A folder holding someone else's index.html is left alone.
  mkdirSync(join(p, "mine"));
  writeFileSync(join(p, "mine", "index.html"), "<p>hand made</p>");
  await assert.rejects(pageGraph("page-test", { project: p, out: "mine" }), (e: any) => e.code === "PAGE_EXISTS");
  assert.equal(readFileSync(join(p, "mine", "index.html"), "utf8"), "<p>hand made</p>");
  await assert.rejects(pageGraph("page-test", { project: p, zoom: ["0.8,0,0.5,0.5"] }), (e: any) => e.code === "BAD_ZOOM");
});

test("shallow depth of field reads from the soft share, not the thirds ratio", async () => {
  const { readFileSync } = await import("node:fs");
  const { readLook } = await import("../dist/imageqa.js");
  const { decodeRGBA } = await import("../dist/imageops.js");
  const read = async (f: string) => readLook(await decodeRGBA(readFileSync(join("test", "fixtures", f))));
  const prompt = "A woman at a pottery wheel. Late afternoon window light, 50mm lens at f/2, workshop shelves softly out of focus behind her.";
  const sub = await read("dof-shallow-subscription.jpg"), api = await read("dof-shallow-api.jpg"), flat = await read("dof-flat-sheet.jpg");
  // The old measure: the shallow portrait (2.9x) sits next to the flat, fully sharp sheet (2.4x).
  assert.ok(sub.sharpness.separation < 3 && flat.sharpness.separation > 2);
  for (const r of [sub, api]) {
    assert.ok(r.sharpness.softShare! >= 0.45, String(r.sharpness.softShare));
    assert.deepEqual(requestDeviations(r as any, prompt).filter(d => d.measure === "focus"), []);
  }
  assert.ok(flat.sharpness.softShare! < 0.2, String(flat.sharpness.softShare));
  const d = requestDeviations(flat as any, prompt).find(x => x.measure === "focus");
  assert.match(d!.measured, /^\d+% of the detailed areas are soft, so most of the frame is in focus$/);
});
