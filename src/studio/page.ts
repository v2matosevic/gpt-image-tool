// `studio page`: a self-contained static comparison page for a graph, for a person to look at.
//
// Takes are grouped by the list item (case) they were made from, with that item's text. Nodes that
// share the same items sit side by side; a finish is grouped under the case of the take it finished.
// Each image is copied next to the page under a readable name, opens at full size on click, and
// carries what was measured (the local reading and the deviations from the request, re-measured when
// the page is built), what made it and what it cost. Optional crops cut the same fractions out of
// every image in a case. The page holds no verdicts, critiques or approvals: the person judges.

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { evaluate } from "./evaluate.js";
import { StudioError, paths, readBoth } from "./store.js";
import type { Take } from "./types.js";

export interface PageZoom { region: [number, number, number, number]; label?: string; cases?: number[] }
export interface PageOptions { nodes?: string[]; zoom?: PageZoom[]; out: string; title?: string; now?: string }

const GENERATOR = "gpt-image studio page";
const IMAGE_TYPES = new Set(["generate", "edit", "process", "finish", "reference"]);
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const clip = (s: string, n: number) => {
  if (s.length <= n) return s;
  const cut = s.lastIndexOf(" ", n);
  return `${s.slice(0, cut > n / 2 ? cut : n).replace(/[,;:]$/, "")}…`;
};
const slugOf = (s: string, words = 5) => s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, words).join("-") || "image";

/** "x,y,w,h" fractions, optionally "N:" (one case, 1-based; several as "1+3:") and "=label". */
export function parseZoom(spec: string): PageZoom {
  const m = /^(?:([\d+]+):)?\s*([\d.]+),([\d.]+),([\d.]+),([\d.]+)\s*(?:=(.+))?$/.exec(spec.trim());
  const region = m ? [m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number] : undefined;
  if (!m || !region || region.some(v => !(v >= 0 && v <= 1)) || region[2] <= 0 || region[3] <= 0 || region[0] + region[2] > 1.0001 || region[1] + region[3] > 1.0001) {
    throw new StudioError("BAD_ZOOM", `page zoom "${spec}" is not x,y,w,h fractions inside the image.`, 'Example: --zoom 0.3,0.45,0.25,0.3 (every case), --zoom "5:0,0.1,0.5,0.3=shop signs" (case 5 only, labelled).');
  }
  return { region, ...(m[6] ? { label: m[6].trim() } : {}), ...(m[1] ? { cases: m[1].split("+").map(Number) } : {}) };
}

interface Entry { node: string; nodeLabel: string; take: Take; file: string; from?: { node: string; take: string; reading?: Take["reading"] } }
interface Group { key: string; item?: string; entries: Entry[] }

