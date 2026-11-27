// Canon: named characters, places, products and looks shared across graphs and projects.
// <project>/.gptimage/studio/_canon/<name>/canon.json holds a locked description that generators
// receive word for word (rewording a description is a main cause of drift), reference images with
// roles, and the measured palette. Replacing an entry keeps the old one under history/.

import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { CANON_DIR, type GraphFile, type GraphNode, type StateFile, type Take } from "./types.js";
import { StudioError, assetRel, atomicWrite, now, studioRoot, toPosix, withLock } from "./store.js";

export const CANON_SCHEMA = "gpt-image-studio/canon@1";
export const CANON_KINDS = ["character", "place", "product", "look"] as const;

export interface CanonEntry {
  schema: typeof CANON_SCHEMA;
  name: string;
  kind: (typeof CANON_KINDS)[number];
  /** Injected verbatim into every prompt that uses this entry. */
  description: string;
  references: Array<{ file: string; role: string; sha256: string; from?: string }>;
  palette: Array<{ hex: string; share: number }>;
  created: string;
  by: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function canonRoot(project: string): string { return join(studioRoot(project), CANON_DIR); }

export function canonDir(project: string, name: string): string {
  if (!NAME.test(name)) throw new StudioError("BAD_NAME", `Canon name "${name}" is not valid.`, "Use lowercase letters, digits and hyphens, e.g. \"teapot\" or \"hero-character\".");
  return join(canonRoot(project), name);
}

export async function readCanon(project: string, name: string): Promise<CanonEntry> {
  const dir = canonDir(project, name);
  try { return JSON.parse(await readFile(join(dir, "canon.json"), "utf8")) as CanonEntry; } catch {
    const have = await listCanon(project).catch(() => [] as CanonEntry[]);
    throw new StudioError("NO_CANON", `No canon entry "${name}" in ${canonRoot(project)}.`,
      have.length ? `Entries: ${have.map(c => c.name).join(", ")}.` : 'Save one first: {op:"canon_save", name:"...", takes:["gen/t3"], description:"..."}.');
  }
}

export async function listCanon(project: string): Promise<CanonEntry[]> {
  const root = canonRoot(project);
  if (!existsSync(root)) return [];
  const out: CanonEntry[] = [];
  for (const d of await readdir(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try { out.push(JSON.parse(await readFile(join(root, d.name, "canon.json"), "utf8"))); } catch { /* not an entry */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Weighted merge of the takes' measured palettes. */
function mergedPalette(takes: Take[]): CanonEntry["palette"] {
  const acc = new Map<string, number>();
  const withReading = takes.filter(t => Array.isArray((t.reading as any)?.palette));
  for (const t of withReading) for (const p of (t.reading as any).palette as Array<{ hex: string; share: number }>) acc.set(p.hex, (acc.get(p.hex) ?? 0) + p.share / withReading.length);
  return [...acc].map(([hex, share]) => ({ hex, share: Math.round(share * 1000) / 1000 })).sort((a, b) => b.share - a.share).slice(0, 6);
}

export async function saveCanon(project: string, graphDir: string, opts: { name: string; kind?: string; description: string; takes: Array<{ ref: string; take: Take; role: string }>; by: string; replace?: boolean }): Promise<CanonEntry> {
  const dir = canonDir(project, opts.name);
  const kind = (opts.kind ?? "product") as CanonEntry["kind"];
  if (!CANON_KINDS.includes(kind)) throw new StudioError("BAD_OP", `Canon kind "${opts.kind}" is not valid.`, `Kinds: ${CANON_KINDS.join(", ")}.`);
  if (!opts.takes.length || opts.takes.length > 8) throw new StudioError("BAD_OP", "A canon entry needs 1-8 image takes.", 'takes:["gen/t3"]');
  if (opts.takes.some(t => t.take.kind !== "image")) throw new StudioError("BAD_OP", "Canon references must be images, not packages.", "Pass image takes.");
  await mkdir(canonRoot(project), { recursive: true });
  return withLock(join(canonRoot(project), `${opts.name}.lock`), opts.by, async () => {
    if (existsSync(join(dir, "canon.json"))) {
      if (!opts.replace) throw new StudioError("CANON_EXISTS", `Canon entry "${opts.name}" already exists.`, "Pass replace:true to replace it (the old entry is kept under history/), or choose another name.");
      const hist = join(dir, "history", now().replace(/[:.]/g, "-"));
      await mkdir(hist, { recursive: true });
      for (const f of await readdir(dir)) if (f !== "history") await rename(join(dir, f), join(hist, f));
    }
    await mkdir(dir, { recursive: true });
    const references: CanonEntry["references"] = [];
    for (const [i, t] of opts.takes.entries()) {
      const file = `ref-${i + 1}${extname(t.take.asset).toLowerCase() || ".png"}`;
      await copyFile(resolve(graphDir, t.take.asset), join(dir, file));
      references.push({ file, role: t.role, sha256: t.take.sha256, from: t.ref });
    }
    const entry: CanonEntry = { schema: CANON_SCHEMA, name: opts.name, kind, description: opts.description.trim(), references, palette: mergedPalette(opts.takes.map(t => t.take)), created: now(), by: opts.by };
    await atomicWrite(join(dir, "canon.json"), JSON.stringify(entry, null, 2) + "\n");
    return entry;
  });
}

/** The project a canon node reads from: its settings.project (relative to this project) or this one. */
export function canonProject(project: string, node: GraphNode): string {
  const p = node.settings.project;
  return typeof p === "string" && p ? resolve(project, p) : project;
}

export function relativeProject(project: string, raw: string): string {
  const abs = isAbsolute(raw) ? raw : resolve(project, raw);
  if (!existsSync(join(abs, ".gptimage", "studio", CANON_DIR))) throw new StudioError("NO_CANON", `No canon folder in ${abs}.`, "Point project at a project that has .gptimage/studio/_canon/, absolute or relative to this project.");
  return toPosix(relative(project, abs)) || ".";
}

/** Import (or re-select) the entry's reference files as this node's takes. Returns new takes. */
export async function importCanon(graph: GraphFile, state: StateFile, project: string, dir: string, node: GraphNode, job?: string): Promise<Take[]> {
  const { nodeState, fileSha } = await import("./graph.js");
  const src = canonProject(project, node);
  const entry = await readCanon(src, String(node.settings.name));
  const ns = nodeState(state, node.id);
  const selected: string[] = [];
  const created: Take[] = [];
  for (const ref of entry.references) {
    const file = join(canonDir(src, entry.name), ref.file);
    const { sha256, bytes } = await fileSha(file);
    const have = ns.takes.find(t => t.sha256 === sha256 && (t.settings as any).role === ref.role);
    if (have) { selected.push(have.id); continue; }
    const takeId = `t${state.nextTake++}`;
    const dest = join(dir, "assets", `${node.id}-${takeId}${extname(ref.file)}`);
    await mkdir(join(dir, "assets"), { recursive: true });
    await copyFile(file, dest);
    const { imageSize } = await import("../imageinfo.js");
    const dim = imageSize(await readFile(dest));
    const take: Take = {
      id: takeId, kind: "image", slot: created.length, variant: 0, fingerprint: sha256, asset: assetRel(dir, dest), sha256, bytes,
      width: dim?.width, height: dim?.height, created: now(), job, graphRevision: graph.revision, inputs: [],
      settings: { canon: entry.name, role: ref.role, file: ref.file }, generations: 0, source: `canon:${entry.name}/${ref.file}`,
    };
    ns.takes.push(take);
    created.push(take);
    selected.push(take.id);
  }
  ns.selected = selected;
  return created;
}
