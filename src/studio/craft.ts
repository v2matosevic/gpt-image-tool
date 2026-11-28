// Craft: what helps an agent see and judge. Readings and deviations on every take, the brief
// checklist, labelled review sheets with optional overlays, full-resolution zooms and blind pairs.
// None of this decides what is good; it measures, lists questions and lays images out to look at.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { ChecklistItem, Reading, Take } from "./types.js";
import type { Look } from "./evaluate.js";
import { SHOT_DIMENSIONS } from "./nodes.js";
import { StudioError } from "./store.js";

export type LookReadingT = import("../imageqa.js").LookReading;

export interface Deviation { source: "anchor" | "request"; measure: string; expected: string; measured: string; note: string }

export async function readingOf(path: string): Promise<Reading | undefined> {
  try {
    const { decodeRGBA } = await import("../imageops.js");
    const { readLook } = await import("../imageqa.js");
    return readLook(await decodeRGBA(await readFile(path))) as unknown as Reading;
  } catch { return undefined; }
}

/** Colour words and the family each names. Ambiguous words (rose, gold leaf, cream) are left out. */
const COLOUR_WORDS: Record<string, string[]> = {
  red: ["red", "crimson", "scarlet", "burgundy", "maroon", "ruby", "cherry"],
  orange: ["orange", "rust", "terracotta", "copper", "tangerine", "coral"],
  yellow: ["yellow", "mustard", "lemon", "ochre"],
  green: ["green", "sage", "olive", "emerald", "mint", "lime", "jade", "moss"],
  cyan: ["teal", "turquoise", "cyan", "aqua"],
  blue: ["blue", "cobalt", "navy", "azure", "sapphire", "indigo", "cerulean", "ultramarine"],
  purple: ["purple", "violet", "lilac", "lavender", "plum", "mauve"],
  pink: ["pink", "magenta", "fuchsia", "blush"],
};
const RING = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"];
const NEGATED = /\b(no|not|without|free of|instead of|rather than|lacks?|missing)\s+(?:\w+\s+){0,2}$/i;

/** Colour families a text names that the image does not contain at all (named family and both
 *  ring neighbours under 0.3% of pixels). A warning, never a block: the words may be right about
 *  something the measurement cannot see, and absence of a family is all this checks. */
export async function colourMismatch(text: string, take: Take, dir: string): Promise<string[]> {
  let reading = take.reading as any;
  if (!reading?.hueHistogram && take.kind === "image") reading = (await readingOf(resolve(dir, take.asset))) ?? reading;
  const hues = reading?.hues as Record<string, number> | undefined;
  const hist = reading?.hueHistogram as number[] | undefined;
  if (!hues) return [];
  const { HUE_RANGES } = await import("../imageqa.js");
  const out: string[] = [];
  for (const [family, words] of Object.entries(COLOUR_WORDS)) {
    // The first affirmative mention of this family, as written.
    const m = [...text.matchAll(new RegExp(`\\b(?:${words.join("|")})(?:ish)?\\b`, "gi"))]
      .find(x => !NEGATED.test(text.slice(Math.max(0, x.index! - 40), x.index)));
    if (!m) continue;
    // The family's own hue range plus 10 degrees each side (hue words are fuzzy at the edges); readings
    // stored before the histogram existed fall back to the family and both neighbouring families.
    let near: number, what: string;
    if (hist?.length === 72) {
      const [from, to] = HUE_RANGES[family as keyof typeof HUE_RANGES];
      near = 0;
      for (let d = from - 10; d < to + 10; d += 5) near += hist[(((d % 360) + 360) % 360) / 5]!;
      what = `${family} hues within 10 degrees`;
    } else {
      const k = RING.indexOf(family);
      near = [RING[(k + 7) % 8]!, family, RING[(k + 1) % 8]!].reduce((a, f) => a + (hues[f] ?? 0), 0);
      what = `${family} and its neighbours`;
    }
    if (near < 0.003) out.push(`"${m[0]}" names ${family}, but the image has no ${family} pixels (measured ${what}: ${(near * 100).toFixed(1)}%)`);
  }
  return out;
}

