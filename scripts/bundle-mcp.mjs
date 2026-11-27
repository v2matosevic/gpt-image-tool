// Replace tsc's dist/mcp.js with a single-file bundle of the MCP server.
//
// Why: clients start the server cold (ToolHub restarts it after 10 idle minutes per terminal).
// Unbundled, a start reads ~270 module files; from a busy spinning disk that took up to 32s and
// sometimes passed the client's start limit, so every call failed with "Request timed out".
// One file reads in a single sequential pass. Other dist/*.js files stay unbundled for the
// tests. sharp stays external: it is native and loaded lazily only when needed.
// dist/cli.js is bundled the same way since Studio: ADE calls `gpt-image studio ...` for every edit
// and run, and the MCP server starts the run worker through it, so its cold start matters too.
import { build } from "esbuild";

for (const name of ["mcp", "cli"]) await build({
  entryPoints: [`src/${name}.ts`],
  outfile: `dist/${name}.js`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["sharp"],
  // CommonJS dependencies inside an ESM bundle still need a real require for Node built-ins.
  banner: { js: "import { createRequire as __gptImageCreateRequire } from 'node:module';\nconst require = __gptImageCreateRequire(import.meta.url);" },
  legalComments: "eof",
  logLevel: "warning",
  allowOverwrite: true,
});
