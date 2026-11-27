// Evaluation: what each node would consume and produce right now. Computes fan-out slots, the
// fingerprint of each slot (everything that determines its output), which take serves each slot,
// and a status. Runs regenerate exactly the slots that have no take with the current fingerprint.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { NODE_SPECS, MAX_SLOTS, SHOT_DIMENSIONS, type ShotKey } from "./nodes.js";
import { inputsOf, topoOrder } from "./graph.js";
import { paths } from "./store.js";
import { ENGINE_VERSION, type GraphFile, type GraphNode, type Issue, type NodeState, type StateFile, type Take, type TakeInput } from "./types.js";

export interface ImageRef { node: string; take: string; asset: string; sha256: string; current: boolean; verdict?: "approved" | "rejected"; role?: string; instruction?: string }
export interface TextItem { text: string; item?: string; source: string }
export interface Look { preset?: string; modifiers?: string[]; style?: Record<string, unknown>; shot?: Record<string, string>; brief?: Record<string, unknown> }
export interface Slot {
  index: number; variant: number; fingerprint: string;
  text?: string; item?: string; image?: ImageRef; refs: ImageRef[]; mask?: ImageRef; pkg?: ImageRef; screenshot?: { rel: string; sha256: string };
  look?: Look; inputs: TakeInput[]; label: string;
  /** Set on sweep slots. With an anchor, the slot renders as an edit of that image that changes only this. */
  sweep?: { dim: string; value: string; anchor?: ImageRef };
}
export type SlotStatus = "current" | "pinned" | "stale" | "missing";
export interface SlotView { slot: Slot; take?: Take; status: SlotStatus }
export interface NodeEval {
  node: GraphNode;
  issues: Issue[];
  blockedBy?: string;
  slots: Slot[];
  views: SlotView[];
  text?: TextItem[];
  look?: Look;
  images?: ImageRef[];
  /** A canon node's locked description, injected verbatim downstream. */
  canon?: { name: string; description: string };
  /** Upstream nodes whose outputs are out of date or incomplete. */
  upstreamStale: string[];
  status: "ready" | "needs-input" | "blocked" | "empty" | "current" | "stale" | "failed" | "running" | "queued";
}

export const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));
export const hashOf = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");

const fileHashCache = new Map<string, string>();
async function fileHash(abs: string): Promise<string | undefined> {
  try {
    const st = await stat(abs);
    const key = `${abs}|${st.size}|${st.mtimeMs}`;
    let h = fileHashCache.get(key);
    if (!h) {
      h = createHash("sha256").update(await readFile(abs)).digest("hex");
      fileHashCache.set(key, h);
      if (fileHashCache.size > 500) fileHashCache.delete(fileHashCache.keys().next().value!);
    }
    return h;
  } catch { return undefined; }
}

async function profileHash(dir: string): Promise<string | null> {
  const { findProfilePath } = await import("../profile.js");
  const p = findProfilePath(join(dir, "assets"));
  return p ? (await fileHash(p)) ?? null : null;
}

const dedupe = (xs: string[]) => [...new Set(xs)];

/** Explicit node settings win over a connected style node; lists merge; style/shot merge per key. */
export function mergeLook(base: Look | undefined, node: Record<string, unknown>): Look {
  const top = node as Look;
  const out: Look = {};
  const preset = top.preset ?? base?.preset;
  if (preset) out.preset = preset;
  const mods = dedupe([...(base?.modifiers ?? []), ...(top.modifiers ?? [])]);
  if (mods.length) out.modifiers = mods;
  const style = { ...(base?.style ?? {}), ...(top.style ?? {}) } as Record<string, unknown>;
  const avoid = dedupe([...((base?.style?.avoid as string[]) ?? []), ...((top.style?.avoid as string[]) ?? [])]);
  if (avoid.length) style.avoid = avoid; else delete style.avoid;
  if (Object.keys(style).length) out.style = style;
  const shot = { ...(base?.shot ?? {}), ...(top.shot ?? {}) };
  if (Object.keys(shot).length) out.shot = shot;
  const brief = { ...(base?.brief ?? {}), ...(top.brief ?? {}) };
  if (Object.keys(brief).length) out.brief = brief;
  return out;
}

