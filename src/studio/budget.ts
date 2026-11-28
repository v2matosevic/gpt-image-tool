// Paid-API spend: the ledgers, the limits and the owner's grants.
//
// Two levels, both append-only and written only under their own cross-process lock:
// - the project: <project>/.gptimage/studio/_budget/<local day>.jsonl, with per-run (resume chain),
//   per-day and ceiling limits from the profile's studio.limits;
// - the user: <home>/.gptimage/budget/<local day>.jsonl, with a daily limit and a ceiling across
//   every project, set only in <home>/.gptimage/config.json so no project profile can raise it.
// Every paid API request (Studio slots and direct tool calls alike) is first *reserved* at its
// estimated cost in both, then *settled* at the cost its reported usage implies. The check and the
// reservation happen under both locks (user first, then project, always in that order), so
// concurrent runs and processes cannot both pass a limit only one of them fits in, and a crashed
// request keeps counting at its estimate.
//
// Fail closed: a line that does not parse, or parses to an entry with impossible numbers, stops
// every limit check with the file and line named; it is never skipped, so a torn or hand-edited line
// cannot lower a tally. Clock: days follow the machine's local clock. Spend recorded under a later
// date than today (the clock was set back) counts against today; grants recorded under a later date
// do not apply. A clock set forward starts a new day early; that cannot be detected from the files.
//
// This is a guard against runaway mistakes by a cooperating agent, not a security boundary: anything
// with shell access can edit a profile, the user config, or append a grant nobody gave. The ledger is
// the audit trail that makes it visible (studio_budget shows who recorded each grant and from where).

import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BUDGET_DIR, BUDGET_SCHEMA } from "./types.js";
import { StudioError, now, studioRoot, withLock } from "./store.js";
import { DEFAULT_LIMITS } from "./render.js";
import { dollars } from "../pricing.js";

export type Limits = { run: number; day: number; ceiling: number };
export type UserLimits = { day: number; ceiling: number };
export const DEFAULT_USER_LIMITS: UserLimits = { day: 25, ceiling: 100 };
/** The graph name direct tool calls (generate_image, edit_image, ... outside Studio) are filed under. */
export const DIRECT = "_direct";

export interface Reservation { t: "reserve"; id: string; ts: string; day: string; run: string; chain: string; graph: string; node: string; slot: string; estimate: number; model: string; funding: string; by: string }
export interface Settlement { t: "settle"; id: string; ts: string; cost: number; uncertain?: boolean; take?: string; note?: string }
export interface Grant {
  t: "grant"; id: string; ts: string; day: string;
  amount: number;
  /** Project-wide, or one graph. */
  graph?: string;
  approvedBy: string;
  /** The owner's words, as said in chat (or "ADE button"). */
  words: string;
  /** ISO time. Default: the end of the local day it was recorded. */
  expires: string;
  /** "app": recorded by ADE from a person's click (CLI --from-app). "agent": recorded by an agent
   *  after the owner approved in chat. Neither is proof; the trail is what makes misuse visible. */
  source: "agent" | "app";
  by: string;
}
/** The user-level ledger's copy of a reservation (no grants live there). */
export interface UserReservation { t: "reserve"; id: string; ts: string; day: string; project: string; graph: string; estimate: number; funding: string; by: string }
export type LedgerEntry = (Reservation | Settlement | Grant) & { schema?: string };
type UserEntry = (UserReservation | Settlement) & { schema?: string };

// ---------------------------------------------------------------- places

export const ledgerDir = (project: string) => join(studioRoot(project), BUDGET_DIR);
/** The single-file ledger used before per-day files (2026-11-28 only). Read, never written. */
export const legacyLedgerPath = (project: string) => join(ledgerDir(project), "ledger.jsonl");
export const dayFile = (dir: string, day: string) => join(dir, `${day}.jsonl`);
const userHome = (env: NodeJS.ProcessEnv = process.env) => join(env.GPT_IMAGE_SECRETS_HOME || homedir(), ".gptimage");
export const userLedgerDir = (env: NodeJS.ProcessEnv = process.env) => join(userHome(env), "budget");
export const userConfigPath = (env: NodeJS.ProcessEnv = process.env) => join(userHome(env), "config.json");

/** The local calendar day, YYYY-MM-DD. Day limits and grant expiry follow the machine's clock. */
export function localDay(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function endOfLocalDay(d = new Date()): string {
  const e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  return e.toISOString();
}
const dayBefore = (day: string) => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() - 1); return localDay(d); };