export async function writePage(project: string, dir: string, slug: string, opts: PageOptions) {
  const { graph, state } = await readBoth(dir);
  const evals = await evaluate(graph, state, { dir, project });
  const craft = await import("./craft.js");
  const { renderLabel } = await import("./render.js");
  const wanted = opts.nodes?.length ? opts.nodes : graph.nodes.filter(n => IMAGE_TYPES.has(n.type) && n.type !== "reference").map(n => n.id);
  for (const id of wanted) if (!evals.get(id)) { const { findNode } = await import("./graph.js"); findNode(graph, id, "nodes"); }

  // The case a take belongs to: its list item, or (for a finish or an edit of a take) its source's case.
  const takeOf = (node: string, take?: string) => state.nodes[node]?.takes.find(t => t.id === take);
  const caseOf = (t: Take | undefined, depth = 0): string | undefined => {
    if (!t || depth > 8) return undefined;
    if (t.text?.item) return t.text.item;
    const src = t.inputs.find(i => i.handle === "image" && i.take);
    return src ? caseOf(takeOf(src.node, src.take), depth + 1) : undefined;
  };
  const groups: Group[] = [];
  const groupFor = (item: string | undefined) => {
    const key = item ?? "";
    let g = groups.find(x => x.key === key);
    if (!g) groups.push(g = { key, ...(item ? { item } : {}), entries: [] });
    return g;
  };
  for (const id of wanted) {
    const ev = evals.get(id)!;
    const node = ev.node;
    for (const v of ev.views) {
      const t = v.take;
      if (!t || t.kind !== "image") continue;
      const file = resolve(dir, t.asset);
      if (!existsSync(file)) continue;
      const src = node.type === "finish" ? t.inputs.find(i => i.handle === "image" && i.take) : undefined;
      groupFor(caseOf(t)).entries.push({ node: id, nodeLabel: node.label ?? id, take: t, file, ...(src ? { from: { node: src.node, take: src.take!, reading: takeOf(src.node, src.take)?.reading } } : {}) });
    }
  }
  const total = groups.reduce((a, g) => a + g.entries.length, 0);
  if (!total) throw new StudioError("NO_IMAGES", `Graph "${slug}" has no current image takes${opts.nodes?.length ? ` in ${opts.nodes.join(", ")}` : ""}.`, "Run the graph first, or name nodes that have outputs.");

  const out = resolve(opts.out);
  const index = join(out, "index.html");
  if (existsSync(index) && !(await readFile(index, "utf8")).includes(`<meta name="generator" content="${GENERATOR}">`)) {
    throw new StudioError("PAGE_EXISTS", `${index} exists and was not written by studio page; it is left alone.`, "Pass --out with a new folder.");
  }
  await mkdir(join(out, "img"), { recursive: true });

  const figure = (src: string, alt: string, caption: string) =>
    `<figure><a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy"></a><figcaption>${caption}</figcaption></figure>`;
  let apiTotal = 0, apiCount = 0, subCount = 0;
  const sections: string[] = [];
  const files: string[] = [];
  for (const [gi, g] of groups.entries()) {
    const n = String(gi + 1).padStart(2, "0");
    const caseSlug = g.item ? slugOf(g.item) : slugOf(graph.name ?? slug);
    const drafts = g.entries.filter(e => !e.from), finishes = g.entries.filter(e => e.from);
    const cards: Record<string, string> = {};
    const name = (e: Entry, extra = "") => `img/${n}-${caseSlug}-${slugOf(e.node, 3)}${e.from ? `-from-${e.from.node}-${e.from.take}` : ""}${extra}.png`;
    for (const e of g.entries) {
      const rel = name(e);
      await copyFile(e.file, join(out, rel));
      files.push(rel);
      const t = e.take;
      const reading = (await craft.readingOf(e.file)) ?? t.reading;
      const devs = [...craft.requestDeviations(reading, craft.requestText(t)), ...(t.deviations ?? []).filter(d => d.source !== "request")];
      const api = t.render?.renderer === "api";
      if (api) { apiCount++; apiTotal += t.cost?.dollars ?? 0; } else subCount++;
      const made = api ? renderLabel(t.render) : `subscription, ${t.render?.model ?? "gpt-image-2 (server-chosen)"}`;
      const cost = api ? (t.cost ? `${money(t.cost.dollars)} from the usage the API reported (${t.usage?.output_tokens ?? "?"} output tokens; estimate ${money(t.cost.estimate)})` : "cost not reported") : "no API cost (subscription allowance)";
      const drift = e.from ? craft.driftLine(reading, e.from.reading, `${e.from.node}/${e.from.take}`) : undefined;
      cards[rel] = [
        `<div class="who"><span class="tag ${api ? "api" : "sub"}">${api ? "API" : "Subscription"}</span> <b>${esc(e.nodeLabel)}</b> <code>${esc(`${e.node}/${t.id}`)}</code>${e.from ? ` from <code>${esc(`${e.from.node}/${e.from.take}`)}</code>` : ""}</div>`,
        `<div class="d">${esc(made)}; saved ${t.width ?? "?"}x${t.height ?? "?"}. ${esc(cost)}.</div>`,
        `<div class="d"><span class="k">Reads</span> ${esc(await craft.summaryOf(reading))}</div>`,
        drift ? `<div class="d"><span class="k">Drift</span> ${esc(drift)}</div>` : "",
        devs.length ? `<div class="dev"><span class="k">Deviations (measured)</span><ul>${devs.map(d => `<li>${esc(d.note)}: expected ${esc(d.expected)}, measured ${esc(d.measured)}</li>`).join("")}</ul></div>` : `<div class="d"><span class="k">Deviations</span> none measured</div>`,
      ].join("");
    }
    const row = (es: Entry[], extra = "") => `<div class="row c${Math.min(3, Math.max(2, es.length))}">${es.map(e => figure(name(e, extra), `${e.nodeLabel} ${e.node}/${e.take.id}`, cards[name(e)]!)).join("")}</div>`;
    const crops: string[] = [];
    for (const [zi, z] of (opts.zoom ?? []).entries()) {
      if (z.cases && !z.cases.includes(gi + 1)) continue;
      const cells: string[] = [];
      for (const e of g.entries) {
        const rel = name(e, `-${z.label ? slugOf(z.label, 4) : `crop${zi + 1}`}`);
        const r = await craft.zoomRegion(e.file, z.region, join(out, rel));
        files.push(rel);
        cells.push(figure(rel, `${z.label ?? "detail"}, ${e.node}/${e.take.id}`, `<div class="who"><code>${esc(`${e.node}/${e.take.id}`)}</code> ${esc(z.label ?? "detail")}</div><div class="d">pixels ${r.box.join(", ")} (x, y, w, h) at full resolution</div>`));
      }
      const aspects = new Set(g.entries.map(e => (e.take.width && e.take.height ? (e.take.width / e.take.height).toFixed(2) : "?")));
      const mixed = aspects.size > 1 ? " The images in this case have different aspects, so the same fractions cover a different part of the scene in some of them." : "";
      crops.push(`<p class="small">Same region of every image in this case: ${z.region.join(", ")} as fractions (x, y, w, h)${z.label ? `, ${esc(z.label)}` : ""}.${mixed}</p><div class="row c${Math.min(3, Math.max(2, cells.length))}">${cells.join("")}</div>`);
    }
    const title = g.item ? clip(g.item.split(/(?<=[.!?])\s/)[0]!, 90) : (graph.name ?? slug);
    sections.push([
      `<section id="case-${n}"><h2>${gi + 1}. ${esc(title)}</h2>`,
      g.item ? `<p class="prompt">${esc(g.item)}</p>` : "",
      drafts.length ? row(drafts) : "",
      finishes.length ? `<p class="small">Finished from the take${finishes.length > 1 ? "s" : ""} above</p>${row(finishes)}` : "",
      ...crops, `</section>`,
    ].join("\n"));
  }
  const title = opts.title ?? `${graph.name ?? slug}: side by side`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${GENERATOR}">
<title>${esc(title)}</title>
<style>
:root { --bg:#111214; --panel:#1a1c20; --line:#2a2d33; --text:#e8e9ec; --muted:#9a9fa8; --sub:#7fb4ff; --api:#b79bff; --warn:#f0b35a; }
@media (prefers-color-scheme: light) { :root { --bg:#f6f6f4; --panel:#fff; --line:#dedfe3; --text:#16181c; --muted:#5c616b; --sub:#1f5fbf; --api:#6a3fc9; --warn:#9a5b00; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui, "Segoe UI", sans-serif; }
main { max-width:1500px; margin:0 auto; padding:32px 16px 80px; }
h1 { font-size:26px; margin:0 0 6px; } h2 { font-size:19px; margin:56px 0 4px; }
p.lead { color:var(--muted); margin:0 0 8px; max-width:900px; } p.small { color:var(--muted); margin:20px 0 0; font-size:13px; }
p.prompt { color:var(--muted); font-size:13px; max-width:1000px; margin:4px 0 0; font-style:italic; }
.row { display:grid; gap:16px; margin-top:12px; } .c1 { grid-template-columns:minmax(0,1fr); }
.c2 { grid-template-columns:repeat(2,minmax(0,1fr)); } .c3 { grid-template-columns:repeat(3,minmax(0,1fr)); }
figure { margin:0; background:var(--panel); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
figure a { display:block; background:#000; } img { display:block; width:100%; height:auto; }
figcaption { padding:12px 14px 14px; } code { font-size:12px; }
.tag { display:inline-block; font-size:11px; letter-spacing:.06em; text-transform:uppercase; font-weight:600; padding:1px 8px; border-radius:99px; }
.sub { color:var(--sub); border:1px solid var(--sub); } .api { color:var(--api); border:1px solid var(--api); }
.d, .dev { color:var(--muted); font-size:13px; margin-top:4px; } .k { color:var(--text); font-weight:600; margin-right:4px; }
.dev .k { color:var(--warn); } .dev ul { margin:2px 0 0; padding-left:18px; }
@media (max-width:900px) { .c2, .c3 { grid-template-columns:minmax(0,1fr); } }
</style>
</head>
<body>
<main>
<h1>${esc(title)}</h1>
<p class="lead">Studio graph <code>${esc(slug)}</code>, ${groups.length} case${groups.length === 1 ? "" : "s"}, ${total} image${total === 1 ? "" : "s"}. Page built ${esc((opts.now ?? new Date().toISOString()).slice(0, 16).replace("T", " "))} UTC. Click an image to open it at full size. Readings and deviations are measured locally from the pixels when the page is built; they are measurements, not judgements, and there is no verdict here.</p>
<p class="lead">Paid API: ${apiCount} image${apiCount === 1 ? "" : "s"}, ${money(apiTotal)} from the usage the API reported. Subscription: ${subCount} image${subCount === 1 ? "" : "s"} from the account's allowance.</p>
${sections.join("\n")}
</main>
</body>
</html>
`;
  await writeFile(index, html);
  return { path: index, dir: out, files, cases: groups.length, images: total, apiDollars: apiTotal,
    text: [`Page: ${index}`, `${groups.length} case(s), ${total} image(s) copied to ${join(out, "img")} with readable names (NN-case-node.png)${opts.zoom?.length ? `, plus crops` : ""}.`,
      `Paid API shown: ${money(apiTotal)} for ${apiCount} image(s). Open the page in a browser; it needs no server.`].join("\n") };
}

export const defaultPageDir = (dir: string, stamp: string) => join(paths(dir).views, `page-${stamp.replace(/[:.]/g, "-")}`);
