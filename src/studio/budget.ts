// Paid-API spend: the ledger, the limits and the owner's grants.
//
// One append-only file per project, <project>/.gptimage/studio/_budget/ledger.jsonl, written only
// under its own cross-process lock (withLock, the lock mutate() uses for graphs). Every API request a
// Studio run sends is first *reserved* here at its estimated cost, then *settled* at the cost the
// API's reported usage implies. A check and its reservation happen under one lock, so concurrent
// runs (other graphs, other processes) cannot both pass a limit that only one of them fits in, and a
// crashed request keeps counting at its estimate. Spend is summed per local day for the day limit
// and per resume chain for the run limit, so neither a resume nor a second worker resets it.
//
// This is a guard against runaway mistakes by a cooperating agent, not a security boundary: anything
// with shell access can edit the profile or append a grant nobody gave. The ledger is the audit
// trail that makes such a grant visible (studio_budget shows who recorded each one and from where).

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BUDGET_DIR, BUDGET_SCHEMA } from "./types.js";
import { StudioError, now, studioRoot, withLock } from "./store.js";
import { DEFAULT_LIMITS } from "./render.js";
import { dollars } from "../pricing.js";

export type Limits = { run: number; day: number; ceiling: number };

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
export type LedgerEntry = (Reservation | Settlement | Grant) & { schema?: string };

export const ledgerDir = (project: string) => join(studioRoot(project), BUDGET_DIR);
export const ledgerPath = (project: string) => join(ledgerDir(project), "ledger.jsonl");
const lockPath = (project: string) => join(ledgerDir(project), ".lock");

/** The local calendar day, YYYY-MM-DD. Day limits and grant expiry follow the machine's clock. */
export function localDay(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function endOfLocalDay(d = new Date()): string {
  const e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  return e.toISOString();
}

export async function readLedger(project: string): Promise<LedgerEntry[]> {
  let text = "";
  try { text = await readFile(ledgerPath(project), "utf8"); } catch { return []; }
  const out: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line from a crash */ }
  }
  return out;
}

async function append(project: string, entries: LedgerEntry[]) {
  await mkdir(ledgerDir(project), { recursive: true });
  await appendFile(ledgerPath(project), entries.map(e => JSON.stringify({ schema: BUDGET_SCHEMA, ...e })).join("\n") + "\n");
}

async function locked<T>(project: string, actor: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(ledgerDir(project), { recursive: true });
  return withLock(lockPath(project), actor, fn);
}

// ---------------------------------------------------------------- arithmetic

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

interface Tally {
  /** Dollars per reservation: the settled cost, else the estimate (in flight or crashed). */
  amount: Map<string, number>;
  reservations: Reservation[];
  grants: Grant[];
  settled: Map<string, Settlement>;
}

function tally(entries: LedgerEntry[]): Tally {
  const reservations: Reservation[] = [], grants: Grant[] = [];
  const settled = new Map<string, Settlement>();
  for (const e of entries) {
    if (e.t === "reserve") reservations.push(e);
    else if (e.t === "settle") settled.set(e.id, e);
    else if (e.t === "grant") grants.push(e);
  }
  const amount = new Map<string, number>();
  for (const r of reservations) amount.set(r.id, settled.get(r.id)?.cost ?? r.estimate);
  return { amount, reservations, grants, settled };
}

const sum = (t: Tally, f: (r: Reservation) => boolean) => r6(t.reservations.filter(f).reduce((a, r) => a + (t.amount.get(r.id) ?? 0), 0));

function grantActive(g: Grant, graph: string | undefined, at = Date.now()): boolean {
  return Date.parse(g.expires) > at && (!g.graph || !graph || g.graph === graph);
}