/** The user-level limits, from <home>/.gptimage/config.json {"limits": {"day": 25, "ceiling": 100}}.
 *  A config that exists but cannot be read refuses paid requests rather than guessing. */
export function userLimits(env: NodeJS.ProcessEnv = process.env): UserLimits & { path: string; configured: boolean } {
  const path = userConfigPath(env);
  if (!existsSync(path)) return { ...DEFAULT_USER_LIMITS, path, configured: false };
  const bad = (why: string) => new StudioError("BUDGET_CONFIG", `${path} ${why}, so no paid request can be checked against the user-level limit.`, `Fix it, for example {"limits": {"day": ${DEFAULT_USER_LIMITS.day}, "ceiling": ${DEFAULT_USER_LIMITS.ceiling}}} (dollars), or remove the file for those defaults.`);
  let raw: any;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { throw bad("is not valid JSON"); }
  const l = raw?.limits ?? {};
  const num = (v: unknown, name: string) => {
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw bad(`has limits.${name} that is not a non-negative number of dollars`);
    return v;
  };
  const ceiling = num(l.ceiling, "ceiling") ?? DEFAULT_USER_LIMITS.ceiling;
  const day = Math.min(num(l.day, "day") ?? DEFAULT_USER_LIMITS.day, ceiling);
  return { day, ceiling, path, configured: true };
}

// ---------------------------------------------------------------- reading (strict)

const finite = (x: unknown, min = 0) => typeof x === "number" && Number.isFinite(x) && x >= min;
const str = (x: unknown) => typeof x === "string" && x.length > 0;

function entryProblem(e: any): string | undefined {
  if (!e || typeof e !== "object") return "is not an object";
  if (e.t === "reserve") return str(e.id) && str(e.day) && finite(e.estimate) && str(e.funding) ? undefined : "is a reservation without id, day, funding or a valid estimate";
  if (e.t === "settle") return str(e.id) && finite(e.cost) ? undefined : "is a settlement without id or a valid cost";
  if (e.t === "grant") return str(e.id) && str(e.day) && finite(e.amount) && e.amount > 0 && !Number.isNaN(Date.parse(e.expires)) ? undefined : "is a grant without id, day, a positive amount or a valid expiry";
  return `has an unknown type ${JSON.stringify(e.t)}`;
}

async function readFileStrict<T>(file: string): Promise<T[]> {
  let text: string;
  try { text = await readFile(file, "utf8"); } catch (e: any) { if (e?.code === "ENOENT") return []; throw e; }
  const out: T[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    let e: any, problem: string | undefined;
    try { e = JSON.parse(line); problem = entryProblem(e); } catch { problem = "is not valid JSON (a torn write, or a hand edit)"; }
    if (problem) {
      throw new StudioError("BUDGET_LEDGER", `Spend ledger ${file} line ${i + 1} ${problem}. Paid requests are refused until it is fixed, because a line that cannot be counted could hide spend.`,
        `Look at that line. If it is a torn last line from a crash, the request it belonged to may have been sent: replace it with a settlement at a known cost, or delete it if you are sure. Never delete valid lines.`);
    }
    out.push(e as T);
  }
  return out;
}

/** Entries from day files dated `from` or later (later dates included: see "Clock" above), plus the
 *  frozen legacy file when there is one. Only those files are read, so the work stays bounded. */
async function readFrom<T>(dir: string, from: string, legacy?: string): Promise<T[]> {
  let names: string[] = [];
  try { names = await readdir(dir); } catch { /* none yet */ }
  const days = names.filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map(n => n.slice(0, 10)).filter(d => d >= from).sort();
  const out: T[] = [];
  if (legacy && existsSync(legacy)) out.push(...await readFileStrict<T>(legacy));
  for (const d of days) out.push(...await readFileStrict<T>(dayFile(dir, d)));
  return out;
}

/** Every entry of a project's ledger (all days). For audits and tests; limit checks read less. */
export async function readLedger(project: string): Promise<LedgerEntry[]> {
  return readFrom<LedgerEntry>(ledgerDir(project), "0000-00-00", legacyLedgerPath(project));
}
export async function readUserLedger(env: NodeJS.ProcessEnv = process.env): Promise<UserEntry[]> {
  return readFrom<UserEntry>(userLedgerDir(env), "0000-00-00");
}

