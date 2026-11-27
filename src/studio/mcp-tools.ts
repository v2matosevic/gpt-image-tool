// The eight studio_* MCP tools. Schemas stay small (every schema costs context in every terminal);
// studio_guide carries the detail. Results are text an agent can act on, with absolute paths to open.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createGraph, editGraph, getGraph, listGraphs, runGraph, statusReport, viewGraph } from "./api.js";
import { guide, GUIDE_TOPICS } from "./guide.js";
import { StudioError } from "./store.js";

const project = z.string().optional().describe("Project folder. Default: this project. Pass another project's path to read or copy from it.");
const graph = z.string().describe("Graph slug (studio_list shows them).");

function text(t: string) { return { content: [{ type: "text" as const, text: t }] }; }
function failure(e: unknown) {
  if (e instanceof StudioError) {
    const extra = e.issues?.length && e.issues.length > 1 ? `\n${e.issues.map(i => `- ${i.path ? `${i.path}: ` : ""}${i.message}${i.fix ? `. Fix: ${i.fix}` : ""}`).join("\n")}` : "";
    return { isError: true, content: [{ type: "text" as const, text: `Studio refused [${e.code}]: ${e.message}${e.fix ? `\nFix: ${e.fix}` : ""}${extra}\nNothing was changed.` }] };
  }
  return { isError: true, content: [{ type: "text" as const, text: `Studio failed: ${e instanceof Error ? e.message : String(e)}` }] };
}
const wrap = <A>(fn: (a: A) => Promise<string>) => async (a: A) => { try { return text(await fn(a)); } catch (e) { return failure(e); } };

const nodeShape = z.object({
  ref: z.string().describe("Your id for this node, used in connections."),
  type: z.string().describe("prompt | style | list | reference | generate | edit | process | gallery | handoff | implementation | note"),
  settings: z.record(z.unknown()).optional(),
  label: z.string().optional(),
  group: z.string().optional(),
}).passthrough();