export async function summaryOf(r: Reading | undefined): Promise<string> {
  if (!r) return "(no reading)";
  const { lookSummary } = await import("../imageqa.js");
  return lookSummary(r as unknown as LookReadingT);
}

/** Drift against the anchor (the first input image of an edit or process, or the first reference). */
export async function anchorDeviations(take: Reading | undefined, anchor: Reading | undefined, anchorRef: string): Promise<Deviation[]> {
  if (!take || !anchor) return [];
  const { lookDrift } = await import("../imageqa.js");
  return lookDrift(take as unknown as LookReadingT, anchor as unknown as LookReadingT).map(f => ({ source: "anchor" as const, measure: f.measure, expected: `${f.anchor} (${anchorRef})`, measured: f.take, note: f.note }));
}

/** One line of measured drift between a take and the image it was made from, printed for every
 *  finish whether or not anything crossed a deviation threshold. Measurements, not a verdict. */
export function driftLine(take: Reading | undefined, from: Reading | undefined, fromRef: string): string | undefined {
  if (!take || !from) return undefined;
  const t = take as unknown as LookReadingT, f = from as unknown as LookReadingT;
  const d = (x: number, y: number, digits = 1) => `${x - y >= 0 ? "+" : ""}${(x - y).toFixed(digits)}`;
  const shift = Math.hypot(t.composition.centroid.x - f.composition.centroid.x, t.composition.centroid.y - f.composition.centroid.y);
  return `drift from ${fromRef}: mean L* ${d(t.luminance.mean, f.luminance.mean)}, warmth b* ${d(t.color.warmth, f.color.warmth)}, chroma C* ${d(t.color.chroma, f.color.chroma)}, ` +
    `visual-weight centre moved ${(shift * 100).toFixed(1)}% of the frame (${t.color.temperature}/${t.color.saturation} vs ${f.color.temperature}/${f.color.saturation})`;
}

/** Words in the request that imply something measurable. Only clear cases; silence is not a pass. */
const EXPECT: Array<{ re: RegExp; measure: string; expected: string; ok: (r: LookReadingT) => boolean; measured: (r: LookReadingT) => string }> = [
  { re: /\blow[- ]key\b|\bmoody\b|\bnight\b|\bchiaroscuro\b/i, measure: "key", expected: "low key", ok: r => r.luminance.key === "low" || r.luminance.mean < 42, measured: r => `${r.luminance.key} (mean L* ${Math.round(r.luminance.mean)})` },
  { re: /\bhigh[- ]key\b|\bairy\b|\bbright and clean\b/i, measure: "key", expected: "high key", ok: r => r.luminance.key === "high" || r.luminance.mean > 62, measured: r => `${r.luminance.key} (mean L* ${Math.round(r.luminance.mean)})` },
  { re: /\bwarm\b|golden hour|tungsten|candle/i, measure: "temperature", expected: "warm", ok: r => r.color.warmth > 4, measured: r => `${r.color.temperature} (b* ${r.color.warmth.toFixed(0)})` },
  { re: /\bcool\b|\bcold\b|blue hour|moonlight/i, measure: "temperature", expected: "cool", ok: r => r.color.warmth < 2, measured: r => `${r.color.temperature} (b* ${r.color.warmth.toFixed(0)})` },
  { re: /\bmuted\b|desaturated|\bpastel\b|monochrome/i, measure: "saturation", expected: "muted", ok: r => r.color.chroma < 25, measured: r => `${r.color.saturation} (C* ${r.color.chroma.toFixed(0)})` },
  { re: /\bvivid\b|\bsaturated\b|\bneon\b/i, measure: "saturation", expected: "vivid", ok: r => r.color.chroma > 30, measured: r => `${r.color.saturation} (C* ${r.color.chroma.toFixed(0)})` },
  { re: /rule of thirds|off[- ]cent(?:re|er)/i, measure: "composition", expected: "weight off centre", ok: r => r.composition.heaviest !== "centre", measured: r => `heaviest ${r.composition.heaviest}` },
  { re: /\bcent(?:red|ered)\b|symmetr/i, measure: "composition", expected: "weight in the centre", ok: r => r.composition.heaviest === "centre" || Math.hypot(r.composition.centroid.x - 0.5, r.composition.centroid.y - 0.5) < 0.12, measured: r => `heaviest ${r.composition.heaviest}, centroid ${r.composition.centroid.x.toFixed(2)},${r.composition.centroid.y.toFixed(2)}` },
  { re: /f\/1\.\d|f\/2(?:\.\d)?\b|shallow depth|bokeh/i, measure: "focus", expected: "shallow depth of field (about 40% or more of the detailed areas soft)",
    // Readings from before softShare existed are not judged: the thirds ratio could not tell.
    ok: r => r.sharpness.softShare === undefined || r.sharpness.softShare >= 0.4,
    measured: r => `${Math.round((r.sharpness.softShare ?? 0) * 100)}% of the detailed areas are soft, so most of the frame is in focus` },
  { re: /negative space|minimal/i, measure: "space", expected: "generous quiet space", ok: r => r.composition.negativeSpace > 0.3, measured: r => `${Math.round(r.composition.negativeSpace * 100)}% quiet` },
];

