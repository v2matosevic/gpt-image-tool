# Working on gpt-image-tool

- Read README.md for the public contract, docs/ARCHITECTURE.md for internals, and docs/TOOLS.md for parameters. docs/AGENTS.md is the image-usage playbook.
- Use Node.js 22.18+. Install: `npm ci`. Build: `npm run build`. Offline checks: `npm test` and `npm run smoke:mcp`.
- Never log credentials, commit auth files, or put real account data into fixtures. CI must not call image providers.
- Never silently switch from subscription to the paid API backend. Keep account-dependent behavior explicit in docs.
- Reserve MCP stdout for the protocol; log diagnostics to stderr.
- Preserve explicit user options when merging project profiles. Edits and upscales inherit operational defaults, not generation style.
- Preset changes require `npm run docs:presets`. Regenerate launch layouts with `npm run assets:launch`; it only composites local files.
- Live generation spends usage. Distinguish live results from synthetic checks and inspect saved outputs before making visual claims.
- Publication checks: `npm run audit:publication` scans all locally reachable git refs without printing matched secrets. Fetch remote refs before relying on it for a visibility change. It is heuristic, not a complete security audit.