/** Reservation ids carry their local day, so a settlement lands in the reservation's own file. */
const newReservationId = (day: string) => `s${day.replace(/-/g, "")}-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const dayOfId = (id: string) => { const m = /^s(\d{4})(\d{2})(\d{2})-/.exec(id); return m ? `${m[1]}-${m[2]}-${m[3]}` : localDay(); };
/** The first local day a resume chain can have spent on: job ids carry their UTC start date. */
function chainFrom(chain: string): string {
  const m = /^r(\d{4})(\d{2})(\d{2})-/.exec(chain);
  return m ? dayBefore(`${m[1]}-${m[2]}-${m[3]}`) : localDay();
}

async function append(dir: string, day: string, entries: Array<Record<string, unknown>>) {
  await mkdir(dir, { recursive: true });
  await appendFile(dayFile(dir, day), entries.map(e => JSON.stringify({ schema: BUDGET_SCHEMA, ...e })).join("\n") + "\n");
}

async function lockedProject<T>(project: string, actor: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(ledgerDir(project), { recursive: true });
  return withLock(join(ledgerDir(project), ".lock"), actor, fn);
}
async function lockedUser<T>(actor: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(userLedgerDir(), { recursive: true });
  return withLock(join(userLedgerDir(), ".lock"), actor, fn);
}

// ---------------------------------------------------------------- arithmetic

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

interface Tally<R extends { id: string; estimate: number }> {
  /** Dollars per reservation: the settled cost, else the estimate (in flight or crashed). */
  amount: Map<string, number>;
  reservations: R[];
  grants: Grant[];
  settled: Map<string, Settlement>;
}

function tally<R extends { id: string; estimate: number }>(entries: Array<{ t: string }>): Tally<R> {
  const reservations: R[] = [], grants: Grant[] = [];
  const settled = new Map<string, Settlement>();
  for (const e of entries) {
    if (e.t === "reserve") reservations.push(e as unknown as R);
    else if (e.t === "settle") settled.set((e as Settlement).id, e as Settlement);
    else if (e.t === "grant") grants.push(e as Grant);
  }
  const amount = new Map<string, number>();
  for (const r of reservations) amount.set(r.id, settled.get(r.id)?.cost ?? r.estimate);
  return { amount, reservations, grants, settled };
}

const sum = <R extends { id: string; estimate: number }>(t: Tally<R>, f: (r: R) => boolean) => r6(t.reservations.filter(f).reduce((a, r) => a + (t.amount.get(r.id) ?? 0), 0));
/** Today's spend: today's entries and any dated later (the clock was set back). */
const isToday = (day: string) => (r: { day: string }) => r.day >= day;

function grantActive(g: Grant, graph: string | undefined, today: string, at = Date.now()): boolean {
  return g.day <= today && Date.parse(g.expires) > at && (!g.graph || !graph || g.graph === graph);
}

export interface BudgetView {
  project: string;
  day: string;
  limits: Limits;
  spentToday: number;
  /** Of spentToday: reservations not settled yet (in flight, or a crashed request kept at its estimate). */
  unsettledToday: number;
  byGraph: Record<string, number>;
  /** Of spentToday: direct tool calls outside Studio. */
  directToday: number;
  grants: Array<Grant & { drawn: number; remaining: number; active: boolean }>;
  /** What can still be spent today without a grant, and with active project-wide grants. */
  normalLeft: number;
  ceilingLeft: number;
  ledger: string;
  user: { limits: UserLimits; configured: boolean; config: string; spentToday: number; byProject: Record<string, number>; normalLeft: number; ceilingLeft: number; ledger: string };
}

export async function budgetView(project: string, limits: Limits, graph?: string): Promise<BudgetView> {
  const day = localDay();
  const t = tally<Reservation>(await readFrom(ledgerDir(project), day, legacyLedgerPath(project)));
  const today = isToday(day);
  const spentToday = sum(t, today);
  const unsettledToday = r6(t.reservations.filter(r => today(r) && !t.settled.has(r.id)).reduce((a, r) => a + r.estimate, 0));
  const byGraph: Record<string, number> = {};
  for (const r of t.reservations.filter(today)) byGraph[r.graph] = r6((byGraph[r.graph] ?? 0) + (t.amount.get(r.id) ?? 0));
  const grants = t.grants.filter(g => g.day === day || (g.day <= day && Date.parse(g.expires) > Date.now())).map(g => {
    const drawn = sum(t, r => r.funding === `grant:${g.id}`);
    return { ...g, drawn, remaining: r6(Math.max(0, g.amount - drawn)), active: grantActive(g, graph, day) && g.amount - drawn > 0 };
  });
  const ul = userLimits();
  const u = tally<UserReservation>(await readFrom(userLedgerDir(), day));
  const userSpent = sum(u, isToday(day));
  const byProject: Record<string, number> = {};
  for (const r of u.reservations.filter(isToday(day))) byProject[r.project] = r6((byProject[r.project] ?? 0) + (u.amount.get(r.id) ?? 0));
  return { project, day, limits, spentToday, unsettledToday, byGraph, directToday: byGraph[DIRECT] ?? 0, grants,
    normalLeft: r6(Math.max(0, Math.min(Math.min(limits.day, limits.ceiling) - spentToday, ul.day - userSpent))), ceilingLeft: r6(Math.max(0, Math.min(limits.ceiling - spentToday, ul.ceiling - userSpent))), ledger: ledgerDir(project),
    user: { limits: { day: ul.day, ceiling: ul.ceiling }, configured: ul.configured, config: ul.path, spentToday: userSpent, byProject, normalLeft: r6(Math.max(0, ul.day - userSpent)), ceilingLeft: r6(Math.max(0, ul.ceiling - userSpent)), ledger: userLedgerDir() } };
}

// ---------------------------------------------------------------- reserve / settle

export type StopCode = "budget-run" | "budget-day" | "budget-ceiling" | "budget-user-day" | "budget-user-ceiling";
export interface ReserveRequest { project: string; run: string; chain: string; graph: string; node: string; slot: string; estimate: number; model: string; limits: Limits; actor: string }
export type ReserveResult =
  | { ok: true; id: string; funding: string }
  | { ok: false; code: StopCode; message: string; spentRun: number; spentDay: number };

/** Check every limit and reserve the estimate, atomically, in the project and the user ledger.
 *  Funding is "limit" while the run, project day and user day limits all have room; past any of
 *  them, an active grant in scope must cover the whole request. The project ceiling and the user
 *  ceiling are never exceeded, grant or not. Throws BUDGET_LEDGER / BUDGET_CONFIG (fail closed). */
export async function reserve(q: ReserveRequest): Promise<ReserveResult> {
  return lockedUser(q.actor, () => lockedProject(q.project, q.actor, async () => {
    const day = localDay();
    const from = q.chain.startsWith("r") ? [chainFrom(q.chain), day].sort()[0]! : day;
    const t = tally<Reservation>(await readFrom(ledgerDir(q.project), from, legacyLedgerPath(q.project)));
    const ul = userLimits();
    const u = tally<UserReservation>(await readFrom(userLedgerDir(), day));
    const spentDay = sum(t, isToday(day));
    const spentRun = sum(t, r => r.chain === q.chain);
    const spentUser = sum(u, isToday(day));
    const e = q.estimate;
    const L = q.limits;
    const no = (code: StopCode, message: string): ReserveResult => ({ ok: false, code, spentRun, spentDay, message });
    if (spentDay + e > L.ceiling + 1e-9) return no("budget-ceiling", `The project's hard ceiling of ${dollars(L.ceiling)} a day would be passed (spent today ${dollars(spentDay)}, next image about ${dollars(e)}). No grant can lift it; only the owner can, by editing studio.limits.ceiling in .gptimage.json.`);
    if (spentUser + e > ul.ceiling + 1e-9) return no("budget-user-ceiling", `The user-level ceiling of ${dollars(ul.ceiling)} a day across all projects would be passed (spent today across projects ${dollars(spentUser)}, next image about ${dollars(e)}). No grant can lift it; only the owner can, in ${ul.path}.`);
    let funding: string | undefined;
    if (spentRun + e <= L.run + 1e-9 && spentDay + e <= L.day + 1e-9 && spentUser + e <= ul.day + 1e-9) funding = "limit";
    else {
      const g = t.grants.filter(g => grantActive(g, q.graph, day)).map(g => ({ g, left: g.amount - sum(t, r => r.funding === `grant:${g.id}`) }))
        .filter(x => x.left + 1e-9 >= e).sort((a, b) => Date.parse(a.g.expires) - Date.parse(b.g.expires))[0];
      if (g) funding = `grant:${g.g.id}`;
    }
    if (!funding) {
      const what = q.graph === DIRECT ? "This tool call's spend limit" : "This run's spend limit";
      if (spentRun + e > L.run + 1e-9) return no("budget-run", `${what} of ${dollars(L.run)} would be passed (${q.graph === DIRECT ? "this call" : "this run"} has spent ${dollars(spentRun)}, next image about ${dollars(e)}).`);
      if (spentDay + e > L.day + 1e-9) return no("budget-day", `Today's spend limit of ${dollars(L.day)} for this project would be passed (spent today ${dollars(spentDay)}, next image about ${dollars(e)}).`);
      return no("budget-user-day", `Today's spend limit of ${dollars(ul.day)} across all projects would be passed (spent today across projects ${dollars(spentUser)}, next image about ${dollars(e)}). It is set in ${ul.path}, which no project can change.`);
    }
    const id = newReservationId(day);
    const ts = now();
    // User first: if the process dies between the two writes, the cross-project limit still counts it.
    await append(userLedgerDir(), day, [{ t: "reserve", id, ts, day, project: q.project, graph: q.graph, estimate: r6(e), funding, by: q.actor }]);
    await append(ledgerDir(q.project), day, [{ t: "reserve", id, ts, day, run: q.run, chain: q.chain, graph: q.graph, node: q.node, slot: q.slot, estimate: r6(e), model: q.model, funding, by: q.actor }]);
    return { ok: true, id, funding };
  }));
}

