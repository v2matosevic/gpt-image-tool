// Memory that outlives a session: lessons, the owner's taste, and how well agents predict it.
// Lessons live per project (<project>/.gptimage/studio/_lessons/) and per user
// (~/.gptimage/studio/_lessons/, or GPT_IMAGE_STUDIO_HOME/.gptimage/studio/_lessons/), one JSON
// file each. A lesson is never edited: a newer one supersedes it. Taste is counted from what
// people approved, rejected and picked (feedback.jsonl); it is reported as counts, never as a rule.

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { LESSONS_DIR } from "./types.js";
import { StudioError, atomicWrite, graphDir, listGraphSlugs, now, paths, studioRoot } from "./store.js";

export const LESSON_SCHEMA = "gpt-image-studio/lesson@1";
export type LessonScope = "project" | "user";

export interface Lesson {
  schema: typeof LESSON_SCHEMA;
  id: string;
  claim: string;
  /** What it is about, e.g. "shot.key_light", "palette", "prompt wording". */
  dimension: string;
  evidence: Array<{ graph: string; takes: string[] }>;
  /** How many takes support it (one take is never a lesson). */
  support: number;
  date: string;
  by: string;
  /** What the evidence was rendered on: "subscription gpt-image-2", "api gpt-image-2.6-sunburst", or
   *  "mixed: ..." (older lessons: "subscription auto (unknown model)"). A lesson learned on one
   *  renderer is not presented as true of another. */
  renderer: string;
  scope: LessonScope;
  supersedes?: string;
  project?: string;
}

export function userHome(): string { return process.env.GPT_IMAGE_STUDIO_HOME || homedir(); }
export function lessonsDir(project: string, scope: LessonScope): string {
  return join(studioRoot(scope === "user" ? userHome() : project), LESSONS_DIR);
}

async function readDir(dir: string): Promise<Lesson[]> {
  if (!existsSync(dir)) return [];
  const out: Lesson[] = [];
  for (const f of await readdir(dir)) {
    if (!/^l[a-z0-9]+\.json$/.test(f)) continue;
    try { out.push(JSON.parse(await readFile(join(dir, f), "utf8"))); } catch { /* skip a broken file */ }
  }
  return out;
}

export async function allLessons(project: string): Promise<Lesson[]> {
  const proj = await readDir(lessonsDir(project, "project"));
  const user = lessonsDir(project, "user") === lessonsDir(project, "project") ? [] : await readDir(lessonsDir(project, "user"));
  return [...proj, ...user];
}

/** Lessons nobody has superseded, most supported first, then newest. Older lessons weigh less:
 *  the routed renderer can change, so support halves every 90 days for ranking. */
export async function activeLessons(project: string): Promise<Array<Lesson & { weight: number }>> {
  const all = await allLessons(project);
  const superseded = new Set(all.map(l => l.supersedes).filter(Boolean));
  const t = Date.now();
  return all.filter(l => !superseded.has(l.id))
    .map(l => ({ ...l, weight: l.support * 0.5 ** ((t - Date.parse(l.date)) / (90 * 86_400_000)) }))
    .sort((a, b) => b.weight - a.weight || b.date.localeCompare(a.date));
}

export async function writeLesson(project: string, input: Omit<Lesson, "schema" | "id" | "date" | "renderer"> & { renderer?: string }): Promise<Lesson> {
  if (input.support < 2) throw new StudioError("ONE_TAKE", "A lesson needs at least two takes of evidence; one take is never a lesson.", "Run a sweep or new_take:true to get more takes, then cite them all.");
  const all = await allLessons(project);
  if (input.supersedes && !all.some(l => l.id === input.supersedes)) throw new StudioError("NO_LESSON", `No lesson "${input.supersedes}" to supersede.`, `Lessons: ${all.map(l => l.id).join(", ") || "(none)"}.`);
  if (input.supersedes && all.some(l => l.supersedes === input.supersedes)) throw new StudioError("ALREADY_SUPERSEDED", `Lesson "${input.supersedes}" is already superseded.`, "Supersede the newer lesson instead.");
  const lesson: Lesson = { schema: LESSON_SCHEMA, id: `l${Date.now().toString(36)}${randomBytes(2).toString("hex")}`, date: now(), renderer: input.renderer ?? "subscription auto (unknown model)", ...input };
  const dir = lessonsDir(project, input.scope);
  await mkdir(dir, { recursive: true });
  await atomicWrite(join(dir, `${lesson.id}.json`), JSON.stringify(lesson, null, 2) + "\n");
  return lesson;
}

