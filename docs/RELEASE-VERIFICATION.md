# Public source release verification

Completed September 5, 2026. This is the canonical release handoff.

## Published state

- Repository: [v2matosevic/gpt-image-tool](https://github.com/v2matosevic/gpt-image-tool), public, MIT licensed, with a description, discovery topics, issue forms, contribution guidance, and private vulnerability reporting enabled.
- Released source: `7a445c66b25318a5d265c08910bb20f4f0884d16`, prepared from `530f194`. [Release v0.3.0](https://github.com/v2matosevic/gpt-image-tool/releases/tag/v0.3.0) is published, not a draft. Later handoff-only commits on `main` do not change that released source.
- [CI run 33973876223](https://github.com/v2matosevic/gpt-image-tool/actions/runs/33973876223) passed all four jobs: Node 22 on Windows, macOS, and Linux; Node 24 on Linux. Every job installed dependencies, ran the 87 tests and MCP smoke check, regenerated the catalog, and checked for catalog drift.
- The public README was opened in a signed-out browser. Both images loaded. Desktop and 390-pixel mobile screenshots were inspected, with no horizontal page overflow in the mobile check.
- Installation remains from source. `package.json` deliberately retains `private: true`; no npm package was published.

Confidence is high for these observed outcomes. Upstream subscription availability remains account-dependent and experimental.

## Deliverables and source of truth

- [README](../README.md): positioning, portable quick start, capabilities, and limits.
- [SETUP.md](SETUP.md): Claude Code, Cursor, Codex, generic local MCP, file-based authentication, and explicit API-key setup. Current official client documentation is linked there.
- [EXAMPLES.md](EXAMPLES.md), [TOOLS.md](TOOLS.md), [PRESETS.md](PRESETS.md), and [AGENTS.md](AGENTS.md): workflows, parameters, preset catalog, and agent usage.
- [Asset manifest](assets/README.md): actual generated examples, exact prompt sidecars, provenance, and measured output differences.
- [Launch kit](launch/README.md): post copy for X, LinkedIn, Instagram, and developer communities; six social graphics; alt text; a contact sheet; and a recording shot list.
- [CONTRIBUTING.md](../CONTRIBUTING.md), [SECURITY.md](../SECURITY.md), and [CLAUDE.md](../CLAUDE.md): contribution, credential/data-flow, and maintenance rules.

The [release ZIP](https://github.com/v2matosevic/gpt-image-tool/releases/download/v0.3.0/gpt-image-tool-launch-kit.zip) contains the documentation and launch artwork as packaged at release time. It is 5,753,178 bytes. GitHub's reported digest matches the locally computed SHA-256:

```text
03148df3d92c406a722fc562e660bad1dafca0135737b52e96f47bbce99d3cdf
```

The release ZIP is an immutable launch snapshot; use this document on `main` for the final handoff. Rebuild graphic layouts with `npm ci` followed by `npm run assets:launch`. That command composites the committed samples locally and makes no provider requests. It requires no regeneration of the two original examples.

## Local evidence

- Windows, Node.js 22.22.0. A clean `npm ci` completed successfully.
- `npm test`: 87 passed, zero failed, no credentials or provider requests.
- `npm run smoke:mcp`: fresh stdio process initialized, listed all ten expected tools, and returned the webdev catalog without credentials.
- `npm run docs:presets`: 70 presets and 23 modifiers, no catalog drift.
- `npm audit fix`: compatible lockfile updates cleared six reported dependency advisories. Subsequent clean install reported zero vulnerabilities across 105 audited packages.
- Publication heuristic initially scanned 222 historical blobs. After fetching remote heads and committing the release, the final scan covered 265 blobs across locally reachable branches and tags, including old sync refs. Both scans returned no credential-pattern or sensitive-filename findings. It does not prove the absence of every possible secret.
- Relative Markdown links were checked for existing targets. `git diff --check` passed.

## Live evidence

Two `generate_image` calls through the subscription MCP backend produced the committed paper sculpture and fox mascot. Their full generation specifications are beside the images. They were visually inspected, and a contact sheet of all launch layouts was reviewed.

Both requests specified 1024×1024 and returned 1254×1254. The sculpture is opaque; the fox's alpha channel includes both fully transparent and fully opaque pixels. Requested dimensions in a sidecar are not measured output dimensions.

A real `export_web_assets` call produced four WebP hero widths from the sculpture: 640, 828, 1200, and 1254 pixels. It used local image processing and did not upscale beyond the source. These check outputs are ignored, not release assets.

The README and social kit use actual outputs with deterministic layout and typography. The workflow graphic is labeled as an explanatory panel, not a captured coding-client session. Social posts and demo footage have not been fabricated or submitted.

## Limits

Cross-platform offline CI passed as recorded above. No live API-key request was made, and each named coding client was not separately driven through a new installation. The fresh stdio handshake and existing live MCP calls establish the server behavior that was tested. Live subscription tests establish access on one account at one point in time, not an upstream service contract or universal account access.

## Remaining owner choices

1. Optional GitHub polish, about one minute: in Settings, General, Social preview, upload [github-banner.png](assets/github-banner.png). The available browser was signed out, so this owner-only upload was not performed. The README already displays the banner.
2. Choose accounts and timing for social publication. Recommendation: start with one real example and the prepared announcement, then follow with a concrete workflow. Captions, image order, and alt text are in the launch kit. No social posts or direct messages were sent.
3. Optional video: the launch kit includes a 30–45-second edited-demo shot list, not an actual recording. Record a genuine client workflow and label any shortened generation wait.

No pending implementation is required for the released source. A future maintainer should not republish the npm name, change provider billing behavior, or imply unlimited subscription access as part of routine launch follow-up.

## Wrap-up and replay

The code and launch assets were committed and pushed. The verification browser was closed; no preview server, image job, or test process was left running by this lane. Local screenshots and export checks remain under ignored `generated-images/`; public deliverables are committed or attached to the release. Project memory and the shared-memory pointer were updated with the public release location and corrected authentication caveats.

From a checkout, use `npm ci`, `npm test`, and `npm run smoke:mcp` to replay the offline checks. Use `npm run docs:presets` and inspect the resulting diff after preset changes. Before a future visibility or distribution change, fetch remote refs and run `npm run audit:publication`, then review its limits and any findings. A live generation is a separate, quota-consuming check.
