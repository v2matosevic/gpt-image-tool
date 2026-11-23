# Working on gpt-image-tool

- Read README.md for the public contract, docs/ARCHITECTURE.md for internals, and docs/TOOLS.md for parameters. docs/AGENTS.md is the image-usage playbook.
- Public-release pickup: docs/RELEASE-VERIFICATION.md records the exact release, CI evidence, launch assets, remaining owner actions, and limits. docs/launch/README.md carries the social copy.
- Use Node.js 22.18+. Install: `npm ci`. Build: `npm run build` (tsc, then bundles `dist/mcp.js` into one file). Offline checks: `npm test` and `npm run smoke:mcp`.
- Keep `dist/mcp.js` a single-file bundle (`test/bundle.test.ts` enforces it). Unbundled cold starts from the B: hard drive exceeded ToolHub's start limit, and every call failed with "Request timed out". Don't build with bare `tsc` before handing off.
- Claude terminals reach this server through ToolHub (`http://127.0.0.1:7802/mcp/gpt-image`, one backend per terminal); Codex starts `dist/mcp.js` directly. If calls time out, check `~/.toolhub/hub.log` and run `node B:/Coding/ToolHub/bin/toolhub.mjs check gpt-image` before blaming the provider or quota.
- Never log credentials, commit auth files, or put real account data into fixtures. CI must not call image providers.
- Never silently switch from subscription to the paid API backend. Keep account-dependent behavior explicit in docs.
- Reserve MCP stdout for the protocol; log diagnostics to stderr.
- Preserve explicit user options when merging project profiles. Edits and upscales inherit operational defaults, not generation style.
- Preset changes require `npm run docs:presets`. Regenerate launch layouts with `npm run assets:launch`; it only composites local files.
- Live generation spends usage. Distinguish live results from synthetic checks and inspect saved outputs before making visual claims.
- Publication checks: `npm run audit:publication` scans all locally reachable git refs without printing matched secrets. Fetch remote refs before relying on it for a visibility change. It is heuristic, not a complete security audit.