/** The look with one swept dimension set to a value. */
export function sweepLook(look: Look, dim: string, value: string): Look {
  if (dim === "preset") return { ...look, preset: value };
  const [group, key] = dim.split(".") as ["style" | "shot", string];
  return { ...look, [group]: { ...((look[group] as Record<string, unknown>) ?? {}), [key]: value } };
}

/** Map shot language onto the prompt compiler's dimensions. Explicit style dimensions win. */
export function shotToDims(shot: Record<string, string> | undefined): Record<string, string> {
  if (!shot) return {};
  const s = shot as Partial<Record<ShotKey, string>>;
  const join2 = (...xs: (string | undefined)[]) => xs.filter(Boolean).join(", ") || undefined;
  const dims: Record<string, string | undefined> = {
    composition: join2(s.size && `${s.size} shot`, s.angle, s.device),
    camera: join2(s.lens && `${s.lens} lens`, s.aperture),
    lighting: join2(s.key_light && `key light ${s.key_light}`, s.light_ratio && `${s.light_ratio} key-to-fill ratio`, s.light_quality && `${s.light_quality} light`, s.light_source && `motivated by ${s.light_source}`),
    color: join2(s.palette, s.color_scheme && `${s.color_scheme} colour scheme`, s.grade && `${s.grade} grade`),
    mood: join2(s.time, s.atmosphere),
    setting: join2(s.foreground && `foreground: ${s.foreground}`, s.midground && `midground: ${s.midground}`, s.background && `background: ${s.background}`),
    medium: s.medium,
    detail: s.texture,
  };
  return Object.fromEntries(Object.entries(dims).filter(([, v]) => v)) as Record<string, string>;
}
export const SHOT_KEYS = Object.keys(SHOT_DIMENSIONS) as ShotKey[];

/** Which take serves a slot: an explicit pick with current settings, then any explicit pick for
 *  that position, then the newest take with the current fingerprint, then the newest for the
 *  position (stale). */
export function serveSlot(ns: NodeState | undefined, slot: Slot): SlotView {
  const takes = ns?.takes ?? [];
  const selected = ns?.selected ?? [];
  const isSel = (t: Take) => selected.includes(t.id);
  const match = takes.filter(t => t.fingerprint === slot.fingerprint);
  const pos = takes.filter(t => t.slot === slot.index && t.variant === slot.variant);
  const a = match.filter(isSel).at(-1);
  if (a) return { slot, take: a, status: "current" };
  const b = pos.filter(isSel).at(-1);
  if (b) return { slot, take: b, status: "pinned" };
  const c = match.at(-1);
  if (c) return { slot, take: c, status: "current" };
  const d = pos.at(-1);
  if (d) return { slot, take: d, status: "stale" };
  return { slot, status: "missing" };
}

const RENDER_KEYS = ["size", "quality", "format", "transparent", "platform", "reference_role", "proof", "preserve_unmasked"];
const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

export interface EvalContext { dir: string; project: string; liveJob?: string }

