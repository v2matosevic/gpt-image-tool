// Stands in for dist/cli.js as the run worker (GPT_IMAGE_STUDIO_CLI), with slow fake executors,
// so a test can close the MCP server mid-run without spending quota. argv as the real worker:
// studio worker <slug> --project <dir> --job <id>
import { runJob } from "../../dist/studio/runner.js";
import { makeFakes } from "./studio-fakes.mjs";

const a = process.argv.slice(2);
const flag = name => a[a.indexOf(`--${name}`) + 1];
if (a[0] !== "studio" || a[1] !== "worker") process.exit(2);
await runJob(flag("project"), a[2], flag("job"), makeFakes({ delayMs: Number(process.env.FAKE_DELAY_MS) || 1200 }).executors);
