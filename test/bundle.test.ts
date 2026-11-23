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