export async function evaluate(graph: GraphFile, state: StateFile, ctx: EvalContext): Promise<Map<string, NodeEval>> {
  const out = new Map<string, NodeEval>();
  let profile: string | null | undefined;
  for (const id of topoOrder(graph)) {
    const node = graph.nodes.find(n => n.id === id)!;
    const ns = state.nodes[id];
    const ev: NodeEval = { node, issues: [], slots: [], views: [], upstreamStale: [], status: "ready" };
    out.set(id, ev);
    const upstream = (handle: string) => inputsOf(graph, id, handle).map(e => out.get(e.from)!).filter(Boolean);
    const takeText = (handle: string): TextItem[] | null => {
      const ups = upstream(handle);
      if (!ups.length) return null;
      const u = ups[0]!;
      if (!u.text?.length) { ev.blockedBy ??= u.node.id; return []; }
      return u.text;
    };
    const takeImages = (handle: string): ImageRef[] => {
      const res: ImageRef[] = [];
      for (const u of upstream(handle)) {
        if (!u.images?.length) { if (u.node.type !== "gallery" || u.blockedBy) ev.blockedBy ??= u.blockedBy ?? u.node.id; continue; }
        if (u.upstreamStale.length || u.images.some(i => !i.current) || u.views.some(v => v.status === "missing")) ev.upstreamStale.push(u.node.id);
        res.push(...u.images);
      }
      return res;
    };
    const s = node.settings;
    const finishSlots = () => {
      ev.views = ev.slots.map(sl => serveSlot(ns, sl));
      ev.images = ev.views.filter(v => v.take).map(v => ({
        node: id, take: v.take!.id, asset: v.take!.asset, sha256: v.take!.sha256, current: v.status === "current" || v.status === "pinned",
        verdict: v.take!.verdict?.decision,
      }));
    };

    switch (node.type) {
      case "prompt":
        if (typeof s.text === "string" && s.text.trim()) ev.text = [{ text: s.text, source: id }];
        else ev.issues.push({ message: "prompt has no text", fix: `{op:"set", node:"${id}", settings:{text:"..."}}` });
        break;
      case "style":
        ev.look = mergeLook(undefined, s);
        break;
      case "note":
        break;
      case "list": {
        const input = takeText("text");
        const items = Array.isArray(s.items) ? (s.items as string[]) : undefined;
        if (input && input.length > 1) { ev.issues.push({ message: "list input already fans out", fix: "Connect a prompt, not another list; one list per chain." }); break; }
        const template = input?.[0]?.text;
        if (items) {
          ev.text = items.map(it => ({ item: it, source: id, text: template ? (template.includes("{{item}}") ? template.split("{{item}}").join(it) : `${template}, ${it}`) : it }));
        } else if (template) {
          const parts = template.split(s.split === "commas" ? "," : /\r?\n/).map(x => x.trim()).filter(Boolean);
          ev.text = parts.map(p => ({ text: p, item: p, source: id }));
        } else ev.issues.push({ message: "list has no items", fix: `Set items: {op:"set", node:"${id}", settings:{items:["a","b"]}}, or connect a multi-line prompt to split.` });
        if (ev.text && ev.text.length > MAX_SLOTS) { ev.issues.push({ message: `list has ${ev.text.length} items (max ${MAX_SLOTS})`, fix: "Split it into two lists." }); ev.text = undefined; }
        break;
      }
      case "reference": {
        const takes = ns?.takes ?? [];
        const t = takes.filter(x => ns!.selected.includes(x.id)).at(-1) ?? takes.at(-1);
        if (t) {
          ev.views = [{ slot: { index: 0, variant: 0, fingerprint: t.fingerprint, refs: [], inputs: [], label: String(s.path ?? "") }, take: t, status: "current" }];
          ev.images = [{ node: id, take: t.id, asset: t.asset, sha256: t.sha256, current: true, verdict: t.verdict?.decision, role: (s.role as string) ?? undefined, instruction: s.instruction as string | undefined }];
        } else ev.issues.push({ message: "reference has no imported image", fix: `Set its file: {op:"set", node:"${id}", settings:{path:"images/ref.png"}}.` });
        break;
      }
      case "canon": {
        const { readCanon, canonProject } = await import("./canon.js");
        try {
          const entry = await readCanon(canonProject(ctx.project, node), String(s.name));
          ev.canon = { name: entry.name, description: entry.description };
          const takes = (ns?.takes ?? []).filter(t => ns!.selected.includes(t.id));
          const current = entry.references.every(r => takes.some(t => t.sha256 === r.sha256));
          ev.images = takes.map(t => ({ node: id, take: t.id, asset: t.asset, sha256: t.sha256, current, role: (t.settings as any).role }));
          ev.views = takes.map((t, i) => ({ slot: { index: i, variant: 0, fingerprint: t.fingerprint, refs: [], inputs: [], label: `${entry.name} ${(t.settings as any).role}` }, take: t, status: current ? "current" : "stale" }));
          if (!takes.length) ev.issues.push({ message: `canon "${entry.name}" is not imported yet`, fix: `Run it: studio_run {scope:"${id}"}.` });
        } catch (err) {
          ev.issues.push({ message: err instanceof Error ? err.message : String(err), fix: (err as any)?.fix });
        }
        break;
      }
      case "generate":
      case "edit": {
        const isGen = node.type === "generate";
        const textField = isGen ? "prompt" : "instruction";
        const connected = takeText("prompt");
        const own = typeof s[textField] === "string" ? [{ text: s[textField] as string, source: id }] : null;
        if (connected && own) ev.issues.push({ message: `has both a connected prompt and settings.${textField}`, fix: `Remove one: {op:"set", node:"${id}", settings:{${textField}:null}} or disconnect the prompt.` });
        const styleIn = upstream("style")[0]?.look;
        const look = mergeLook(styleIn, s);
        ev.look = look;
        const hasLook = Boolean(look.preset || look.modifiers?.length || look.style || look.shot);
        // Canon descriptions go into the prompt word for word; rewording them is what causes drift.
        const canonText = upstream("references").filter(u => u.canon).map(u => `${u.canon!.description}`).join(" ");
        let items: TextItem[] = connected ?? own ?? [];
        if (canonText) items = (items.length ? items : [{ text: "", source: id }]).map(it => ({ ...it, text: it.text ? `${it.text}. ${canonText}` : canonText }));
        if (isGen && !items.length && !ev.blockedBy) ev.issues.push({ message: "generate needs a prompt", fix: `Connect a prompt or list ({op:"connect", from:"<prompt>", to:"${id}"}) or set settings.prompt.` });
        if (!isGen && !items.length && !hasLook && !ev.blockedBy) ev.issues.push({ message: "edit needs an instruction", fix: `Connect a prompt or set settings.instruction on "${id}".` });
        const refs = takeImages("references").map(r => ({ ...r, role: r.role ?? (s.reference_role as string) ?? "style" }));
        if (refs.length > 16) ev.issues.push({ message: `${refs.length} reference images (max 16)`, fix: "Narrow them with a gallery pick." });
        let images: (ImageRef | undefined)[] = [undefined];
        let mask: ImageRef | undefined;
        if (!isGen) {
          const prim = takeImages("image");
          if (!prim.length && !ev.blockedBy) ev.issues.push({ message: "edit needs an image", fix: `Connect one: {op:"connect", from:"<image node>", to:"${id}", to_handle:"image"}.` });
          if (prim.length > 1 && items.length > 1) ev.issues.push({ message: `edit fans out on both ${prim.length} images and ${items.length} instructions`, fix: "Fan out on one input only: one image with a list of instructions, or many images with one instruction." });
          images = prim;
          mask = takeImages("mask")[0];
          if (!items.length) items = [{ text: "", source: id }];
        }
        if (ev.issues.length || ev.blockedBy) break;
        if (node.type === "generate") profile ??= await profileHash(ctx.dir);
        const variants = (s.takes as number) ?? 1;
        const pairs: Array<{ item: TextItem; image?: ImageRef }> = images.length > 1 ? images.map(im => ({ item: items[0]!, image: im })) : items.map(it => ({ item: it, image: images[0] }));
        // A sweep varies one look dimension across values; it replaces fan-out, so it needs one pair.
        const sw = s.sweep as { dim: string; values: string[] } | undefined;
        if (sw && pairs.length > 1) {
          ev.issues.push(isGen
            ? { message: `a sweep needs a single prompt, but this node fans out to ${pairs.length} slots`, fix: `Give ${id} one prompt (disconnect the list), or remove the sweep: {op:"set", node:"${id}", settings:{sweep:null}}.` }
            : { message: `a sweep needs a single image and a single instruction, but this node fans out to ${pairs.length} slots`, fix: `Pick one image in the upstream gallery ({op:"pick", node:"<gallery>", takes:["<node>/<take>"]}) or use one instruction, or remove the sweep: {op:"set", node:"${id}", settings:{sweep:null}}.` });
          break;
        }
        // The anchor a sweep edits: the edit node's own image, or a generator's subject reference/canon image.
        const sweepAnchor = sw ? (isGen ? refs.find(r => r.role === "subject") : images[0]) : undefined;
        const looks: Array<{ look: Look; label?: string; sweep?: Slot["sweep"] }> = sw ? sw.values.map(v => ({ look: sweepLook(look, sw.dim, v), label: `${sw.dim}: ${v}`, sweep: { dim: sw.dim, value: v, ...(sweepAnchor ? { anchor: sweepAnchor } : {}) } })) : [{ look }];
        const fan = sw ? looks.map(l => ({ ...pairs[0]!, ...l })) : pairs.map(p => ({ ...p, look, label: undefined as string | undefined, sweep: undefined }));
        if (fan.length * variants > MAX_SLOTS) { ev.issues.push({ message: `${fan.length * variants} slots (max ${MAX_SLOTS})`, fix: "Reduce takes, sweep values or list items." }); break; }
        fan.forEach((p, index) => {
          const look = p.look;
          for (let variant = 0; variant < variants; variant++) {
            const base = { e: ENGINE_VERSION, t: node.type, s: pick(s, RENDER_KEYS), look, text: p.item.text, refs: refs.map(r => [r.sha256, r.role, r.instruction ?? null]), image: p.image?.sha256 ?? null, mask: mask?.sha256 ?? null, v: variant, profile: isGen ? profile : null };
            const inputs: TakeInput[] = [
              ...(p.item.text ? [{ handle: "prompt", node: p.item.source, text: p.item.text }] : []),
              ...(p.image ? [{ handle: "image", node: p.image.node, take: p.image.take, sha256: p.image.sha256 }] : []),
              ...refs.map(r => ({ handle: "references", node: r.node, take: r.take, sha256: r.sha256, role: r.role })),
              ...(mask ? [{ handle: "mask", node: mask.node, take: mask.take, sha256: mask.sha256 }] : []),
            ];
            ev.slots.push({ index, variant, fingerprint: hashOf(p.sweep ? { ...base, sweepEdit: p.sweep.anchor?.sha256 ?? null } : base), text: p.item.text || undefined, item: p.item.item, image: p.image, refs, mask, look, inputs, ...(p.sweep ? { sweep: p.sweep } : {}),
              label: [p.label ?? p.item.item ?? (p.image ? `${p.image.node}/${p.image.take}` : undefined), variants > 1 ? `take ${variant + 1}` : undefined].filter(Boolean).join(" · ") || id });
          }
        });
        finishSlots();
        break;
      }
      case "process": {
        const prim = takeImages("image");
        if (!prim.length && !ev.blockedBy) ev.issues.push({ message: "process needs an image", fix: `Connect one: {op:"connect", from:"<image node>", to:"${id}"}.` });
        if (ev.issues.length || ev.blockedBy) break;
        prim.forEach((im, index) => ev.slots.push({ index, variant: 0, fingerprint: hashOf({ e: ENGINE_VERSION, t: "process", s, image: im.sha256 }), image: im, refs: [], label: `${im.node}/${im.take}`,
          inputs: [{ handle: "image", node: im.node, take: im.take, sha256: im.sha256 }] }));
        finishSlots();
        break;
      }
      case "gallery": {
        const collected = takeImages("images");
        const picks = (ns?.picks ?? []).map(ref => collected.find(c => `${c.node}/${c.take}` === ref) ?? null).filter(Boolean) as ImageRef[];
        ev.images = picks.length ? picks : collected;
        break;
      }
      case "handoff": {
        const imgs = takeImages("images");
        const approved = imgs.filter(i => i.verdict === "approved");
        const brief = takeText("brief");
        if (!approved.length && !ev.blockedBy) ev.issues.push({ message: "no approved image reaches this handoff", fix: `Approve one: {op:"approve", take:"<node>/<take>"}. Candidates: ${imgs.map(i => `${i.node}/${i.take}`).join(", ") || "(none yet; run upstream first)"}.` });
        if (!s.intent && !brief?.length) ev.issues.push({ message: "handoff needs an intent", fix: `{op:"set", node:"${id}", settings:{intent:"what is being built and why"}}` });
        if (ev.issues.length || ev.blockedBy) break;
        ev.slots.push({ index: 0, variant: 0, fingerprint: hashOf({ e: ENGINE_VERSION, t: "handoff", s, approved: approved.map(a => a.sha256), brief: brief?.[0]?.text ?? null }), refs: approved, text: brief?.[0]?.text, label: String(s.name ?? id),
          inputs: [...approved.map(a => ({ handle: "images", node: a.node, take: a.take, sha256: a.sha256 })), ...(brief?.length ? [{ handle: "brief", node: brief[0]!.source, text: brief[0]!.text }] : [])] });
        finishSlots();
        break;
      }
      case "implementation": {
        const up = upstream("handoff")[0];
        const pkg = up?.images?.[0];
        if (!up) ev.issues.push({ message: "implementation is not tied to a handoff", fix: `{op:"connect", from:"<handoff node>", to:"${id}"}` });
        else if (!pkg) ev.blockedBy = up.node.id;
        if (typeof s.screenshot !== "string") ev.issues.push({ message: "no screenshot yet", fix: `After building, {op:"set", node:"${id}", settings:{screenshot:"path/to/screenshot.png"}} and run it.` });
        if (ev.issues.length || ev.blockedBy) break;
        const sha = await fileHash(resolve(ctx.project, s.screenshot as string));
        if (!sha) { ev.issues.push({ message: `screenshot not found: ${s.screenshot}`, fix: "Save the screenshot, then run again." }); break; }
        ev.slots.push({ index: 0, variant: 0, fingerprint: hashOf({ e: ENGINE_VERSION, t: "implementation", shot: sha, pkg: pkg!.sha256, v: s.viewport ?? null }), refs: [], pkg, screenshot: { rel: s.screenshot as string, sha256: sha }, label: String(s.viewport ?? "build"),
          inputs: [{ handle: "handoff", node: pkg!.node, take: pkg!.take, sha256: pkg!.sha256 }] });
        finishSlots();
        break;
      }
    }

    // A handoff package travels as an "image" ref internally (node/take/asset/sha) to its implementation.
    ev.upstreamStale = [...new Set(ev.upstreamStale)];
    ev.status = statusOf(ev, ns, ctx.liveJob);
  }
  return out;
}