export interface BudgetView {
  project: string;
  day: string;
  limits: Limits;
  spentToday: number;
  /** Of spentToday: reservations not settled yet (in flight, or a crashed request kept at its estimate). */
  unsettledToday: number;
  byGraph: Record<string, number>;
  grants: Array<Grant & { drawn: number; remaining: number; active: boolean }>;
  /** What can still be spent today without a grant, and with active project-wide grants. */
  normalLeft: number;
  ceilingLeft: number;
  ledger: string;
}

export async function budgetView(project: string, limits: Limits, graph?: string): Promise<BudgetView> {
  const t = tally(await readLedger(project));
  const day = localDay();
  const today = (r: Reservation) => r.day === day;
  const spentToday = sum(t, today);
  const unsettledToday = r6(t.reservations.filter(r => today(r) && !t.settled.has(r.id)).reduce((a, r) => a + r.estimate, 0));
  const byGraph: Record<string, number> = {};
  for (const r of t.reservations.filter(today)) byGraph[r.graph] = r6((byGraph[r.graph] ?? 0) + (t.amount.get(r.id) ?? 0));
  const grants = t.grants.filter(g => g.day === day || Date.parse(g.expires) > Date.now()).map(g => {
    const drawn = sum(t, r => r.funding === `grant:${g.id}`);
    return { ...g, drawn, remaining: r6(Math.max(0, g.amount - drawn)), active: grantActive(g, graph) && g.amount - drawn > 0 };
  });
  return { project, day, limits, spentToday, unsettledToday, byGraph, grants,
    normalLeft: r6(Math.max(0, Math.min(limits.day, limits.ceiling) - spentToday)), ceilingLeft: r6(Math.max(0, limits.ceiling - spentToday)), ledger: ledgerPath(project) };
}

// ---------------------------------------------------------------- reserve / settle

export interface ReserveRequest { project: string; run: string; chain: string; graph: string; node: string; slot: string; estimate: number; model: string; limits: Limits; actor: string }
export type ReserveResult =
  | { ok: true; id: string; funding: string }
  | { ok: false; code: "budget-run" | "budget-day" | "budget-ceiling"; message: string; spentRun: number; spentDay: number };

/** Check the limits and reserve the estimate, atomically. Funding is "limit" while both the run
 *  and the day limit have room; past either, an active grant in scope must cover the whole request.
 *  The ceiling is never exceeded, grant or not. */
