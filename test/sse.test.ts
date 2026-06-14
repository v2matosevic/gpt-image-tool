import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSse, type SseEvent } from "../src/sse.ts";

// Turn string chunks into a ReadableStream<Uint8Array>, mimicking arbitrary network framing.
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) c.enqueue(enc.encode(chunks[i++]!));
      else c.close();
    },
  });
}

async function collect(chunks: string[]): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of parseSse(streamOf(chunks))) out.push(ev);
  return out;
}

test("parses discrete SSE frames", async () => {
  const evs = await collect([
    'data: {"type":"a","n":1}\n\n',
    'data: {"type":"b","n":2}\n\n',
  ]);
  assert.deepEqual(evs.map((e) => e.type), ["a", "b"]);
  assert.equal((evs[1] as any).n, 2);
});

test("reassembles a frame split across chunk boundaries", async () => {
  const evs = await collect(['data: {"type":"x",', '"v":42}\n\n']);
  assert.equal(evs.length, 1);
  assert.equal((evs[0] as any).v, 42);
});

test("[DONE] sentinel terminates the stream", async () => {
  const evs = await collect(['data: {"type":"a"}\n\n', "data: [DONE]\n\n", 'data: {"type":"never"}\n\n']);
  assert.deepEqual(evs.map((e) => e.type), ["a"]);
});

test("skips comments/keepalives and malformed JSON, flushes trailing frame", async () => {
  const evs = await collect([": keepalive\n\n", "data: {bad json}\n\n", 'data: {"type":"last"}']);
  assert.deepEqual(evs.map((e) => e.type), ["last"]);
});

test("joins multi-line data payloads", async () => {
  const evs = await collect(['data: {"type":\ndata: "multi"}\n\n']);
  assert.equal(evs[0]!.type, "multi");
});
