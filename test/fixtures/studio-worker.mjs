// A slow Studio run in its own process, so a test can kill it mid-run. Fake executors only.
import { startRun } from "../../dist/studio/runner.js";
import { makeFakes } from "./studio-fakes.mjs";

const [project, slug, delay] = process.argv.slice(2);
const { executors } = makeFakes({ delayMs: Number(delay) || 400 });
await startRun(project, slug, { actor: "slow-worker", detach: false, executors });