export function lessonLine(l: Lesson): string {
  return `${l.id} [${l.scope}, ${l.date.slice(0, 10)}, ${l.support} takes, ${l.renderer}] ${l.dimension}: ${l.claim}`;
}

/** The renderer label for a lesson's evidence takes. */
export function rendererOfTakes(takes: Array<{ render?: { renderer: string; model: string } }>): string {
  const labels = [...new Set(takes.map(t => (t.render?.renderer === "api" ? `api ${t.render.model}` : "subscription gpt-image-2")))];
  return labels.length === 1 ? labels[0]! : `mixed: ${labels.join(" + ")}`;
}
export const rendererFamily = (label: string): "subscription" | "api" | "mixed" => (label.startsWith("api") ? "api" : label.startsWith("mixed") ? "mixed" : "subscription");

// ---------------------------------------------------------------- taste and calibration

interface FeedbackRec { ts: string; by: string; graph: string; action: string; human?: boolean; node: string; take: string; settings?: Record<string, any>; reading?: any; decision?: string; reason?: string }

async function projectFeedback(project: string): Promise<FeedbackRec[]> {
  const out: FeedbackRec[] = [];
  for (const slug of await listGraphSlugs(project).catch(() => [] as string[])) {
    const file = paths(graphDir(project, slug)).feedback;
    if (!existsSync(file)) continue;
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* a torn last line */ }
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

const centred = (r: any) => r?.composition && (r.composition.heaviest === "centre" || Math.hypot(r.composition.centroid.x - 0.5, r.composition.centroid.y - 0.5) < 0.1);

/** Counts of what people kept and dropped, by measured and requested attributes. Only buckets
 *  with at least two human decisions are reported. */
export async function tasteSummary(project: string, max = 6): Promise<string[]> {
  const fb = (await projectFeedback(project)).filter(f => f.human && ["approve", "reject", "pick"].includes(f.action));
  // Latest human decision per take.
  const last = new Map<string, FeedbackRec>();
  for (const f of fb) last.set(`${f.graph}/${f.node}/${f.take}`, f);
  const decisions = [...last.values()];
  if (!decisions.length) return [];
  const buckets = new Map<string, { kept: number; dropped: number }>();
  const add = (k: string, kept: boolean) => { const b = buckets.get(k) ?? { kept: 0, dropped: 0 }; kept ? b.kept++ : b.dropped++; buckets.set(k, b); };
  for (const d of decisions) {
    const kept = d.action !== "reject";
    const r = d.reading;
    if (r?.luminance) add(`${r.luminance.key}-key`, kept);
    if (r?.color) { add(r.color.temperature, kept); add(r.color.saturation, kept); }
    if (r?.composition) add(centred(r) ? "centred composition" : "off-centre composition", kept);
    for (const [k, v] of Object.entries(d.settings?.shot ?? {})) add(`shot.${k} "${v}"`, kept);
    if (d.settings?.preset) add(`preset ${d.settings.preset}`, kept);
  }
  const lines = [...buckets].filter(([, b]) => b.kept + b.dropped >= 2)
    .map(([k, b]) => ({ k, b, n: b.kept + b.dropped, skew: Math.abs(b.kept - b.dropped) / (b.kept + b.dropped) }))
    .sort((a, b) => b.skew - a.skew || b.n - a.n).slice(0, max)
    .map(({ k, b, n }) => `${k}: kept ${b.kept} of ${n}`);
  return [`From ${decisions.length} human decision(s) in this project (counts, not rules):`, ...lines];
}

export interface CalibrationRec { ts: string; project: string; graph: string; take: string; predictedBy: string; predicted: string; decided: string; agree: boolean }

const kept = (x: string) => x === "approved" || x === "picked" || x === "approve" || x === "pick";

/** Agent predictions made before a person decided, compared with that decision. */
export function calibrationFrom(fb: FeedbackRec[], project: string): CalibrationRec[] {
  const out: CalibrationRec[] = [];
  const preds = fb.filter(f => f.action === "predict" && f.decision);
  const decided = new Set<string>();
  for (const f of fb) {
    if (!f.human || !["approve", "reject", "pick"].includes(f.action)) continue;
    const key = `${f.graph}/${f.node}/${f.take}`;
    if (decided.has(key)) continue; // only the first human decision counts
    decided.add(key);
    for (const p of preds) {
      if (`${p.graph}/${p.node}/${p.take}` !== key || p.ts >= f.ts) continue;
      out.push({ ts: f.ts, project, graph: f.graph, take: `${f.node}/${f.take}`, predictedBy: p.by, predicted: p.decision!, decided: f.action, agree: kept(p.decision!) === kept(f.action) });
    }
  }
  return out;
}

export async function calibration(project: string): Promise<{ project: { agree: number; total: number }; overall?: { agree: number; total: number } }> {
  const recs = calibrationFrom(await projectFeedback(project), project);
  const res: { project: { agree: number; total: number }; overall?: { agree: number; total: number } } = { project: { agree: recs.filter(r => r.agree).length, total: recs.length } };
  const file = join(lessonsDir(project, "user"), "calibration.jsonl");
  if (existsSync(file)) {
    const seen = new Map<string, CalibrationRec>();
    for (const line of (await readFile(file, "utf8")).split("\n")) { try { const r = JSON.parse(line) as CalibrationRec; seen.set(`${r.project}|${r.graph}|${r.take}|${r.predictedBy}`, r); } catch { /* skip */ } }
    for (const r of recs) seen.set(`${r.project}|${r.graph}|${r.take}|${r.predictedBy}`, r);
    const all = [...seen.values()];
    res.overall = { agree: all.filter(r => r.agree).length, total: all.length };
  }
  return res;
}

/** Called after a person's decision is written: copy new calibration records to the user store,
 *  so the overall rate spans projects. */
export async function recordCalibration(project: string, graph: string, takes: string[]): Promise<void> {
  if (!takes.length) return;
  const recs = calibrationFrom(await projectFeedback(project), project).filter(r => r.graph === graph && takes.includes(r.take));
  if (!recs.length) return;
  const dir = lessonsDir(project, "user");
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, "calibration.jsonl"), recs.map(r => JSON.stringify(r)).join("\n") + "\n");
}

