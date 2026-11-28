# Connect your coding agent

First clone the repository, run `npm ci`, then `npm run build`, as shown in the [quick start](../README.md#quick-start). Use Node.js 22.18 or newer. The examples below run the built server from your checkout; no global installation of this package is needed.

## Choose authentication

### ChatGPT subscription (experimental, default)

Install Codex CLI using its [official installation instructions](https://developers.openai.com/codex/cli/), then run `codex login` and choose ChatGPT. If you already have a working login, keep it.

This tool reads `~/.codex/auth.json`, or `CODEX_HOME/auth.json` if configured. It cannot read credentials stored only in an OS keychain. If no usable file exists, set `cli_auth_credentials_store = "file"` in your Codex `config.toml`, then sign in again. This stores sensitive credentials on disk, so protect the file and never commit or share it. See [OpenAI's credential storage documentation](https://developers.openai.com/codex/auth/).

```sh
node dist/cli.js --check
```

The check reads the login and may refresh it. It spends no image quota, but does not test model eligibility. A successful first generation is the real access check. The subscription endpoint is undocumented; this project's observed behavior is not an OpenAI guarantee of third-party access.

`GPT_IMAGE_AUTH_FILE` can point to an existing credential file when needed. Prefer the actively maintained Codex file over copying tokens. Never paste token contents into a prompt, issue, or MCP configuration.

### OpenAI API key (separate billing)

The paid backend is used only when a call asks for it: `--backend apikey` on one CLI call, `backend: "apikey"` in MCP, `renderer: "api"` or a `finish` node in Studio, or `GPT_IMAGE_BACKEND=apikey` for a whole process. Having a key never switches backends, and a missing key never falls back to the subscription.

#### Paid API key

The key is looked up in this order, and results name the source that was used (never the value):

1. `OPENAI_API_KEY` in the environment of the process that runs the tool.
2. The project's git-ignored `.secrets` file, one line `OPENAI_API_KEY=sk-...` (also accepted: `OPENAI_API_KEY: sk-...`, quotes, `export`, `#` comments). The project is the one the call works in (Studio's `project`, `GPT_IMAGE_PROJECT_DIR`, `CLAUDE_PROJECT_DIR`, then the current directory).
3. A user-level file, `~/.gptimage/secrets` (or `$GPT_IMAGE_SECRETS_HOME/.gptimage/secrets`), same format.

Make sure `.secrets` is in the project's `.gitignore` before you write it. Errors, sidecars, run records and events are scrubbed of the key and of masked echoes of it; a test plants a canary key, runs successful and refused requests, and greps every written file for it.

With ToolHub (Claude terminals), the backend process inherits the hub's environment and starts in the terminal's project root, so either put the key in that project's `.secrets` or in `~/.gptimage/secrets`; do not pass it through ToolHub headers. Codex starts `dist/mcp.js` directly, so `OPENAI_API_KEY` in Codex's own environment (or either file) works. Restart or reconnect the MCP server after adding a key to its environment; the files are read on every call.

`.env.example` documents variables; the tool does **not** automatically load `.env` files. Use your shell, client environment settings, or Node's `--env-file` option. Keep keys out of committed configuration.

```sh
node --env-file=.env dist/cli.js --backend apikey --subject "a folded paper sculpture" --preset product-studio -o ./sculpture.png
```

This backend uses the documented [OpenAI Images API](https://developers.openai.com/api/docs/guides/image-generation). Version 0.6.0 uses `gpt-image-2.5-sunburst` as the API default; main uses `gpt-image-2.6-sunburst`, and there `flare` / `sunburst` mean 2.6 while `flare-2.5` / `sunburst-2.5` keep 2.5. `GPT_IMAGE_API_MODEL` overrides the default. Select `--image-model` per CLI call, or `image_model` in MCP. Both require `backend: "apikey"`; the subscription endpoint does not reliably enforce renderer selection. Model availability and supported dimensions vary. Changing a model name does not automatically make every feature compatible.

## Upgrade an existing installation

Stop image jobs first. From a clean checkout with no local changes, install the tagged release:

```sh
git fetch origin --tags
git switch --detach v0.6.0
npm ci
npm run build
npm run smoke:mcp
```

Reconnect the MCP server in your coding client so it loads the new build. The server now reports version `0.6.0` and exposes 13 tools, including `preview_image_request`, `export_logo_kit` and `create_brand_board`. For Codex, use both timeout settings in the configuration below; already running sessions need a reconnect or restart.

The CLI is ready as soon as the build completes. A running MCP process keeps its previously loaded code until reconnected. `npm run smoke:mcp` starts a fresh server and verifies the release version, catalog and local branding tools without credentials or image usage. The default `npm ci` includes `sharp`, which the branding exports need; do not use `--omit=dev` for the documented installation.

Upgrading past v0.6.0 (main, not yet tagged) changes two things for paid API users. `flare` and `sunburst` now mean GPT-Image-2.6 rather than 2.5: a profile `imageModel: "flare"`, `GPT_IMAGE_API_MODEL=sunburst` or a call naming them moves to 2.6; write `flare-2.5` / `sunburst-2.5` (or the full ID) to stay on 2.5. Images replayed with `--from` / `from_image` keep the full model ID their sidecar recorded. And every API request is now checked against spend limits before it is sent (defaults $2 per call, $10 per project per day, $25 per day across projects); raise them in your profile's `studio.limits` and `~/.gptimage/config.json` if your use needs more. Subscription use is unchanged.

Existing `GPT_IMAGE_MODEL`, `GPT_IMAGE_PROOF_MODEL`, and `GPT_IMAGE_API_MODEL` overrides still win. Remove an old override to adopt the new default, or keep it to retain your chosen model. No API key or paid backend is enabled by upgrading. See [model selection and verification](MODELS.md).

## Claude Code

Run this in your terminal, replacing the checkout path:

```sh
claude mcp add --scope user --transport stdio gpt-image -- node "/absolute/path/gpt-image-tool/dist/mcp.js"
```

Use `/mcp` to check the server connection and reconnect after rebuilding. If a tool times out, increase its execution timeout in the client. For example, Claude Code supports a per-server `"timeout": 600000` field in a `.mcp.json` server entry. Large series or carousels may need longer, or request one image at a time. [Official Claude Code MCP guide](https://code.claude.com/docs/en/mcp).

## Cursor

Merge this entry into your user `~/.cursor/mcp.json` or project `.cursor/mcp.json`. Replace the path; do not overwrite other servers:

```json
{
  "mcpServers": {
    "gpt-image": {
      "command": "node",
      "args": ["/absolute/path/gpt-image-tool/dist/mcp.js"]
    }
  }
}
```

Enable the server in Cursor's MCP settings and use an agent mode with tool access. This is a local stdio configuration, not a cloud-agent integration. [Official Cursor MCP guide](https://cursor.com/docs/mcp).

## Codex

Merge this into `~/.codex/config.toml`:

```toml
[mcp_servers.gpt-image]
command = "node"
args = ["/absolute/path/gpt-image-tool/dist/mcp.js"]
startup_timeout_sec = 120
tool_timeout_sec = 600
```

Restart or reconnect the client. Increase the timeout for long batches. Some Codex surfaces already have image generation; this server adds presets, profiles, local exports, and shared workflows. [Official Codex MCP guide](https://developers.openai.com/codex/mcp/).

## Other local MCP clients

Use `node` as the command, the absolute path to `dist/mcp.js` as its argument, and stdio as the transport. The client must support local process execution. Configuration field names vary; use your client's instructions rather than assuming the Cursor JSON schema applies everywhere.

The server returns absolute paths. The agent needs permission to read those files to inspect images, and to write into the target project. Remote agents need their own checkout, credentials, and filesystem access.

## Windows, macOS, and Linux paths

- Windows: `C:/tools/gpt-image-tool/dist/mcp.js` works in JSON and TOML without escaping backslashes.
- macOS: `/Users/you/tools/gpt-image-tool/dist/mcp.js`.
- Linux: `/home/you/tools/gpt-image-tool/dist/mcp.js`.

Use a real absolute path; `~` is not expanded inside every client's argument list. If a GUI client cannot find `node`, give it the absolute path to your Node executable.

## First successful call

Ask the agent to call `list_image_presets`, then generate one image with an explicit absolute `output_path`. It should open the saved file, inspect it, and add it to your project. See [copyable workflows](EXAMPLES.md).

## Update

From a clean checkout, run `git pull --ff-only`, `npm ci`, and `npm run build`. Reconnect the MCP server so it loads the new build. Run `npm run smoke:mcp` to verify the connection without spending image quota.
