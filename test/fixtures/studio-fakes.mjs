// Fake provider executors for Studio tests: they write small synthetic PNGs and never touch the
// network. Local executors (handoff, implementation, local process ops) are the real ones.
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { encodePng } from "../../dist/bgremove.js";
import { realExecutors } from "../../dist/studio/execute.js";

export function fakePng(seed, w = 48, h = 32) {
  const d = createHash("sha256").update(seed).digest();
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const left = i % w < w / 2;
    data.set(left ? [d[0], d[1], d[2], 255] : [d[3], d[4], d[5], 255], i * 4);
  }
  return encodePng({ width: w, height: h, data });
}

/** calls: array that records [kind, node, text]; delayMs per provider slot; fail(x) may throw. */
export function makeFakes({ calls = [], delayMs = 0, fail } = {}) {
  const provider = kind => async x => {
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    if (fail) fail(x, calls);
    calls.push([kind, x.node.id, x.slot.text ?? x.slot.label]);
    const path = `${x.outBase}.png`;
    await writeFile(path, fakePng(`${x.slot.fingerprint}:${x.takeId}`));
    return { path, generations: 1, compiledPrompt: `compiled: ${x.slot.text ?? ""}` };
  };
  const process = async x => (x.node.settings.op === "upscale" || x.node.settings.use_model ? provider("process")(x) : realExecutors.process(x));
  return { calls, executors: { generate: provider("generate"), edit: provider("edit"), process, handoff: realExecutors.handoff, implementation: realExecutors.implementation } };
}