export function requestText(take: Pick<Take, "text" | "settings">): string {
  const s = take.settings as Record<string, any>;
  return [take.text?.prompt, s.instruction, ...Object.values(s.shot ?? {}), ...Object.entries(s.style ?? {}).filter(([k]) => k !== "avoid" && k !== "text").map(([, v]) => v)].filter(x => typeof x === "string").join(" · ");
}

/** Palette shares that read clearly warm (red/orange/yellow-leaning) and clearly cool (blue/cyan-leaning). */
function temperatureShares(r: LookReadingT): { warm: number; cool: number } {
  let warm = 0, cool = 0;
  for (const p of r.palette) {
    const n = parseInt(p.hex.slice(1), 16), R = n >> 16, G = (n >> 8) & 255, B = n & 255;
    if (R - B > 24 && R >= G - 10) warm += p.share; else if (B - R > 16) cool += p.share;
  }
  return { warm, cool };
}

export function requestDeviations(reading: Reading | undefined, request: string): Deviation[] {
  if (!reading) return [];
  const r = reading as unknown as LookReadingT;
  const asked = EXPECT.filter(e => e.re.test(request));
  const out: Deviation[] = [];
  // Warm and cool asked together (blue hour with lamplight, a teal and amber grade) is one request for
  // mixed temperature, not two misses: it is met when the palette holds both a warm and a cool share.
  const mixed = asked.some(e => e.expected === "warm") && asked.some(e => e.expected === "cool");
  for (const e of asked) {
    if (mixed && e.measure === "temperature") continue;
    if (!e.ok(r)) out.push({ source: "request", measure: e.measure, expected: e.expected, measured: e.measured(r), note: `asked for ${e.expected}` });
  }
  if (mixed) {
    const t = temperatureShares(r);
    if (t.warm < 0.05 || t.cool < 0.05) out.push({ source: "request", measure: "temperature", expected: "mixed warm and cool", measured: `palette warm ${Math.round(t.warm * 100)}%, cool ${Math.round(t.cool * 100)}% (overall b* ${r.color.warmth.toFixed(0)})`, note: "asked for warm and cool together" });
  }
  // Bars nobody asked for: the picture does not fill the frame it was paid for.
  if (r.frame && !/letterbox|pillarbox|black bars|\bbars\b|border|framed|frame around/i.test(request)) {
    const f = r.frame;
    out.push({ source: "request", measure: "frame", expected: "the picture fills the frame",
      measured: `${f.kind}ed: ${f.colour} bars ${f.kind === "letterbox" ? `${f.top} px top, ${f.bottom} px bottom` : `${f.left} px left, ${f.right} px right`}; picture ${f.picture.width}x${f.picture.height} of ${r.width}x${r.height}`,
      note: "bars were not asked for" });
  }
  return out;
}

