import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// dist/mcp.js must stay a single-file bundle (scripts/bundle-mcp.mjs). Unbundled, a cold start
// read ~270 module files; from a busy hard drive that passed ToolHub's start limit and every
// call failed with "Request timed out" (2026-11-18..22).
test("dist/mcp.js is a self-contained bundle", () => {
  const src = readFileSync(new URL("../dist/mcp.js", import.meta.url), "utf8");
  const specifiers = [
    ...src.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm),
    ...src.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
  ].map((m) => m[1]);
  const disallowed = specifiers.filter((s) => !s.startsWith("node:"));
  assert.deepEqual(disallowed, [], `static imports outside node: built-ins: ${disallowed.join(", ")}`);
  assert.match(src, /McpServer|registerTool|setRequestHandler/, "bundle should contain the MCP server");
});

// dist/cli.js is bundled too: ADE calls `gpt-image studio` for every edit, and the MCP server starts
// Studio's detached run worker through it, which must resolve as dist/cli.js beside dist/mcp.js.
test("dist/cli.js is a self-contained bundle that hosts the studio worker", () => {
  const src = readFileSync(new URL("../dist/cli.js", import.meta.url), "utf8");
  const disallowed = [...src.matchAll(/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm), ...src.matchAll(/^\s*import\s*["']([^"']+)["']/gm)].map(m => m[1]).filter(s => !s.startsWith("node:"));
  assert.deepEqual(disallowed, []);
  assert.ok(src.startsWith("#!/usr/bin/env node"), "keeps the shebang for the bin entry");
  assert.match(src, /studio", "worker"/, "contains the studio worker entry");
});