/** Record what a reserved request actually cost, in both ledgers. A request that failed with an
 *  HTTP error is settled at 0 (the API does not bill a refused request); an unknown failure keeps
 *  its estimate. */
export async function settle(project: string, actor: string, s: Omit<Settlement, "t" | "ts">): Promise<void> {
  if (!finite(s.cost)) throw new StudioError("BUDGET_LEDGER", `Refusing to record a settlement with cost ${s.cost}.`, "This is a Studio bug; the reservation keeps counting at its estimate.");
  const day = dayOfId(s.id);
  const entry = { t: "settle", ts: now(), ...s, cost: r6(s.cost) };
  await lockedUser(actor, () => lockedProject(project, actor, async () => {
    await append(userLedgerDir(), day, [{ t: "settle", ts: entry.ts, id: s.id, cost: entry.cost }]);
    await append(ledgerDir(project), day, [entry]);
  }));
}

/** Dollars a chain (a run and its resumes, or one direct tool call) has spent. */
export async function chainSpent(project: string, chain: string): Promise<number> {
  return sum(tally<Reservation>(await readFrom(ledgerDir(project), chainFrom(chain), legacyLedgerPath(project))), r => r.chain === chain);
}

// ---------------------------------------------------------------- grants

export interface GrantInput { amount: number; graph?: string; approvedBy: string; words: string; expires?: string; source: "agent" | "app"; by: string }

