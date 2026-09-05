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

Set `OPENAI_API_KEY` in the environment that launches the client, and set `GPT_IMAGE_BACKEND=apikey` to choose the paid backend. Setting only a key does not switch backends. For one CLI call, use `--backend apikey`.

`.env.example` documents variables; the tool does **not** automatically load `.env` files. Use your shell, client environment settings, or Node's `--env-file` option. Keep keys out of committed configuration.

```sh
node --env-file=.env dist/cli.js --backend apikey --subject "a folded paper sculpture" --preset product-studio -o ./sculpture.png
```

This backend uses the documented [OpenAI Images API](https://developers.openai.com/api/docs/guides/image-generation). Its default model is `gpt-image-1`; `GPT_IMAGE_API_MODEL` overrides it. Model availability and supported dimensions vary. Changing a model name does not automatically make every feature compatible.

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