function statusOf(ev: NodeEval, ns: NodeState | undefined, liveJob?: string): NodeEval["status"] {
  if (ns?.activity && liveJob && ns.activity.job === liveJob) return ns.activity.status;
  if (ev.issues.length) return "needs-input";
  if (ev.blockedBy) return "blocked";
  const t = ev.node.type;
  if (t === "prompt" || t === "style" || t === "list" || t === "note" || t === "gallery") return "ready";
  if (t === "reference") return ev.images?.length ? "current" : "needs-input";
  if (ns?.error && !ev.views.every(v => v.status === "current" || v.status === "pinned")) return "failed";
  if (!ev.views.some(v => v.take)) return "empty";
  return ev.views.every(v => v.status === "current" || v.status === "pinned") ? "current" : "stale";
}

/** Slots a run must render: no take with the current fingerprint (or, for new takes, not yet done in this run). */
export function slotsToRun(ev: NodeEval, ns: NodeState | undefined, newTake: boolean, done: Set<string>): Slot[] {
  return ev.slots.filter(sl => {
    const key = slotKey(ev.node.id, sl);
    if (done.has(key)) return false;
    if (newTake) return true;
    return !(ns?.takes ?? []).some(t => t.fingerprint === sl.fingerprint);
  });
}

export const slotKey = (node: string, sl: Slot) => `${node}|${sl.index}|${sl.variant}|${sl.fingerprint}`;

export function imageAbs(dir: string, ref: { asset: string }) { return resolve(dir, ref.asset); }
export { paths };