const NUMBER = "(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[2-9]|1[0-9])";
const MEDIUM = /\b(?:photograph|photo|illustration|render|painting|drawing|still life|portrait|poster|mock-?up|screenshot|sheet|shot|logo|mark|icon|diagram|map)\b/i;
const art = (p: string) => (/^(?:a|an|the|one|two|three|four|five|six|seven|eight|nine|ten|\d)\b/i.test(p) ? p : `${/^[aeiou]/i.test(p) ? "an" : "a"} ${p.charAt(0).toLowerCase()}${p.slice(1)}`);
const lowerFirst = (p: string) => p.replace(/^(A|An|The)\b/, m => m.toLowerCase());

/** Yes/no questions an agent can answer by looking, from the parts of a prompt that are checkable:
 *  the subject, counted objects, stated positions, layers, literal text and exclusions. Anything else
 *  is left out: a clause fragment turned into a question is worse than no question. */
export function promptQuestions(t: string): Array<{ question: string; from: string }> {
  const out: Array<{ question: string; from: string }> = [];
  const add = (question: string, from: string) => {
    const q = question.replace(/\s+/g, " ").trim();
    if (q.split(" ").length <= 28 && /^(?:Is|Are|Does|Do|In)\b.*\?$/.test(q) && !out.some(x => x.question === q)) out.push({ question: q, from });
  };
  const text = t.replace(/\s+/g, " ").trim();
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/);
  // 1. The subject: the first clause of the first sentence.
  const first = (sentences[0] ?? "").replace(/^(?:foreground|midground|background)\s*:\s*/i, "");
  const clause = first.split(/[,;:]|\s[-–—]\s|\.$/)[0]!.replace(/\s+(?:with|shown as|set in|lit by)\s.*$/i, m => (/^\s+lit by/i.test(m) ? m : "")).trim();
  if (clause && clause.split(" ").length >= 2 && clause.split(" ").length <= 18) {
    add(MEDIUM.test(clause) ? `Does it read as ${art(lowerFirst(clause))}?` : `Does the image show ${art(lowerFirst(clause))}?`, "prompt.subject");
  }
  // 2. Counted things: "exactly five objects", "three full-body views", "three cards".
  for (const m of text.matchAll(new RegExp(String.raw`\b(exactly |only )?(${NUMBER})\s+((?:[a-z][a-z-]*\s){0,2}?[a-z][a-z-]*s)\b`, "gi"))) {
    if (/\b(?:times|percent|years|minutes|hours|seconds|pixels)$/i.test(m[3]!)) continue;
    add(`Are there exactly ${m[2]!.toLowerCase()} ${m[3]}?`, "prompt.count");
  }
  for (const m of text.matchAll(/\bboth ([a-z][a-z-]*s)\b/gi)) add(`Are both ${m[1]} visible?`, "prompt.count");
  // 3. Stated positions: "a closed red notebook in the top left corner", "a pencil below the glasses".
  const where = "in the (?:(?:top|bottom|upper|lower)[ -](?:left|right)(?: corner)?|centre|center|middle|(?:top|bottom|left|right)(?: edge| corner)?)|(?:directly )?(?:below|above|under|beneath|behind|beside|next to|in front of|(?:to the )?(?:left|right) of) (?:the|a|an) [a-z][a-z -]{1,30}?";
  for (const m of text.matchAll(new RegExp(String.raw`\b(?:a|an|the)\s+((?:[a-z][a-z-]*\s){0,6}?[a-z][a-z-]*)\s+(${where})(?=[,.;]|$|\s+and\b)`, "gi"))) {
    add(`Is the ${m[1]} ${m[2]}?`, "prompt.position");
  }
  // 4. Labelled layers: "Foreground: a bicycle leaning on a lamp post, sharp."
  // Only as a label at the start of a sentence, not "a plain light background: front view, ...".
  for (const m of text.matchAll(/(?:^|[.;]\s*)(foreground|midground|background)\s*:\s*([^.;]+)/gi)) {
    const thing = m[2]!.split(",")[0]!.trim();
    if (thing.split(" ").length <= 14) add(`In the ${m[1]!.toLowerCase()}, ${/^(?:a|an|one)\b/i.test(thing) ? "is there" : "are there"} ${lowerFirst(thing)}?`, "prompt.layer");
  }
  // 5. Literal text, one question per sentence that quotes words.
  for (const sen of sentences) {
    const quoted = [...sen.matchAll(/(?:^|[\s(])(?:'([^']{1,60})'|"([^"]{1,60})"|‘([^’]{1,60})’|“([^”]{1,60})”)(?=[\s,.;:)!?]|$)/g)].map(m => m[1] ?? m[2] ?? m[3] ?? m[4]!);
    if (quoted.length) add(`Does the image contain the text ${quoted.map(q => `"${q}"`).join(", ")}, each spelled exactly?`, "prompt.text");
  }
  // 6. Things named after "with" in the first sentence ("..., with a brass lamp").
  for (const m of first.matchAll(/\bwith (an? [a-z][a-z -]{2,40}?)(?=[,.;]|$)/gi)) add(`Is there ${m[1]}?`, "prompt.with");
  // 7. Exclusions: "no text, no gradients", "without people", "nothing else on the desk".
  for (const m of text.matchAll(/\b(?:no|without)\s+([a-z][a-z -]{1,40}?)(?=[,.;]|$)/gi)) add(`Is it free of ${m[1]}?`, "prompt.exclude");
  for (const m of text.matchAll(/\bnothing else ([a-z][a-z ]{1,40}?)(?=[,.;]|$)/gi)) add(`Is there nothing else ${m[1]}, besides what the prompt names?`, "prompt.exclude");
  return out.slice(0, 10);
}

/** Concrete yes/no questions derived from the request, answered by looking (TIFA/DSG-style). */
export function briefChecklist(text: string | undefined, look: Look | undefined, settings: Record<string, any>, kind: string): ChecklistItem[] {
  const q: Array<{ question: string; from: string }> = [];
  const add = (question: string, from: string) => { if (q.length < 12 && !q.some(x => x.question === question)) q.push({ question, from }); };
  const t = (text ?? "").trim();
  if (kind === "edit") {
    if (t) add(`Was this change made: "${t}"?`, "instruction");
    add("Is everything not mentioned in the instruction unchanged from the source image?", "instruction");
  } else if (t) {
    for (const x of promptQuestions(t)) add(x.question, x.from);
  }
  const shot = (look?.shot ?? {}) as Record<string, string>;
  const ask: Partial<Record<keyof typeof SHOT_DIMENSIONS, (v: string) => string>> = {
    size: v => `Shot size: is it ${v}?`, angle: v => `Camera angle: is it ${v}?`, aperture: v => `Depth of field: does it match ${v}?`,
    key_light: v => `Key light: does it match "${v}"?`, light_quality: v => `Light quality: is it ${v}?`, light_source: v => `Light source: does it read as ${v}?`,
    palette: v => `Palette: is it ${v}?`, color_scheme: v => `Colour scheme: is it ${v}?`, time: v => `Time of day: does it read as ${v}?`, atmosphere: v => `Atmosphere: is there ${v}?`,
    foreground: v => `Foreground: is ${v} there?`, midground: v => `Midground: is ${v} there?`, background: v => `Background: is ${v} there?`,
    device: v => `Composition: is it built on ${v}?`, medium: v => `Medium: does it read as ${v}?`, grade: v => `Grade: is it ${v}?`,
  };
  for (const [k, fn] of Object.entries(ask)) if (shot[k]) add(fn!(shot[k]!), `shot.${k}`);
  const style = (look?.style ?? {}) as Record<string, any>;
  if (typeof style.text === "string" && style.text) add(`Does the lettering read exactly "${style.text}", with no other text?`, "style.text");
  for (const x of ((look?.brief as any)?.mustInclude ?? []) as string[]) add(`Is ${x} visible?`, "brief.mustInclude");
  for (const x of [...((style.avoid ?? []) as string[]), ...(((look?.brief as any)?.avoid ?? []) as string[])].slice(0, 3)) add(`Is it free of ${x}?`, "avoid");
  if (settings.transparent) add("Is the background cleanly transparent with no halo?", "transparent");
  add("Is it free of visible defects (warped hands or objects, garbled text, smears, extra limbs)?", "defects");
  return q.map((x, i) => ({ id: `c${i + 1}`, ...x }));
}

// ---------------------------------------------------------------- review sheets

export interface SheetItem { path: string; title: string; detail?: string; reading?: Reading }
export const OVERLAYS = ["grid", "palette", "histogram"] as const;
export type Overlay = (typeof OVERLAYS)[number];

export function checkOverlays(list: unknown): Overlay[] | undefined {
  if (list === undefined) return undefined;
  const arr = Array.isArray(list) ? list : [list];
  const bad = arr.filter(o => !(OVERLAYS as readonly string[]).includes(String(o)));
  if (bad.length) throw new StudioError("BAD_OVERLAY", `Unknown overlay${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}.`, `Overlays: ${OVERLAYS.join(", ")}.`);
  return arr as Overlay[];
}

/** Flattened settings differences across takes: the one setting that differs is the label. */
export function differingSettings(takes: Array<{ settings: Record<string, unknown>; text?: Take["text"] }>): string[][] {
  const flat = (o: unknown, p = ""): Record<string, string> => {
    if (o === null || typeof o !== "object" || Array.isArray(o)) return { [p]: JSON.stringify(o) };
    return Object.assign({}, ...Object.entries(o as object).map(([k, v]) => flat(v, p ? `${p}.${k}` : k)));
  };
  const flats: Record<string, string>[] = takes.map(t => ({ ...flat(t.settings), ...(t.text?.item ? { item: JSON.stringify(t.text.item) } : {}) }));
  const keys = [...new Set(flats.flatMap(f => Object.keys(f)))].filter(k => new Set(flats.map(f => f[k])).size > 1 && k !== "prompt");
  return flats.map(f => keys.map(k => `${k}: ${f[k] === undefined ? "(unset)" : JSON.parse(f[k]!)}`));
}

export async function reviewSheet(items: SheetItem[], out: string, overlays: Overlay[] = ["palette"], title?: string): Promise<string> {
  const { decodeRGBA, fitTo } = await import("../imageops.js");
  const { encodePng } = await import("../bgremove.js");
  const { svgDocument, rasterizeSvg } = await import("../vector.js");
  const { escapeXml } = await import("../typeset.js");
  if (!items.length || items.length > 30) throw new Error("A review sheet needs 1-30 images.");
  const cols = Math.min(4, items.length <= 4 ? items.length : Math.ceil(Math.sqrt(items.length)));
  const imgW = 420, imgH = 420, strip = overlays.includes("palette") || overlays.includes("histogram") ? 26 : 0, labelH = 54, pad = 14;
  const cellW = imgW + pad * 2, cellH = imgH + strip + labelH + pad * 2, top = title ? 40 : 0;
  const W = cols * cellW, H = top + Math.ceil(items.length / cols) * cellH;
  const parts: string[] = [`<rect width="100%" height="100%" fill="#ECECE8"/>`];
  if (title) parts.push(`<text x="${pad}" y="27" font-family="sans-serif" font-size="18" font-weight="700" fill="#222">${escapeXml(title.slice(0, 120))}</text>`);
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const x = (i % cols) * cellW + pad, y = top + Math.floor(i / cols) * cellH + pad;
    const src = await decodeRGBA(await readFile(it.path));
    // Overlays need a reading; takes saved before readings existed (and imported references) may lack one.
    if (!it.reading && (overlays.includes("palette") || overlays.includes("histogram") || overlays.includes("grid"))) it.reading = await readingOf(it.path);
    const fit = fitTo(src, imgW, imgH, "contain", [255, 255, 255, 255]);
    parts.push(`<rect x="${x}" y="${y}" width="${imgW}" height="${imgH}" fill="#FFFFFF"/>`, `<image x="${x}" y="${y}" width="${imgW}" height="${imgH}" href="data:image/png;base64,${encodePng(fit).toString("base64")}"/>`);
    if (overlays.includes("grid")) {
      const s = Math.min(imgW / src.width, imgH / src.height), w = src.width * s, h = src.height * s, ox = x + (imgW - w) / 2, oy = y + (imgH - h) / 2;
      for (const f of [1 / 3, 2 / 3]) {
        parts.push(`<line x1="${ox + w * f}" y1="${oy}" x2="${ox + w * f}" y2="${oy + h}" stroke="#FF2D7A" stroke-width="1.5" stroke-dasharray="6 4" opacity="0.85"/>`,
          `<line x1="${ox}" y1="${oy + h * f}" x2="${ox + w}" y2="${oy + h * f}" stroke="#FF2D7A" stroke-width="1.5" stroke-dasharray="6 4" opacity="0.85"/>`);
      }
      const c = (it.reading as any)?.composition?.centroid;
      if (c) parts.push(`<circle cx="${ox + w * c.x}" cy="${oy + h * c.y}" r="7" fill="none" stroke="#FF2D7A" stroke-width="2.5"/>`);
    }
    const r = it.reading as any;
    let sx = x;
    const sy = y + imgH + 4;
    if (strip && r && overlays.includes("palette")) {
      const pw = overlays.includes("histogram") ? imgW * 0.7 : imgW;
      for (const p of r.palette as Array<{ hex: string; share: number }>) {
        const ww = Math.max(1, pw * p.share);
        parts.push(`<rect x="${sx}" y="${sy}" width="${ww}" height="${strip - 8}" fill="${p.hex}"/>`);
        sx += ww;
      }
    }
    if (strip && r && overlays.includes("histogram")) {
      const hx = x + (overlays.includes("palette") ? imgW * 0.72 : 0), hw = imgW - (hx - x), hist = r.luminance.histogram as number[], mx = Math.max(...hist) || 1;
      hist.forEach((v, k) => parts.push(`<rect x="${hx + k * hw / 8}" y="${sy + (strip - 8) * (1 - v / mx)}" width="${hw / 8 - 1}" height="${(strip - 8) * v / mx}" fill="${["#111", "#333", "#555", "#777", "#999", "#AAA", "#CCC", "#DDD"][k]}" stroke="#888" stroke-width="0.5"/>`));
    }
    const ly = y + imgH + strip + 20;
    parts.push(`<text x="${x}" y="${ly}" font-family="sans-serif" font-size="16" font-weight="700" fill="#111">${escapeXml(it.title.slice(0, 48))}</text>`);
    if (it.detail) parts.push(`<text x="${x}" y="${ly + 22}" font-family="sans-serif" font-size="14" fill="#333">${escapeXml(it.detail.slice(0, 58))}</text>`);
  }
  await mkdir(join(out, ".."), { recursive: true });
  await writeFile(out, await rasterizeSvg(svgDocument(parts.join(""), W, H, title ?? "Studio review sheet")));
  await writeFile(`${out}.json`, JSON.stringify({ items: items.map(i => ({ path: i.path, title: i.title, detail: i.detail })), overlays }, null, 2));
  return out;
}

