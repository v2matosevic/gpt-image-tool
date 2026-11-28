// Every paid API request goes through the spend ledger (src/studio/budget.ts), not only Studio's.
//
// Studio reserves a slot before it renders and settles it after; it marks that work as managed, so
// the request is not counted twice. Everything else (generate_image, edit_image, upscale_image,
// series, social plates, web assets, brand boards, the CLI) is a *direct call*: each paid request in
// it is reserved under the graph name "_direct" against the project's day limit and ceiling, the
// user-level limits, grants, and a per-call limit equal to the project's run limit, so one huge
// count or series call is bounded too. A call is one MCP tool call or one CLI process.
//
// The scope lives in AsyncLocalStorage, so it cannot be forged from a tool's JSON arguments.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { GenerateInput, GenerateResult } from "./providers/types.js";
import { costFromUsage, estimateCost } from "./pricing.js";
import { projectDirs } from "./secrets.js";

type Scope = { kind: "managed" } | { kind: "direct"; id: string; label: string };
const scope = new AsyncLocalStorage<Scope>();
let processCall: Scope | undefined;

/** Studio: this work's paid request was already reserved by the run. */
export function managedSpend<T>(fn: () => Promise<T>): Promise<T> {
  return scope.run({ kind: "managed" }, fn);
}

/** One direct call (an MCP tool call): every paid request inside it shares one per-call limit. */
export function directCall<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return scope.run({ kind: "direct", id: `c${Date.now().toString(36)}${randomBytes(3).toString("hex")}`, label }, fn);
}

/** Outside any scope (the CLI, library use) the whole process is one call. */
function current(): Scope {
  return scope.getStore() ?? (processCall ??= { kind: "direct", id: `c${Date.now().toString(36)}${randomBytes(3).toString("hex")}`, label: "cli" });
}

/** Run one paid API request under the ledger: reserve its estimate, send, settle at reported cost.
 *  A refusal throws before anything is sent, with what to do next. */
export async function guardPaidRequest(model: string, input: GenerateInput, send: () => Promise<GenerateResult>): Promise<GenerateResult> {
  const s = current();
  if (s.kind === "managed") return send();
  const { reserve, settle, DIRECT } = await import("./studio/budget.js");
  const { studioProfile } = await import("./studio/render.js");
  const project = input.keyProject ?? projectDirs()[0]!;
  const limits = studioProfile(project).limits;
  const estimate = estimateCost({ model, quality: input.quality, size: input.size, promptChars: input.prompt.length, inputImages: (input.inputImages?.length ?? 0) + (input.maskImage ? 1 : 0) }).dollars;
  const r = await reserve({ project, run: s.id, chain: s.id, graph: DIRECT, node: s.label, slot: s.id, estimate, model, limits, actor: `${s.label} (direct)` });
  if (!r.ok) {
    const fix = r.code === "budget-ceiling" || r.code === "budget-user-ceiling"
      ? "Only the owner can raise a ceiling. Stop here, or make the work cheaper (the subscription, a lower quality or size)."
      : "Ask the owner once, with the amount you need; do not work around the limit (no other backend, no splitting the work into more calls). When they approve in chat, record it with gpt-image studio budget --grant <dollars> --approved-by <owner> --words '<what they said>' (or studio_budget), then call again.";
    throw new Error(`Spend limit: ${r.message} No request was sent, and nothing was switched to the subscription. Fix: ${fix} Today's spend: gpt-image studio budget (or studio_budget).`);
  }
  try {
    const res = await send();
    const known = res.usage ? costFromUsage(model, res.usage) : undefined;
    await settle(project, `${s.label} (direct)`, { id: r.id, cost: known ?? estimate, ...(known === undefined ? { uncertain: true, note: "the API reported no usage; kept at the estimate" } : {}) });
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const refused = /HTTP [45]\d\d/.test(msg) || /No request was sent/.test(msg);
    await settle(project, `${s.label} (direct)`, { id: r.id, cost: refused ? 0 : estimate, ...(refused ? { note: "request refused; not billed" } : { uncertain: true, note: "request failed; kept at the estimate in case it was billed" }) }).catch(() => {});
    throw e;
  }
}

