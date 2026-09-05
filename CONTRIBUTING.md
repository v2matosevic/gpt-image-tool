# Contributing

Small, focused contributions are welcome: reproducible bug fixes, clearer client setup, useful presets, and improvements to local image processing.

## Start locally

Use Node.js 22.18 or newer, then run:

```sh
npm ci
npm test
npm run smoke:mcp
```

These checks require no credentials and make no image requests. Live generation is optional, spends your account usage, and must be described separately from offline tests. Never use someone else's credentials.

## Make a change

Open an issue before a large feature or provider redesign. Keep pull requests focused, describe the user-visible change, and include relevant validation. Add meaningful tests for changed behavior, especially auth, retries, parsing, and image operations. Do not add tests that merely repeat static documentation.

Presets live in `src/presets/lib/`. Run `npm run docs:presets` after changing the catalog. Include a generated example only if it is yours to share; remove private prompt details and local paths from sidecars.

Use the [architecture guide](docs/ARCHITECTURE.md) and [tool reference](docs/TOOLS.md). Do not log tokens, introduce implicit paid fallback, or send image-generation requests in CI. MCP stdout is reserved for protocol traffic; diagnostics go to stderr.

## Submit

Explain the problem, the resulting behavior, and what you checked. Identify which backend and OS you exercised. A green local test suite does not establish live endpoint availability or all-client compatibility.

Contributions are provided under the repository's MIT license. Treat contributors respectfully. For sensitive reports, use [SECURITY.md](SECURITY.md).