export async function reserve(q: ReserveRequest): Promise<ReserveResult> {
  return locked(q.project, q.actor, async () => {
    const t = tally(await readLedger(q.project));
    const day = localDay();
    const spentDay = sum(t, r => r.day === day);
    const spentRun = sum(t, r => r.chain === q.chain);
    const e = q.estimate;
    const L = q.limits;
    if (spentDay + e > L.ceiling + 1e-9) {
      return { ok: false, code: "budget-ceiling", spentRun, spentDay, message: `The project's hard ceiling of ${dollars(L.ceiling)} a day would be passed (spent today ${dollars(spentDay)}, next image about ${dollars(e)}). No grant can lift it; only the owner can, by editing studio.limits.ceiling in .gptimage.json.` };
    }
    let funding: string | undefined;
    if (spentRun + e <= L.run + 1e-9 && spentDay + e <= L.day + 1e-9) funding = "limit";
    else {
      const g = t.grants.filter(g => grantActive(g, q.graph)).map(g => ({ g, left: g.amount - sum(t, r => r.funding === `grant:${g.id}`) }))
        .filter(x => x.left + 1e-9 >= e).sort((a, b) => Date.parse(a.g.expires) - Date.parse(b.g.expires))[0];
      if (g) funding = `grant:${g.g.id}`;
    }
    if (!funding) {
      const runOver = spentRun + e > L.run + 1e-9;
      return runOver
        ? { ok: false, code: "budget-run", spentRun, spentDay, message: `This run's spend limit of ${dollars(L.run)} would be passed (this run has spent ${dollars(spentRun)}, next image about ${dollars(e)}).` }
        : { ok: false, code: "budget-day", spentRun, spentDay, message: `Today's spend limit of ${dollars(L.day)} for this project would be passed (spent today ${dollars(spentDay)}, next image about ${dollars(e)}).` };
    }
    const id = `s${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    await append(q.project, [{ t: "reserve", id, ts: now(), day, run: q.run, chain: q.chain, graph: q.graph, node: q.node, slot: q.slot, estimate: r6(e), model: q.model, funding, by: q.actor }]);
    return { ok: true, id, funding };
  });
}

/** Record what a reserved request actually cost. A request that failed with an HTTP error is
 *  settled at 0 (the API does not bill a refused request); an unknown failure keeps its estimate. */
export async function settle(project: string, actor: string, s: Omit<Settlement, "t" | "ts">): Promise<void> {
  await locked(project, actor, () => append(project, [{ t: "settle", ts: now(), ...s, cost: r6(s.cost) }]));
}

/** Dollars a chain (a run and its resumes) has spent. */
export async function chainSpent(project: string, chain: string): Promise<number> {
  return sum(tally(await readLedger(project)), r => r.chain === chain);
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
  const grant: Grant = { t: "grant", id: `g${Date.now().toString(36)}${randomBytes(2).toString("hex")}`, ts: now(), day: localDay(), amount: r6(g.amount), ...(g.graph ? { graph: g.graph } : {}),
    approvedBy: g.approvedBy.trim(), words: g.words.trim().slice(0, 500), expires: expires.toISOString(), source: g.source, by: g.by };
  await locked(project, g.by, () => append(project, [grant]));
  return grant;
}

export function grantLine(g: BudgetView["grants"][number]): string {
  return `${g.id} ${dollars(g.amount)} ${g.graph ? `for graph ${g.graph}` : "project-wide"}, drawn ${dollars(g.drawn)}, left ${dollars(g.remaining)}, ${g.active ? `expires ${new Date(g.expires).toLocaleString()}` : Date.parse(g.expires) <= Date.now() ? "expired" : "used up"}; approved by ${g.approvedBy} ("${g.words}"), recorded by ${g.by} via ${g.source === "app" ? "ADE (a person's click)" : "an agent"}`;
}

export function budgetText(v: BudgetView): string {
  const lines = [
    `Paid API budget for ${v.project}, ${v.day} (local day):`,
    `  Limits: ${dollars(v.limits.run)} per run, ${dollars(v.limits.day)} per day, hard ceiling ${dollars(v.limits.ceiling)} per day (studio.limits in .gptimage.json; defaults ${dollars(DEFAULT_LIMITS.run)}/${dollars(DEFAULT_LIMITS.day)}/${dollars(DEFAULT_LIMITS.ceiling)}).`,
    `  Spent today: ${dollars(v.spentToday)}${v.unsettledToday ? ` (of which ${dollars(v.unsettledToday)} is reserved at estimate: in flight, or a request whose cost is unknown)` : ""}. Left without a grant: ${dollars(v.normalLeft)}; under the ceiling: ${dollars(v.ceilingLeft)}.`,
  ];
  const graphs = Object.entries(v.byGraph);
  if (graphs.length) lines.push(`  By graph today: ${graphs.map(([g, x]) => `${g} ${dollars(x)}`).join(", ")}.`);
  if (v.grants.length) { lines.push("  Grants:"); for (const g of v.grants) lines.push(`    ${grantLine(g)}`); }
  else lines.push("  Grants: none today.");
  lines.push(`  Ledger (every reservation, settlement and grant): ${v.ledger}`);
  lines.push("  This guards against runaway mistakes; it is not a security boundary. Anyone with shell access can edit the profile or record a grant, and the ledger is what shows it.");
  return lines.join("\n");
}

/** Whether a grant was recorded after a moment (used to let a budget-stopped graph start again). */
export async function grantSince(project: string, graph: string, sinceIso: string): Promise<boolean> {
  const t = tally(await readLedger(project));
  return t.grants.some(g => g.ts > sinceIso && grantActive(g, graph));
}

