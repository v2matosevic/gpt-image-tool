// Holds the graph lock far past the stale limit while writing state, as a stalled disk would.
// argv: graphDir holdMs name
import { mutate } from "../../dist/studio/store.js";
const [dir, hold, name = "slow"] = process.argv.slice(2);
await mutate(dir, name, async (_g, s) => {
  process.stdout.write("held\n");
  await new Promise(r => setTimeout(r, Number(hold)));
  s.nodes[name] = { takes: [], selected: [] };
  return { result: null };
});