/** Crop a region at full resolution, because defects in hands, text and edges vanish when downsized. */
export async function zoomRegion(path: string, region: string | [number, number, number, number], out: string): Promise<{ path: string; box: number[] }> {
  const { decodeRGBA } = await import("../imageops.js");
  const { encodePng } = await import("../bgremove.js");
  const img = await decodeRGBA(await readFile(path));
  const named: Record<string, [number, number, number, number]> = {
    "top-left": [0, 0, 1 / 3, 1 / 3], "top-centre": [1 / 3, 0, 1 / 3, 1 / 3], "top-right": [2 / 3, 0, 1 / 3, 1 / 3],
    "middle-left": [0, 1 / 3, 1 / 3, 1 / 3], centre: [1 / 3, 1 / 3, 1 / 3, 1 / 3], "middle-right": [2 / 3, 1 / 3, 1 / 3, 1 / 3],
    "bottom-left": [0, 2 / 3, 1 / 3, 1 / 3], "bottom-centre": [1 / 3, 2 / 3, 1 / 3, 1 / 3], "bottom-right": [2 / 3, 2 / 3, 1 / 3, 1 / 3],
  };
  const f = typeof region === "string" ? named[region.replace("center", "centre")] : region;
  if (!f || f.some(v => typeof v !== "number" || v < 0 || v > 1) || f[2] <= 0 || f[3] <= 0) {
    throw new Error(`Unknown region ${JSON.stringify(region)}. Use a thirds cell (${Object.keys(named).join(", ")}) or [x, y, w, h] as fractions 0-1.`);
  }
  const x0 = Math.round(f[0] * img.width), y0 = Math.round(f[1] * img.height);
  const w = Math.max(1, Math.min(img.width - x0, Math.round(f[2] * img.width))), h = Math.max(1, Math.min(img.height - y0, Math.round(f[3] * img.height)));
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) img.data.copy(data, y * w * 4, ((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4);
  await mkdir(join(out, ".."), { recursive: true });
  await writeFile(out, encodePng({ width: w, height: h, data }));
  return { path: out, box: [x0, y0, w, h] };
}

/** A blind pair: shown as A and B in random order, with nothing that says which is newer. */
export async function blindPair(dir: string, a: { ref: string; path: string }, b: { ref: string; path: string }) {
  const swap = randomBytes(1)[0]! % 2 === 1;
  const [A, B] = swap ? [b, a] : [a, b];
  const id = `p${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const out = join(dir, "views", `pair-${id}.png`);
  await reviewSheet([{ path: A.path, title: "A" }, { path: B.path, title: "B" }], out, []);
  await writeFile(join(dir, "views", `pair-${id}.json`), JSON.stringify({ id, A: A.ref, B: B.ref, created: new Date().toISOString() }));
  return { id, sheet: out };
}

export async function readPair(dir: string, id: string): Promise<{ A: string; B: string } | null> {
  if (!/^p[a-z0-9]+$/.test(id)) return null;
  try { return JSON.parse(await readFile(resolve(dir, "views", `pair-${id}.json`), "utf8")); } catch { return null; }
}

// ---------------------------------------------------------------- study a reference

export type VisionAsk = (images: Array<{ bytes: Buffer; mime: string }>, question: string) => Promise<string>;

/** Read an admired image and describe its look in shot language, as a ready style node. It names
 *  the dimensions of a look to learn from; it does not copy the image. One vision request. */
export async function studyReference(path: string, ask?: VisionAsk): Promise<{ reading?: Reading; summary: string; shot: Record<string, string>; note?: string }> {
  const { SHOT_DIMENSIONS } = await import("./nodes.js");
  const reading = await readingOf(path);
  const summary = await summaryOf(reading);
  const keys = Object.keys(SHOT_DIMENSIONS);
  const question = "Describe the photographic and artistic look of this image as shot language, so another image can learn from it without copying its subject. " +
    `Reply with ONLY minified JSON with these keys, each a short phrase (max 12 words), or omit a key you cannot judge: ${keys.join(", ")}. ` +
    `Meaning of each key: ${keys.map(k => `${k} = ${(SHOT_DIMENSIONS as Record<string, string>)[k]}`).join(" ")} ` +
    `Measured facts you can rely on: ${summary}.`;
  try {
    const bytes = await readFile(path);
    const mime = /\.jpe?g$/i.test(path) ? "image/jpeg" : /\.webp$/i.test(path) ? "image/webp" : "image/png";
    const raw = await (ask ?? (await import("../proof.js")).askVision)([{ bytes, mime }], question);
    const m = /\{[\s\S]*\}/.exec(raw);
    const parsed = m ? JSON.parse(m[0]) as Record<string, unknown> : {};
    const shot: Record<string, string> = {};
    for (const k of keys) if (typeof parsed[k] === "string" && (parsed[k] as string).trim()) shot[k] = (parsed[k] as string).trim().slice(0, 120);
    return { reading, summary, shot, ...(Object.keys(shot).length ? {} : { note: "The vision reply had no usable shot fields; only the reading is available." }) };
  } catch (e) {
    return { reading, summary, shot: {}, note: `Vision description failed (${e instanceof Error ? e.message : e}); only the local reading is available.` };
  }
}
