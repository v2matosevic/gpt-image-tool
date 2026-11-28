// Loaded before every test file (package.json "test": node --import ./test/setup-env.mjs).
// Tests never touch the real user-level spend ledger, user secrets or this repo's own project
// folder, and never see a real key: a test that needs one of these sets its own.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.GPT_IMAGE_SECRETS_HOME ??= mkdtempSync(join(tmpdir(), "gptimage-test-home-"));
process.env.GPT_IMAGE_PROJECT_DIR ??= mkdtempSync(join(tmpdir(), "gptimage-test-project-"));
delete process.env.OPENAI_API_KEY;