export function registerStudioTools(server: McpServer) {
  server.registerTool("studio_guide", {
    title: "Studio guide: node graphs for image work",
    description: "How Studio works: node types and their exact settings, edit ops, running, handoff to code, shot language and a worked example. Read it before your first studio_create.",
    inputSchema: { topic: z.enum([...GUIDE_TOPICS, "all"]).optional().describe("Default all.") },
  }, wrap(async a => guide(a.topic ?? "all")));

  server.registerTool("studio_list", {
    title: "List Studio graphs",
    description: "Graphs in a project with revision, size and last run.",
    inputSchema: { project },
  }, wrap(async a => {
    const r = await listGraphs({ project: a.project });
    if (!r.graphs.length) return `No Studio graphs in ${r.project}. Create one with studio_create (see studio_guide).`;
    return `Studio graphs in ${r.project}:\n${r.graphs.map((g: any) => g.error ? `  ${g.slug}: unreadable (${g.error})` : `  ${g.slug}  "${g.name}"  rev ${g.revision}  ${g.nodes} nodes  updated ${g.updated}${g.lastRun ? `  last run ${g.lastRun.job} ${g.lastRun.status}` : ""}`).join("\n")}`;
  }));

  server.registerTool("studio_get", {
    title: "Read a Studio graph",
    description: "Text snapshot of a graph (nodes, status, takes, notes, issues, next steps), or one node in full with every take's file path, verdicts and notes.",
    inputSchema: { graph, node: z.string().optional().describe("Node id for full detail."), project },
  }, wrap(async a => {
    const r = await getGraph(a.graph, { project: a.project, node: a.node });
    return "node" in r && r.node ? JSON.stringify(r.node, null, 2) : (r as any).snapshot;
  }));

  server.registerTool("studio_create", {
    title: "Create a Studio graph",
    description: "Create a graph from nodes (with your own refs) and connections; handles are chosen by type. All or nothing: any error names its fix and nothing is written. Or copy_from another graph, including from another project.",
    inputSchema: {
      name: z.string(), slug: z.string().optional().describe("Default: from the name."),
      nodes: z.array(nodeShape).optional(),
      connections: z.array(z.object({ from: z.string(), to: z.string(), to_handle: z.string().optional(), from_handle: z.string().optional() })).optional(),
      groups: z.array(z.object({ id: z.string(), stage: z.string().describe("concept | sketch | art | final | free text"), label: z.string().optional() })).optional(),
      copy_from: z.object({ graph: z.string(), project: z.string().optional() }).optional(),
      project,
    },
  }, wrap(async a => {
    const r = await createGraph({ name: a.name, slug: a.slug, nodes: a.nodes, connections: a.connections, groups: a.groups, copy_from: a.copy_from }, { project: a.project });
    return `Created graph "${r.slug}" at ${r.dir}${r.copiedFrom ? ` (copied from ${r.copiedFrom})` : ""}.${r.notes.length ? `\n${r.notes.join("\n")}` : ""}\n\n${r.snapshot}`;
  }));

  server.registerTool("studio_edit", {
    title: "Edit a Studio graph",
    description: "Apply a list of ops together or not at all: add, remove, set, prompt_edit, connect, disconnect, group, ungroup, move, layout, rename, select, pick, approve, reject, clear_verdict, predict, note. Shapes are in studio_guide topic ops.",
    inputSchema: {
      graph, ops: z.array(z.record(z.unknown()).describe('e.g. {op:"set", node:"gen", settings:{quality:"high"}}')).min(1),
      expect_revision: z.number().int().optional().describe("Refuse if the graph changed since this revision."), project,
    },
  }, wrap(async a => {
    const r = await editGraph(a.graph, a.ops, { project: a.project, expectRevision: a.expect_revision });
    return `Applied to "${r.slug}", now revision ${r.revision}:\n${r.applied.map(x => `  ${x}`).join("\n")}${r.notes.length ? `\n${r.notes.join("\n")}` : ""}\n\n${r.snapshot}`;
  }));

  server.registerTool("studio_run", {
    title: "Run a Studio graph",
    description: "Start a background run (subscription only) and return its job id; unchanged slots are reused, never regenerated. scope: all | <id> | <id>+ (downstream). dry_run plans without spending. resume continues a stopped run; stop asks the live run to stop.",
    inputSchema: {
      graph, scope: z.string().optional(), nodes: z.array(z.string()).optional().describe("Run exactly these nodes."),
      new_take: z.boolean().optional().describe("Render one more take per slot in scope."),
      concurrency: z.number().int().min(1).max(3).optional(), dry_run: z.boolean().optional(), resume: z.boolean().optional(), stop: z.boolean().optional(),
      wait_seconds: z.number().int().min(0).max(30).optional().describe("Wait for the run up to this long before returning (default 20)."), project,
    },
  }, wrap(async a => {
    const r: any = await runGraph(a.graph, { scope: a.scope, nodes: a.nodes, newTake: a.new_take, concurrency: a.concurrency, dryRun: a.dry_run, resume: a.resume, stop: a.stop, waitSeconds: a.wait_seconds ?? 20 }, { project: a.project });
    if (a.stop) return r.message;
    const plan = r.plan ? `\nPlan: ${r.plan.nodes.map((n: any) => `${n.node} ${n.toRun}/${n.slots}${n.estimate ? "?" : ""}`).join(", ") || "(nothing)"}${r.plan.skipped.length ? `\nSkipped: ${r.plan.skipped.map((s: any) => `${s.node} (${s.reason}${s.fix ? `; ${s.fix}` : ""})`).join("; ")}` : ""}${r.plan.staleAfter.length ? `\nOut of scope, will be out of date afterwards: ${r.plan.staleAfter.join(", ")}` : ""}` : "";
    const head = r.job ? `Job ${r.job}${r.resumeOf ? ` (resumes ${r.resumeOf})` : ""}. ${r.message}` : r.message;
    return `${head}${plan}${r.report ? `\n\n${r.report.text}` : ""}`;
  }));

  server.registerTool("studio_status", {
    title: "Follow a Studio run",
    description: "Progress of a run (latest by default): slots done, generations spent, new take paths, errors with fixes. Waits up to wait_seconds (default 20, max 30) for the run to finish.",
    inputSchema: { graph, job: z.string().optional(), wait_seconds: z.number().int().min(0).max(30).optional(), project },
  }, wrap(async a => {
    const r: any = await statusReport(a.graph, { project: a.project, job: a.job, waitSeconds: a.wait_seconds ?? 20 });
    return r.text;
  }));

  server.registerTool("studio_view", {
    title: "Look at Studio results",
    description: "Write one labelled contact sheet of the current outputs (or every take) and return it with small preview paths and full-size paths to open.",
    inputSchema: { graph, nodes: z.array(z.string()).optional(), all_takes: z.boolean().optional().describe("Every take, not just current outputs."), project },
  }, wrap(async a => (await viewGraph(a.graph, { project: a.project, nodes: a.nodes, allTakes: a.all_takes })).text));
}