/** Record the owner's approval to spend past the normal limits. Never created by the tool itself. */
export async function recordGrant(project: string, limits: Limits, g: GrantInput): Promise<Grant> {
  if (!(g.amount > 0) || !Number.isFinite(g.amount)) throw new StudioError("BAD_GRANT", "A grant needs a positive dollar amount.", "Pass amount, e.g. 5 for five dollars, as the owner approved it.");
  if (g.amount > limits.ceiling) throw new StudioError("BAD_GRANT", `A grant of ${dollars(g.amount)} is above the ${dollars(limits.ceiling)} daily ceiling and could never be spent.`, "Record the amount the owner approved, at most the ceiling; only the owner can raise studio.limits.ceiling in .gptimage.json.");
  if (!g.words?.trim()) throw new StudioError("BAD_GRANT", "A grant needs the owner's words.", 'Pass words: what the owner said when approving, e.g. "approve, 5 dollars for the hero finals".');
  if (!g.approvedBy?.trim()) throw new StudioError("BAD_GRANT", "A grant needs who approved it.", "Pass approved_by: the name of the person who approved.");
  const expires = g.expires ? new Date(g.expires) : new Date(endOfLocalDay());
  if (Number.isNaN(expires.getTime())) throw new StudioError("BAD_GRANT", `expires "${g.expires}" is not a date.`, "Use an ISO date-time, or leave it out for the end of today.");
  if (expires.getTime() <= Date.now()) throw new StudioError("BAD_GRANT", "That expiry is already past.", "Leave expires out for the end of today.");
  if (expires.getTime() > Date.parse(endOfLocalDay()) + 1000) throw new StudioError("BAD_GRANT", "A grant ends with the local day it was given; unused budget does not carry over.", "Leave expires out, or give an earlier time today.");
  const day = localDay();
  const grant: Grant = { t: "grant", id: `g${Date.now().toString(36)}${randomBytes(2).toString("hex")}`, ts: now(), day, amount: r6(g.amount), ...(g.graph ? { graph: g.graph } : {}),
    approvedBy: g.approvedBy.trim(), words: g.words.trim().slice(0, 500), expires: expires.toISOString(), source: g.source, by: g.by };
  await lockedProject(project, g.by, async () => {
    await readFrom(ledgerDir(project), day, legacyLedgerPath(project)); // refuse to add to a ledger that does not parse
    await append(ledgerDir(project), day, [grant as unknown as Record<string, unknown>]);
  });
  return grant;
}

