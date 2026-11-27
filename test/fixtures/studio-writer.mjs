// One of several processes editing the same Studio graph at once.
import { editGraph } from "../../dist/studio/api.js";

const [project, slug, who, count] = process.argv.slice(2);
for (let i = 0; i < Number(count); i++) {
  await editGraph(slug, [{ op: "add", id: `${who}-${i}`, type: "prompt", settings: { text: `${who} ${i}` } }], { project, actor: who });
}
