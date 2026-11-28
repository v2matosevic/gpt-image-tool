// `gpt-image studio ...`: the CLI over the Studio library. ADE calls this for every mutation and run,
// so every command can print machine-readable JSON (--json) and exits non-zero on refusal.

import { readFile } from "node:fs/promises";
import { createGraph, editGraph, getGraph, listGraphs, lookCloser, runGraph, statusReport, viewGraph } from "./api.js";
import { guide, GUIDE_TOPICS, type GuideTopic } from "./guide.js";
import { StudioError, graphDir, readEvents, resolveProject } from "./store.js";

const HELP = `gpt-image studio: node-graph image workflows (subscription only)

Usage: gpt-image studio <command> [graph] [options]

  list                                 Graphs in the project
  guide [topic]                        The agent guide (${GUIDE_TOPICS.join(", ")})
  get <graph> [--node id] [--raw]      Snapshot, one node in full, or raw graph+state JSON
  create --spec <json|@file|->         Create from {name, slug?, nodes, connections, groups, copy_from?}
  edit <graph> --ops <json|@file|->    Apply ops together or not at all [--expect-revision N]
  run <graph> [--scope all|id|id+] [--nodes a,b] [--new-take] [--concurrency 1-3]
              [--dry-run] [--resume] [--stop] [--wait seconds] [--foreground]
  status <graph> [--job id] [--wait seconds]
  sheet <graph> [--nodes a,b] [--all-takes] [--overlays grid,palette,histogram]
                                               Labelled review sheet + preview paths
  sheet <graph> --zoom gen/t3@bottom-right     Full-resolution crop (or @x,y,w,h fractions)
  sheet <graph> --pair gen/t3,gen/t5           Blind A/B sheet for the judge_pair op
  study <image|take> [--graph g]              Reading + shot language of an admired image (1 vision request)
  events <graph> [--after seq] [--limit n]    Events after a sequence number (JSON)
  view [graph] [--port n] [--idle-exit minutes]   Read-only local viewer on 127.0.0.1

Options: --project <dir> (default: cwd), --actor <name> (recorded on every write), --json,
         --human (a person is acting, as ADE does; approvals need no recorded look)
`;

interface Flags { [k: string]: string | boolean | undefined }

