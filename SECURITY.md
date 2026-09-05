# Security and data handling

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/v2matosevic/gpt-image-tool/security/advisories/new). If the private form is unavailable, open an issue containing only a request for a private contact, without exploit details or sensitive data. There is no guaranteed response-time commitment.

The latest version on `main` is the maintained version. Report older-version issues with a reproduction on current `main` where possible.

## Trust boundary

This is a local stdio MCP server. It runs with the launching user's filesystem permissions. A trusted agent can ask it to read reference images and write output files at supplied paths; metadata stripping can overwrite an input file. It is not a sandbox and should not be exposed as a public service.

The subscription backend reads a local Codex credential file, can send refresh credentials to `auth.openai.com`, and can write updated credentials back. Generation sends prompts, reference images, and masks to `chatgpt.com`. The explicit API backend sends requests to `api.openai.com` with `OPENAI_API_KEY`.

Local export, local background removal, deterministic overlays, preset listing, and metadata stripping do not need image-generation requests. Model-assisted background removal and social-card generation do. The optional vision proof-loop sends the rendered image and prompt to the subscription backend, including when the original image was generated using the API backend. Disable proof for an API-only workflow.

## Before sharing output

Generated sidecars contain prompts, reference paths, settings, and revised prompts. Inspect them before committing or posting. Health-check output can identify your account and local paths. Never share credential files, `.env`, access tokens, refresh tokens, or private client assets.

The default save pipeline strips EXIF/XMP/C2PA metadata. Set `GPT_IMAGE_KEEP_METADATA=1` to keep the model's returned metadata when desired. Label generated examples honestly; metadata removal does not change how an image was made.

The experimental subscription integration is not endorsed by OpenAI. This project does not establish permission to use an undocumented endpoint or guarantee continuing access. Provider terms and account restrictions remain applicable.
