# Public source release verification

Prepared September 5, 2026, from `530f194` on `main`.

## Local evidence

- Windows, Node.js 22.22.0. A clean `npm ci` completed successfully.
- `npm test`: 87 passed, zero failed, no credentials or provider requests.
- `npm run smoke:mcp`: fresh stdio process initialized, listed all ten expected tools, and returned the webdev catalog without credentials.
- `npm run docs:presets`: 70 presets and 23 modifiers, no catalog drift.
- `npm audit fix`: compatible lockfile updates cleared six reported dependency advisories. Subsequent clean install reported zero vulnerabilities across 105 audited packages.
- Publication heuristic scanned 222 historical blobs across all locally reachable refs before edits, including remote sync branches and tags; no credential-pattern or sensitive-filename findings. Remote heads were fetched before publication. The script is rerun on the final committed tree. It does not prove the absence of every possible secret.
- Relative Markdown links were checked for existing targets. `git diff --check` passed.

## Live evidence

Two `generate_image` calls through the subscription MCP backend produced the committed paper sculpture and fox mascot. Their full generation specifications are beside the images. They were visually inspected, and a contact sheet of all launch layouts was reviewed.

Both requests specified 1024×1024 and returned 1254×1254. The sculpture is opaque; the fox's alpha channel includes both fully transparent and fully opaque pixels. Requested dimensions in a sidecar are not measured output dimensions.

A real `export_web_assets` call produced four WebP hero widths from the sculpture: 640, 828, 1200, and 1254 pixels. It used local image processing and did not upscale beyond the source. These check outputs are ignored, not release assets.

The README and social kit use actual outputs with deterministic layout and typography. The workflow graphic is labeled as an explanatory panel, not a captured coding-client session. Social posts and demo footage have not been fabricated or submitted.

## Limits

Local checks establish this machine's behavior. The GitHub Actions matrix checks Windows, macOS, and Linux with Node 22, plus Linux with Node 24; inspect the actual run before claiming those platforms passed. No live API-key request was made. The live subscription tests establish access on one account at one point in time, not an upstream service contract or support for every MCP client.

Public GitHub settings, release publication, and any CI outcome are recorded in the release and Actions UI. Social-preview upload requires an authenticated owner browser session. Social copy is prepared for manual publication when the maintainer chooses accounts and timing.
