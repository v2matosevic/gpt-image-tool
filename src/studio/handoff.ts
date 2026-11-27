// Handoff: turn approved images into a package a coding agent can build from, and compare the
// built result with the mock. Colours are measured from pixels and reported as measurements.

import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { ExecInput, ExecOutput } from "./execute.js";
import { ancestors } from "./graph.js";
import { paths, toPosix } from "./store.js";
import type { GraphFile, StateFile, Take } from "./types.js";

export interface PackageManifest {
  schema: "gpt-image-studio/handoff@1";
  name: string;
  graph: string;
  graphRevision: number;
  created: string;
  intent: string;
  target?: string;
  mustMatch: string[];
  flexible: string[];
  mocks: Array<{ file: string; from: string; width: number; height: number; colors: string[]; hasTransparency: boolean; verdict?: Take["verdict"] }>;
  cutouts: Array<{ file: string; from: string }>;
  lineage: LineageEntry[];
  notes: Array<{ on: string; author?: string; text: string; resolved?: boolean }>;
}

export interface LineageEntry {
  ref: string;
  type: string;
  label?: string;
  text?: string;
  compiledPrompt?: string;
  settings?: Record<string, unknown>;
  source?: string;
  role?: string;
  from: LineageEntry[];
  texts: Array<{ node: string; text: string }>;
}

const SETTING_KEYS = ["preset", "modifiers", "style", "shot", "quality", "size", "op", "instruction", "role", "transparent"];

export function lineageOf(graph: GraphFile, state: StateFile, nodeId: string, takeId: string, seen = new Set<string>(), role?: string): LineageEntry {
  const ref = `${nodeId}/${takeId}`;
  const take = state.nodes[nodeId]?.takes.find(t => t.id === takeId);
  const node = graph.nodes.find(n => n.id === nodeId);
  const entry: LineageEntry = { ref, type: node?.type ?? "(removed)", label: node?.label, from: [], texts: [], role };
  if (!take || seen.has(ref)) return entry;
  seen.add(ref);
  entry.text = take.text?.prompt;
  entry.compiledPrompt = take.text?.compiledPrompt;
  entry.source = take.source;
  entry.settings = Object.fromEntries(Object.entries(take.settings).filter(([k]) => SETTING_KEYS.includes(k)));
  for (const inp of take.inputs) {
    if (inp.take) entry.from.push(lineageOf(graph, state, inp.node, inp.take, seen, inp.role));
    else if (inp.text) entry.texts.push({ node: inp.node, text: inp.text });
  }
  return entry;
}

async function measure(path: string) {
  const { decodeRGBA, resizeRGBA } = await import("../imageops.js");
  const { inspectRGBA } = await import("../imageqa.js");
  const { paletteFromRGBA } = await import("../palette.js");
  const img = await decodeRGBA(await readFile(path));
  const scale = Math.min(1, 512 / Math.max(img.width, img.height));
  const small = scale < 1 ? resizeRGBA(img, Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale))) : img;
  const qa = inspectRGBA(img);
  return { width: img.width, height: img.height, hasTransparency: qa.hasTransparency, colors: paletteFromRGBA([small], 6) };
}

export async function packageManifest(dir: string, handoffMdRel: string): Promise<PackageManifest | null> {
  try { return JSON.parse(await readFile(join(dirname(resolve(dir, handoffMdRel)), "manifest.json"), "utf8")); } catch { return null; }
}

function renderLineage(e: LineageEntry, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  const bits = [`${pad}- ${e.ref} (${e.type}${e.role ? `, as ${e.role}` : ""})`];
  if (e.source) bits[0] += ` from ${e.source}`;
  if (e.settings && Object.keys(e.settings).length) bits.push(`${pad}  settings: ${JSON.stringify(e.settings)}`);
  for (const t of e.texts) bits.push(`${pad}  text from ${t.node}: "${t.text}"`);
  for (const f of e.from) bits.push(...renderLineage(f, depth + 1));
  return bits;
}

