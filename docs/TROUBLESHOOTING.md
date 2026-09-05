# Troubleshooting

## Server is missing from the client

Run `npm run build` in the checkout. Confirm the configured `dist/mcp.js` exists and the client can find `node`. Use an absolute path. Reconnect or restart after changing the configuration. Run `npm run smoke:mcp` for a credential-free handshake check.

## No credentials, missing access token, or session rejected

Run `node dist/cli.js --check`. Do not post its account details publicly. Confirm you used ChatGPT login, not API-key login, and that credentials are stored in a file. See [authentication setup](SETUP.md#choose-authentication). Sign in again if the session is invalid. Do not infer that another device caused the problem; an error alone does not establish its cause.

## Health check passes, generation fails

The check does not make an image request. Model access, quota, endpoint changes, and network problems can still prevent generation. Capture the HTTP status and a redacted error, Node version, backend, and client version. The subscription backend is experimental. Select the paid API backend explicitly only if you intend to use separate billing.

## HTTP 400, 401, 403, or 429

- `400`: the model or parameters may not be accepted. Update the checkout and check the error before changing `GPT_IMAGE_MODEL`. A routing model override is account-dependent.
- `401` or `403`: check authentication and account access. The tool attempts a refresh when possible; repeated rejection needs investigation or a fresh login.
- `429`: bounded retries are already built in. Let your quota recover; avoid repeated parallel jobs.

## Client stops waiting

Image generation can take several minutes. Increase the client's per-tool timeout, for example `tool_timeout_sec = 600` in Codex. A carousel performs sequential image jobs and can exceed that. Request fewer slides or one image at a time. The provider's timeout is per request, not a total batch budget.

## Transparent image has halos or missing areas

Subscription transparency uses a generated solid chroma field and local keying. Inspect against both light and dark backgrounds. Provide your subject palette in `style.color`, simplify the subject, or generate against the actual page background with `background: "opaque"`. For busy photographs, model-assisted removal regenerates the subject and can alter it.

## Text is wrong or clipped

Use a text-free generated plate with `compose_overlay` for exact copy. Install `sharp` with `npm ci` and use an installed font with the required glyphs. Exact strings still need a visual check for wrapping and clipping. A model proof-loop can miss errors and uses additional subscription requests.

## Profile did not apply

Use strict JSON without comments. Supply an absolute output path inside the intended project, or explicitly set `GPT_IMAGE_PROFILE`. Profile image paths resolve relative to the profile. Remove example `styleReference` entries until those files exist. Edits and upscales intentionally do not inherit generation style.

## API key appears ignored

Choose `GPT_IMAGE_BACKEND=apikey` or CLI `--backend apikey`. A key alone does not select that backend. `.env` is not loaded automatically; use `node --env-file=.env ...` or pass environment variables through your shell/client.

## Report an issue safely

Use the [bug report form](https://github.com/v2matosevic/gpt-image-tool/issues/new?template=bug_report.yml). Share a minimal prompt and error with account IDs, emails, tokens, local private paths, client images, and keys removed. Never attach `auth.json`. Security reports belong in the [private reporting channel](../SECURITY.md).
