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

/** calls: array that records [kind, node, text, renderer]; delayMs per provider slot (a number, or
 *  a function of the slot index so concurrent slots can finish out of order); fail(x) may
 *  throw. usage(x) returns the API usage a paid slot reports (default 1000 output tokens = $0.03;
 *  return undefined to simulate an API that reports none). Never touches the network. */
export function makeFakes({ calls = [], delayMs = 0, fail, usage = () => ({ input_tokens: 100, output_tokens: 1000, total_tokens: 1100, input_tokens_details: { text_tokens: 100, image_tokens: 0 } }) } = {}) {
  const provider = kind => async x => {
    const ms = typeof delayMs === "function" ? delayMs(x.slot.index) : delayMs;
    if (ms) await new Promise(r => setTimeout(r, ms));
    if (fail) fail(x, calls);
    calls.push([kind, x.node.id, x.slot.text ?? x.slot.label, x.slot.render ? `api ${x.slot.render.model}` : "subscription"]);
    const path = `${x.outBase}.png`;
    await writeFile(path, fakePng(`${x.slot.fingerprint}:${x.takeId}`));
    const u = x.slot.render ? usage(x) : undefined;
    return { path, generations: 1, compiledPrompt: `compiled: ${x.slot.text ?? ""}`, ...(u ? { usage: u } : {}) };
  };
  const process = async x => (x.node.settings.op === "upscale" || x.node.settings.use_model ? provider("process")(x) : realExecutors.process(x));
  return { calls, executors: { generate: provider("generate"), edit: provider("edit"), process, finish: provider("finish"), handoff: realExecutors.handoff, implementation: realExecutors.implementation } };
}