export async function writeHandoff(x: ExecInput): Promise<ExecOutput> {
  const s = x.node.settings as Record<string, any>;
  const name: string = s.name ?? x.node.id;
  const root = paths(x.dir).handoff;
  const final = join(root, name);
  const tmp = join(root, `.${name}.tmp-${randomBytes(4).toString("hex")}`);
  await mkdir(tmp, { recursive: true });
  const intent = (s.intent as string | undefined) ?? x.slot.text ?? "";

  const mocks: PackageManifest["mocks"] = [];
  let i = 0;
  for (const ref of x.slot.refs) {
    i++;
    const src = resolve(x.dir, ref.asset);
    const file = `mock-${i}${extname(src).toLowerCase()}`;
    await copyFile(src, join(tmp, file));
    const m = await measure(src);
    const take = x.state.nodes[ref.node]?.takes.find(t => t.id === ref.take);
    mocks.push({ file, from: `${ref.node}/${ref.take}`, ...m, verdict: take?.verdict });
  }

  // Cut-outs: remove-background results upstream of the handoff, or made from an approved image
  // or anything in its lineage (a cut-out of the mock usually hangs off the generator, not the handoff).
  const lineage = x.slot.refs.map(r => lineageOf(x.graph, x.state, r.node, r.take));
  const lineageRefs = new Set<string>();
  const collect = (e: LineageEntry) => { lineageRefs.add(e.ref); e.from.forEach(collect); };
  lineage.forEach(collect);
  const cutouts: PackageManifest["cutouts"] = [];
  const up = ancestors(x.graph, x.node.id);
  for (const n of x.graph.nodes) {
    if (n.type !== "process" || n.settings.op !== "remove-background") continue;
    for (const im of x.evals.get(n.id)?.images ?? []) {
      const take = x.state.nodes[n.id]?.takes.find(t => t.id === im.take);
      const fromLineage = take?.inputs.some(i => i.take && lineageRefs.has(`${i.node}/${i.take}`));
      if (!up.has(n.id) && !fromLineage) continue;
      const file = `cutouts/${im.node}-${im.take}${extname(im.asset)}`;
      await mkdir(join(tmp, "cutouts"), { recursive: true });
      await copyFile(resolve(x.dir, im.asset), join(tmp, file));
      cutouts.push({ file, from: `${im.node}/${im.take}` });
    }
  }

  const involved = new Set<string>([x.node.id]);
  const walk = (e: LineageEntry) => { involved.add(e.ref.split("/")[0]!); e.texts.forEach(t => involved.add(t.node)); e.from.forEach(walk); };
  lineage.forEach(walk);
  const notes = x.graph.nodes.filter(n => n.type === "note" && involved.has(String(n.settings.on)))
    .map(n => ({ on: String(n.settings.on), author: n.settings.author as string | undefined, text: String(n.settings.text), resolved: n.settings.resolved as boolean | undefined }));

  const manifest: PackageManifest = {
    schema: "gpt-image-studio/handoff@1", name, graph: x.graph.slug, graphRevision: x.graph.revision, created: new Date().toISOString(),
    intent, target: s.target, mustMatch: s.must_match ?? [], flexible: s.flexible ?? [], mocks, cutouts, lineage, notes,
  };
  const implId = `${x.node.id}-build`;
  const md = [
    `# Handoff: ${name}`,
    "",
    `Graph "${x.graph.name}" (${x.graph.slug}), revision ${x.graph.revision}. Written ${manifest.created}.`,
    s.target ? `Target: ${s.target}` : "",
    "",
    "## Intent",
    "",
    intent || "(none given)",
    "",
    "## Approved mock" + (mocks.length > 1 ? "s" : ""),
    "",
    ...mocks.map((m, k) => `${k + 1}. \`${m.file}\`: ${m.width}x${m.height}${m.hasTransparency ? ", has transparency" : ""}, from ${m.from}${m.verdict ? `, ${m.verdict.decision} by ${m.verdict.by}${m.verdict.note ? ` ("${m.verdict.note}")` : ""}` : ""}.`),
    "",
    "## Must match",
    "",
    ...(manifest.mustMatch.length ? manifest.mustMatch.map(t => `- ${t}`) : ["- The composition, hierarchy and overall look of the mock."]),
    "",
    "## Flexible",
    "",
    ...(manifest.flexible.length ? manifest.flexible.map(t => `- ${t}`) : ["- Exact copy, spacing values and implementation details, unless listed above."]),
    "",
    "## Measured colours",
    "",
    "Dominant colours measured from the mock pixels, most common first. They are observations of a raster image, not design tokens the image intended: lighting, texture and antialiasing shift them. Use the project's real tokens where they exist.",
    "",
    ...mocks.map(m => `- \`${m.file}\`: ${m.colors.join(", ")}`),
    "",
    ...(cutouts.length ? ["## Cut-out assets", "", ...cutouts.map(c => `- \`${c.file}\` from ${c.from}`), ""] : []),
    ...(notes.length ? ["## Review notes", "", ...notes.map(n => `- on ${n.on}${n.author ? ` by ${n.author}` : ""}${n.resolved ? " (resolved)" : ""}: ${n.text}`), ""] : []),
    "## Lineage",
    "",
    "What produced each mock (prompts, references and settings):",
    "",
    ...lineage.flatMap(e => renderLineage(e)),
    "",
    "## Report back",
    "",
    "After building, take a screenshot at the mock's aspect ratio and attach it to the graph. The run writes a side-by-side comparison sheet; look at it yourself, nothing scores it automatically.",
    "",
    "```json",
    `studio_edit {"graph":"${x.graph.slug}","ops":[{"op":"add","id":"${implId}","type":"implementation","settings":{"screenshot":"path/to/screenshot.png"}},{"op":"connect","from":"${x.node.id}","to":"${implId}"}]}`,
    `studio_run {"graph":"${x.graph.slug}","scope":"${implId}"}`,
    "```",
    "",
    `CLI: \`gpt-image studio edit ${x.graph.slug} --ops '[...]'\` then \`gpt-image studio run ${x.graph.slug} --scope ${implId}\`.`,
    "",
  ].filter((l, k, a) => !(l === "" && a[k - 1] === "")).join("\n");
  await writeFile(join(tmp, "handoff.md"), md);
  await writeFile(join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  // Swap the finished package into place; the previous package is derived output and is replaced.
  if (existsSync(final)) {
    const old = join(root, `.${name}.old-${randomBytes(4).toString("hex")}`);
    await rename(final, old);
    await rename(tmp, final);
    await rm(old, { recursive: true, force: true });
  } else await rename(tmp, final);
  const files = ["handoff.md", "manifest.json", ...mocks.map(m => m.file), ...cutouts.map(c => c.file)].map(f => toPosix(join(final, f)));
  return { path: join(final, "handoff.md"), files, generations: 0, kind: "package" };
}

/** Mock and build side by side at the same height. No text rendering, so no font dependency;
 *  the labels go in the sidecar JSON and the run result. */
export async function compareSheet(mockPath: string, buildPath: string, out: string, labels: { left: string; right: string }): Promise<string> {
  const { decodeRGBA, fitTo, blitOver } = await import("../imageops.js");
  const { encodePng } = await import("../bgremove.js");
  const a = await decodeRGBA(await readFile(mockPath));
  const b = await decodeRGBA(await readFile(buildPath));
  const H = 960, pad = 24;
  const wa = Math.round(a.width * (H / a.height)), wb = Math.round(b.width * (H / b.height));
  const W = Math.min(4000, wa + wb + pad * 3);
  const canvas = { width: W, height: H + pad * 2, data: Buffer.alloc(W * (H + pad * 2) * 4) };
  for (let p = 0; p < canvas.data.length; p += 4) { canvas.data[p] = 0xe9; canvas.data[p + 1] = 0xe9; canvas.data[p + 2] = 0xe4; canvas.data[p + 3] = 255; }
  const colW = Math.floor((W - pad * 3) / 2);
  blitOver(canvas, fitTo(a, colW, H, "contain", [0xe9, 0xe9, 0xe4, 255]), pad, pad);
  blitOver(canvas, fitTo(b, colW, H, "contain", [0xe9, 0xe9, 0xe4, 255]), pad * 2 + colW, pad);
  await writeFile(out, encodePng(canvas));
  await writeFile(`${out}.json`, JSON.stringify({ left: { label: labels.left, file: basename(mockPath) }, right: { label: labels.right, file: basename(buildPath) }, note: "Side-by-side for visual review. No automated visual score is computed." }, null, 2));
  return out;
}