/** The short block studio_create and studio_guide return without being asked. */
export async function memoryBrief(project: string, maxLessons = 5, renderer: "subscription" | "api" = "subscription"): Promise<string> {
  const lines: string[] = [];
  const all = await activeLessons(project).catch(() => []);
  // Lessons learned on the renderer in use come first; others are labelled as unverified on it.
  const lessons = [...all.filter(l => rendererFamily(l.renderer) === renderer), ...all.filter(l => rendererFamily(l.renderer) !== renderer)];
  if (lessons.length) lines.push(`Lessons (most supported first; those learned on the ${renderer} renderer listed first):`, ...lessons.slice(0, maxLessons).map(l => `  ${lessonLine(l)}${rendererFamily(l.renderer) !== renderer ? ` (learned on ${l.renderer}; not checked on the ${renderer} renderer, so treat it as a guess there)` : ""}`));
  else lines.push('Lessons: none recorded yet in this project or your user store (write one with {op:"lesson"} once 2+ takes settle something).');
  const taste = await tasteSummary(project).catch(() => []);
  if (taste.length > 1) lines.push(taste[0]!, ...taste.slice(1).map(t => `  ${t}`));
  else if (taste.length) lines.push(`${taste[0]!.replace(/ \(counts, not rules\):$/, "")}; counts appear once an attribute has two or more decisions.`);
  else lines.push("Owner's taste: no decisions by a person recorded yet. Only a person's approve, reject and pick count (ADE, or the CLI with --human); an agent's approvals do not.");
  const cal = await calibration(project).catch(() => undefined);
  if (cal && cal.project.total) lines.push(`Agent predictions that matched the person's later decision: ${cal.project.agree} of ${cal.project.total} here${cal.overall?.total ? `, ${cal.overall.agree} of ${cal.overall.total} overall` : ""}.`);
  else lines.push("Prediction agreement: nothing to compare yet (an agent's predict must come before a person's decision on the same take).");
  return lines.join("\n");
}