function parse(argv: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = {};
  const bools = new Set(["human", "json", "raw", "new-take", "dry-run", "resume", "stop", "foreground", "all-takes", "help"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h") { flags.help = true; continue; }
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const eq = a.indexOf("=");
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (eq > 0) flags[key] = a.slice(eq + 1);
    else if (bools.has(key)) flags[key] = true;
    else {
      const v = argv[i + 1];
      if (v === undefined) throw new StudioError("BAD_ARGS", `--${key} needs a value.`, "See gpt-image studio --help.");
      flags[key] = v; i++;
    }
  }
  return { pos, flags };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function jsonArg(v: string | boolean | undefined, name: string): Promise<any> {
  if (typeof v !== "string") throw new StudioError("BAD_ARGS", `--${name} is required.`, `Pass JSON, @file.json, or - for stdin.`);
  const raw = v === "-" ? await readStdin() : v.startsWith("@") ? await readFile(v.slice(1), "utf8") : v;
  try { return JSON.parse(raw); } catch (e) {
    throw new StudioError("BAD_JSON", `--${name} is not valid JSON: ${e instanceof Error ? e.message : e}`, "Quote the JSON for your shell, or use @file.json.");
  }
}

const num = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? Number(v) : undefined);
const list = (v: unknown) => (typeof v === "string" ? v.split(",").map(s => s.trim()).filter(Boolean) : undefined);

function need(pos: string[], i: number, what: string): string {
  const v = pos[i];
  if (!v) throw new StudioError("BAD_ARGS", `Missing ${what}.`, "See gpt-image studio --help.");
  return v;
}

export async function studioMain(argv: string[]): Promise<number> {
  let json = argv.includes("--json");
  try {
    const { pos, flags } = parse(argv);
    json = Boolean(flags.json);
    const cmd = pos[0];
    if (!cmd || flags.help) { process.stderr.write(HELP); return flags.help ? 0 : 1; }
    const who = { human: Boolean(flags.human), project: flags.project as string | undefined, actor: (flags.actor as string | undefined) ?? (process.env.GPT_IMAGE_STUDIO_ACTOR || "cli") };
    const out = (data: unknown, human: string) => { process.stdout.write(json ? JSON.stringify({ ok: true, ...(data as object) }, null, 2) + "\n" : human + "\n"); };
    switch (cmd) {
      case "list": {
        const r = await listGraphs(who);
        out(r, (r.graphs.length ? r.graphs.map((g: any) => `${g.slug}\t${g.name ?? g.error}\trev ${g.revision ?? "?"}`).join("\n") : `No graphs in ${r.project}.`) +
          (r.canon.length ? `\nCanon: ${r.canon.map(c => `${c.name} (${c.kind}, ${c.images} image(s))`).join(", ")}` : ""));
        return 0;
      }
      case "guide": {
        const topic = (pos[1] ?? "all") as GuideTopic;
        if (topic !== "all" && !(GUIDE_TOPICS as readonly string[]).includes(topic)) throw new StudioError("BAD_ARGS", `Unknown guide topic ${topic}.`, `Topics: ${GUIDE_TOPICS.join(", ")}.`);
        const { memoryBrief } = await import("./memory.js");
        const memory = await memoryBrief(resolveProject(who.project)).catch(() => "");
        const g = guide(topic, "cli") + (memory ? `

# What this project has learned

${memory}` : "");
        out({ guide: g }, g);
        return 0;
      }
      case "get": {
        const r: any = await getGraph(need(pos, 1, "graph slug"), { ...who, node: flags.node as string | undefined, raw: Boolean(flags.raw) });
        out(r, r.snapshot ?? JSON.stringify(r.node ?? { graph: r.graph, state: r.state }, null, 2));
        return 0;
      }
      case "create": {
        const spec = await jsonArg(flags.spec, "spec");
        const r = await createGraph(spec, who);
        out(r, `Created ${r.slug} at ${r.dir}\n\n${r.snapshot}`);
        return 0;
      }
      case "edit": {
        const ops = await jsonArg(flags.ops, "ops");
        const r = await editGraph(need(pos, 1, "graph slug"), Array.isArray(ops) ? ops : [ops], { ...who, expectRevision: num(flags["expect-revision"]) });
        out(r, `Revision ${r.revision}:\n${r.applied.join("\n")}\n\n${r.snapshot}`);
        return 0;
      }
      case "run": {
        const foreground = Boolean(flags.foreground);
        const r: any = await runGraph(need(pos, 1, "graph slug"), {
          scope: flags.scope as string | undefined, nodes: list(flags.nodes), newTake: Boolean(flags["new-take"]), concurrency: num(flags.concurrency),
          dryRun: Boolean(flags["dry-run"]), resume: Boolean(flags.resume), stop: Boolean(flags.stop), waitSeconds: num(flags.wait) ?? 0, detach: !foreground,
        }, who);
        out(r, `${r.job ? `Job ${r.job}: ` : ""}${r.message}${r.report ? `\n${r.report.text}` : ""}`);
        return 0;
      }
      case "status": {
        const r: any = await statusReport(need(pos, 1, "graph slug"), { ...who, job: flags.job as string | undefined, waitSeconds: num(flags.wait) ?? 0 });
        out(r, r.text);
        return 0;
      }
      case "sheet": {
        const slug = need(pos, 1, "graph slug");
        if (flags.zoom || flags.pair) {
          const zoom = typeof flags.zoom === "string" ? (() => { const [take, region] = (flags.zoom as string).split("@"); return { take: take!, region: region?.includes(",") ? region.split(",").map(Number) as [number, number, number, number] : region ?? "centre" }; })() : undefined;
          const text = await lookCloser(slug, { ...who, zoom, pair: list(flags.pair) as [string, string] | undefined });
          out({ text }, text);
          return 0;
        }
        const r = await viewGraph(slug, { ...who, nodes: list(flags.nodes), allTakes: Boolean(flags["all-takes"]), overlays: list(flags.overlays) as any });
        out(r, r.text);
        return 0;
      }
      case "study": {
        const { studyImage } = await import("./api.js");
        const r = await studyImage(need(pos, 1, "image path or take ref"), { ...who, graph: flags.graph as string | undefined });
        out({ path: r.path, shot: r.shot, op: r.op, reading: r.reading }, r.text);
        return 0;
      }
      case "events": {
        const project = resolveProject(who.project);
        const events = await readEvents(graphDir(project, need(pos, 1, "graph slug")), num(flags.after) ?? 0, num(flags.limit) ?? 200);
        out({ events }, events.map(e => JSON.stringify(e)).join("\n"));
        return 0;
      }
      case "view": {
        const { serveViewer } = await import("./viewer.js");
        await serveViewer({ project: resolveProject(who.project), graph: pos[1], port: num(flags.port), idleExitMinutes: num(flags["idle-exit"]) });
        return 0;
      }
      case "worker": {
        const { runJob } = await import("./runner.js");
        await runJob(resolveProject(who.project), need(pos, 1, "graph slug"), String(flags.job));
        return 0;
      }
      default:
        throw new StudioError("BAD_ARGS", `Unknown studio command "${cmd}".`, "Commands: list, guide, get, create, edit, run, status, sheet, study, events, view.");
    }
  } catch (e) {
    const err = e instanceof StudioError ? { code: e.code, message: e.message, fix: e.fix, issues: e.issues } : { code: "ERROR", message: e instanceof Error ? e.message : String(e) };
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: err }, null, 2) + "\n");
    process.stderr.write(`✗ ${err.message}${"fix" in err && err.fix ? `\n  Fix: ${err.fix}` : ""}\n`);
    return 1;
  }
}