export function grantLine(g: BudgetView["grants"][number]): string {
  return `${g.id} ${dollars(g.amount)} ${g.graph ? `for graph ${g.graph}` : "project-wide"}, drawn ${dollars(g.drawn)}, left ${dollars(g.remaining)}, ${g.active ? `expires ${new Date(g.expires).toLocaleString()}` : Date.parse(g.expires) <= Date.now() ? "expired" : "used up"}; approved by ${g.approvedBy} ("${g.words}"), recorded by ${g.by} via ${g.source === "app" ? "ADE (a person's click)" : "an agent"}`;
}

export function budgetText(v: BudgetView): string {
  const lines = [
    `Paid API budget for ${v.project}, ${v.day} (local day):`,
    `  Project limits: ${dollars(v.limits.run)} per run or direct tool call, ${dollars(v.limits.day)} per day, hard ceiling ${dollars(v.limits.ceiling)} per day (studio.limits in .gptimage.json; defaults ${dollars(DEFAULT_LIMITS.run)}/${dollars(DEFAULT_LIMITS.day)}/${dollars(DEFAULT_LIMITS.ceiling)}).`,
    `  Spent today in this project: ${dollars(v.spentToday)}${v.unsettledToday ? ` (of which ${dollars(v.unsettledToday)} is reserved at estimate: in flight, or a request whose cost is unknown)` : ""}. Left without a grant: ${dollars(v.normalLeft)}; under the ceilings: ${dollars(v.ceilingLeft)}.`,
  ];
  const graphs = Object.entries(v.byGraph).filter(([g]) => g !== DIRECT);
  if (graphs.length) lines.push(`  By graph today: ${graphs.map(([g, x]) => `${g} ${dollars(x)}`).join(", ")}.`);
  lines.push(`  Direct tool calls today (generate_image, edit_image, ... outside Studio): ${dollars(v.directToday)}.`);
  if (v.grants.length) { lines.push("  Grants:"); for (const g of v.grants) lines.push(`    ${grantLine(g)}`); }
  else lines.push("  Grants: none today.");
  const u = v.user;
  lines.push(`  All projects (user level): spent today ${dollars(u.spentToday)} of ${dollars(u.limits.day)} a day; ceiling ${dollars(u.limits.ceiling)}, which no grant lifts (${u.configured ? u.config : `defaults; set them in ${u.config}`}, never in a project).`);
  const projects = Object.entries(u.byProject);
  if (projects.length) lines.push(`    By project today: ${projects.map(([p, x]) => `${p} ${dollars(x)}`).join("; ")}.`);
  lines.push(`  Ledgers (one file per local day; every reservation, settlement and grant): ${v.ledger}, ${u.ledger}`);
  lines.push("  This guards against runaway mistakes; it is not a security boundary. Anyone with shell access can edit the profile or the user config, or record a grant, and the ledger is what shows it.");
  return lines.join("\n");
}

/** Whether a grant was recorded after a moment (used to let a budget-stopped graph start again). */
export async function grantSince(project: string, graph: string, sinceIso: string): Promise<boolean> {
  const day = localDay();
  const t = tally<Reservation>(await readFrom(ledgerDir(project), day, legacyLedgerPath(project)));
  return t.grants.some(g => g.ts > sinceIso && grantActive(g, graph, day));
}
