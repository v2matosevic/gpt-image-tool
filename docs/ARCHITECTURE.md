# Architecture — how gpt-image-tool works

A deep dive into the internals, for understanding or modifying the system. For *using* it, see the
[README](../README.md) and [TOOLS.md](./TOOLS.md).

## The big picture

```
caller (CLI or MCP agent)
        │  subject + preset + modifiers + style  (or a raw prompt)
        ▼
  resolveOpts ──── .gptimage.json profile  /  --from sidecar   (defaults, overridden by call args)
        ▼
  prompt compiler (src/presets) ─── preset.dims + modifiers + overrides → one prose prompt + settings
        ▼
  provider (subscription | apikey)
        │  subscription: POST chatgpt.com/backend-api/codex/responses, stream SSE
        ▼
  image bytes ──── [transparency key-out] ──── save to disk + write .json sidecar ──── return path(s)
```

Generation returns a **file path**, never just inline bytes — it's the only shape that works for
every agent (Codex opens the path with `view_image`; Claude `Read`s it). `GPT_IMAGE_INLINE=1` adds an
inline copy too.

## Module map (`src/`)

| File | Responsibility |
|---|---|
| `auth.ts` | Read/refresh the ChatGPT OAuth token from `~/.codex/auth.json`; **single-flight refresh lock**; `--check` session validation. |
| `providers/subscription.ts` | Experimental subscription backend: builds the Responses request, streams SSE, retries; reactive 401 refresh. |
| `providers/apikey.ts` | Paid fallback: `/v1/images/generations` + `/v1/images/edits` (multipart), with retry. |
| `sse.ts` | Minimal SSE parser (event kind inferred from the JSON `type`). |
| `retry.ts` | Bounded backoff helpers (429/5xx/network), `Retry-After` aware. |
| `presets/` | The preset library (`lib/*.ts`), the **compiler** (`compile.ts`), the registry + catalog. |
| `generate.ts` | Orchestration: generate / edit / upscale, profile + sidecar overlay, series, transparency, save. |
| `bgremove.ts` | Dependency-free PNG codec + background keyer (chroma/edge flood-fill). |
| `metastrip.ts` | Lossless EXIF/XMP/IPTC/C2PA metadata stripper (PNG/JPEG/WebP container rewrite) — applied to every saved image by default. |
| `imageops.ts` | Resize / fit / `.ico` / save (+ optional `sharp`); background-cutout helper. |
| `webassets.ts` | Web-asset recipes (favicon / og / hero / appicon). |
| `profile.ts` | Discover + load the `.gptimage.json` brand profile. |
| `imageinfo.ts` | Dependency-free PNG/JPEG/WebP dimension reader. |
| `mcp.ts` / `cli.ts` | The two entry points (MCP stdio server / CLI). |

## Auth & the subscription backend

`codex login` stores an OAuth access+refresh token at `~/.codex/auth.json`. This tool **reuses that
file** rather than running its own OAuth flow, so Codex keeps the tokens fresh and there's no second
login. Per call it reads the file fresh; if the access token is near expiry it refreshes via
`auth.openai.com/oauth/token` and writes the rotated token back atomically.

The request goes to `https://chatgpt.com/backend-api/codex/responses` — the same internal Responses
endpoint Codex's own `$imagegen` uses — with `tools: [{ type: "image_generation" }]` and a `version`
header (floored at `0.143.0` so the routing model isn't rejected as "old Codex"). The response is an
SSE stream; we read `response.output_item.done` / `response.completed` events and pull the base64 out
of the `image_generation_call.result`. Image-to-image adds `input_image` content parts (and
`input_image_mask` for inpainting) to the user message.

### Single-flight refresh (important)

`withRefreshLock` (in `auth.ts`) takes a cross-process `O_EXCL` lock next to `auth.json` to
serialize this tool's refresh attempts. The reactive-401 path re-reads the token under the lock
and skips refreshing when another process has already updated it. Stale locks self-heal after
60s. This reduces competing credential writes between instances of this tool; it does not lock
the official Codex client. Server-side token rotation and invalidation rules are not a stable
public contract. Prefer sequential image jobs to limit quota pressure.

## The preset compiler

A **preset** is a bundle of prompt *dimensions* (`medium`, `composition`, `lighting`, `camera`,
`color`, `mood`, `detail`, …). The compiler (`compile.ts`) is a **pure function**: it merges
`preset.dims` ← `modifiers` ← per-call `style` overrides, then renders one subject-led, natural-
language prompt in a fixed dimension order — the prose form gpt-image follows best (not keyword soup,
no weighted tokens). It also resolves `size`/`quality`/`format`/`background`, dedupes the `avoid`
clause into an imperative "Do not include: …", and renders literal `text` verbatim. Because it's
pure, it's heavily unit-tested without any network call.

## Transparency (the chroma trick)

The subscription model **rejects** a native transparent-background flag. So for transparent presets
we: (1) append an instruction to render the subject on a solid **chroma-green** field, then (2) key
that green out locally. `bgremove.ts` is a small dependency-free PNG codec (inflate IDAT, reverse the
scanline filters, re-encode RGBA) plus a keyer. With a *known* key color it removes matching pixels
**globally** (so chroma trapped inside 3D holes / line-icon interiors goes too) and de-spills green
edges; with an unknown background it flood-fills from the image edges (preserving bg-colored regions
enclosed by the subject). The paid `apikey` backend uses `gpt-image-1`'s native transparency instead.

## The web-asset pipeline

`imageops.ts` provides dependency-free RGBA ops — an area-averaging downscaler (crisp, alpha-aware),
cover/contain fit, and an `.ico` encoder (embeds PNGs). `webassets.ts` maps each `kind`
(favicon/og/hero/appicon) to a list of exact sizes and emits the files. PNG + `.ico` need no
dependencies; if `sharp` is installed it's loaded **at runtime** (never a hard dependency) to decode
jpeg/webp input and encode jpeg/webp output, otherwise it falls back to PNG.

## Reliability

- **Retry** (`retry.ts`): 429 / 5xx / network failures retry with exponential backoff + jitter,
  honoring `Retry-After`, bounded by `GPT_IMAGE_MAX_RETRIES` (default 3).
- **Retry-on-empty**: if the model replies with text instead of an image, one forced retry.
- **Timeouts**: total (`GPT_IMAGE_TIMEOUT_MS`, default 300s) and stall (`GPT_IMAGE_STALL_MS`, 120s).
- **Single-flight refresh**: see above.

## Testing

`npm test` builds, then runs `node:test` over `test/*.test.ts` (zero extra deps). Coverage is on the
deterministic core that needs no quota: the SSE parser, auth/version/JWT logic, the refresh lock, the
prompt compiler + registry integrity, the PNG codec + keyer, image-resize/fit/ico, and the full
web-asset export (verified on synthetic images). Live generation is intentionally **not** in the
test path.
