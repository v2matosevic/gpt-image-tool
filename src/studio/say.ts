// Command references in the caller's dialect. Studio's messages, refusal fixes and guide name the
// operation to call next; an MCP agent calls studio_run {graph:"x", resume:true}, a CLI user types
// gpt-image studio run x --resume. Every such reference is built here from structured arguments, so
// each dialect has one source. The CLI sets "cli" at startup; the run workers it spawns inherit it
// through GPT_IMAGE_STUDIO_DIALECT, so a run's stored fixes read in the dialect that started it.

export type Dialect = "mcp" | "cli";
export type Tool = "create" | "edit" | "run" | "status" | "get" | "view" | "list" | "guide";

const ENV = "GPT_IMAGE_STUDIO_DIALECT";

export function dialect(): Dialect { return process.env[ENV] === "cli" ? "cli" : "mcp"; }
export function setDialect(d: Dialect): void { process.env[ENV] = d; }
export const isCli = () => dialect() === "cli";

/** The CLI subcommand for each MCP tool (studio_view renders sheets, so its CLI name is sheet). */
const CLI_NAME: Record<Tool, string> = { create: "create", edit: "edit", run: "run", status: "status", get: "get", view: "sheet", list: "list", guide: "guide" };

/** Just the tool's name: "studio_view" or "gpt-image studio sheet". */
export function tool(t: Tool): string { return isCli() ? `gpt-image studio ${CLI_NAME[t]}` : `studio_${t}`; }

const mcpValue = (v: unknown): string => typeof v === "string" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(mcpValue).join(",")}]`
  : v && typeof v === "object" ? `{${Object.entries(v).map(([k, x]) => `${k}:${mcpValue(x)}`).join(", ")}}` : String(v);
const shellArg = (s: string) => /^[\w./@:,+-]+$/.test(s) || /^<[\w-]+>$/.test(s) ? s :`'${s.replace(/'/g, "'\\''")}'`;
const kebab = (k: string) => k.replace(/_/g, "-");

/** A full call: cmd("run", {graph:"x", resume:true}) is studio_run {graph:"x", resume:true} or
 *  gpt-image studio run x --resume. A graph that is not known renders as <graph> on the CLI. */
export function cmd(t: Tool, args: Record<string, unknown> = {}): string {
  if (!isCli()) return Object.keys(args).length ? `${tool(t)} ${mcpValue(args)}` : tool(t);
  const { graph, ...rest } = args;
  const parts = [tool(t)];
  if (t === "view" && typeof rest.study === "string") {
    parts[0] = "gpt-image studio study";
    parts.push(shellArg(rest.study));
    delete rest.study;
    if (graph !== undefined) parts.push("--graph", shellArg(String(graph)));
  } else if (t === "create") {
    // The CLI takes the whole create input as one JSON spec.
    return `${tool(t)} --spec ${shellArg(JSON.stringify(args))}`;
  } else if (["edit", "run", "status", "get", "view"].includes(t)) parts.push(graph === undefined ? "<graph>" : shellArg(String(graph)));
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined || v === false) continue;
    if (k === "zoom" && v && typeof v === "object") { const z = v as { take: string; region: unknown }; parts.push("--zoom", `${z.take}@${Array.isArray(z.region) ? z.region.join(",") : z.region}`); continue; }
    if ((k === "pair" || k === "nodes" || k === "overlays") && Array.isArray(v)) { parts.push(`--${kebab(k)}`, v.join(",")); continue; }
    const flag = k === "wait_seconds" ? "--wait" : k === "node" && t === "get" ? "--node" : `--${kebab(k)}`;
    if (v === true) { parts.push(flag); continue; }
    parts.push(flag, shellArg(typeof v === "string" ? v : JSON.stringify(v)));
  }
  return parts.join(" ");
}

/** An option name as the caller writes it: new_take or --new-take. */
export function opt(name: string): string { return isCli() ? `--${kebab(name === "wait_seconds" ? "wait" : name)}` : name; }

/** Render something in a given dialect, then restore the caller's. */
export function withDialect<T>(d: Dialect | undefined, fn: () => T): T {
  if (!d) return fn();
  const prev = process.env[ENV];
  setDialect(d);
  try { return fn(); } finally { if (prev === undefined) delete process.env[ENV]; else process.env[ENV] = prev; }
}
