# gpt-image-tool

Generate images from your **ChatGPT / Codex subscription** — no per-image API cost — and expose
that as a tool any LLM agent (Claude Code, Codex CLI, Cursor, …) can call via the **Model Context
Protocol (MCP)**. Also usable as a plain CLI.

It works by reusing the OAuth token that `codex login` already stores at `~/.codex/auth.json` and
POSTing to the same ChatGPT-backend Responses endpoint Codex uses, with the built-in
`image_generation` tool. This is the same mechanism behind Codex's own `$imagegen` — generation is
metered against your ChatGPT/Codex usage, not API credits.

## How it works

```
agent ──MCP──▶ generate_image ──▶ SubscriptionProvider
                                     ├─ read ~/.codex/auth.json (refresh token if expired)
                                     ├─ POST https://chatgpt.com/backend-api/codex/responses
                                     │     model gpt-5.5, tools:[{type:image_generation}], stream
                                     └─ parse SSE → image_generation_call.result (base64)
                                  ──▶ save PNG to disk ──▶ return absolute path
```

The tool **saves the image to disk and returns its path**. That's the only return shape that works
for every agent: Codex can't see inline image blocks (it opens the path with its `view_image` tool),
and Claude Code can `Read` the path to view it. (Set `GPT_IMAGE_INLINE=1` to additionally embed the
image inline in MCP results.)

## Requirements

- Node 18+ (built/tested on Node 22).
- `codex` logged in with a ChatGPT account: run `codex login` once. The subscription backend needs
  no API key.

## Install & build

```bash
cd B:/Coding/gpt-image-tool
npm install
npm run build
```

## CLI

```bash
node dist/cli.js "a red fox curled up in fresh snow, soft watercolor" -o fox.png
node dist/cli.js "minimal flat logo, single line, navy" --size 1024x1024 --format webp
node dist/cli.js "product mockup" --backend apikey   # paid OpenAI Images API (needs OPENAI_API_KEY)
```

Prints the saved file path to stdout. Options: `-o/--out`, `--size`, `-q/--quality`, `-f/--format`,
`-b/--backend`, `-h`.

### Health check

```bash
node dist/cli.js --check      # or: npm run check
```

Validates the subscription session **without spending any image quota** (it only exercises the
OAuth refresh). Prints the auth file in use, the signed-in account, the token expiry, and either
`✓ valid` or the exact re-login command. Run this first whenever generation fails or after setting
up a new machine.

## Register with agents

**Claude Code** (user scope = available in every project):

```bash
claude mcp add --scope user --transport stdio gpt-image -- node "B:/Coding/gpt-image-tool/dist/mcp.js"
```

**Codex** — in `~/.codex/config.toml`:

```toml
[mcp_servers.gpt-image]
command = "node"
args = ["B:/Coding/gpt-image-tool/dist/mcp.js"]
tool_timeout_sec = 180   # image generation exceeds the 60s default
```

By default it rides `~/.codex/auth.json` — the same login your normal Codex coding keeps fresh, so
nothing extra goes stale. `GPT_IMAGE_AUTH_FILE` can point it at a separate auth file, but note that
Codex allows only **one live ChatGPT session per machine**: a dedicated second account just gets
superseded (see *Caveats* → shared token file), so the override is rarely worth it. Any other MCP
client: run `node B:/Coding/gpt-image-tool/dist/mcp.js` as a stdio server.

## Backends

| Backend | Cost | Auth | Notes |
|---|---|---|---|
| `subscription` *(default)* | Free (your ChatGPT/Codex quota) | `~/.codex/auth.json` | The whole point of this tool. |
| `apikey` | Paid (~$0.01–0.17/image) | `OPENAI_API_KEY` | Stable fallback / bulk. Never used unless selected. |

## Configuration

See `.env.example`. Everything is optional for the subscription backend. Notable:
`GPT_IMAGE_MODEL` (default `gpt-5.5`), `GPT_IMAGE_OUTPUT_DIR`, `GPT_IMAGE_INLINE`, `GPT_IMAGE_TIMEOUT_MS`.

## Use it on a new machine

The repo carries the code; the **auth is per-device** (each machine has its own `codex login`; the
token file is never committed). On a fresh checkout:

```bash
git clone https://github.com/v2matosevic/gpt-image-tool.git
cd gpt-image-tool && npm install && npm run build

codex login            # if not already signed in on this machine
node dist/cli.js --check   # confirm the session is live
```

Then register with your agents (above), pointing `dist/mcp.js` at this checkout's path. That path
differs per machine, so the MCP registration is **not** synced between devices — set it once per
machine.

> ⚠ It's the same ChatGPT account & quota as your interactive Codex/ChatGPT use. Codex keeps only
> **one live session per machine**, and signing the same account into Codex on another device
> supersedes this one (`--check` will then report "session ended" — just `codex login` again).

## Caveats (read once)

- **Undocumented endpoint.** `backend-api/codex/responses` is an internal API; OpenAI may change or
  restrict it, and the routing model id churns (a stale Codex `version` header gets `gpt-5.5` rejected
  with a 400 — this tool floors the header at `0.130.0` to avoid that). If the subscription path
  breaks, switch to `--backend apikey` while it's updated. The model is a one-line config const.
- **Terms of service.** Using this endpoint outside the official Codex client is unsanctioned. Fine
  for personal/dev use (it's the identical call Codex makes); do **not** point it at a public or
  multi-user service.
- **Shared token file.** This tool and Codex both refresh `~/.codex/auth.json` (last-writer-wins).
  We read fresh per call and only refresh when expired.
- **Rate limits.** Generation spends the same quota as interactive ChatGPT/Codex. A `429` means wait
  a few minutes; don't hammer it.
