// Minimal Server-Sent-Events parser for the Responses-API stream. Event kind is inferred from
// the JSON payload's `type` field (not the `event:` line). Tolerant: malformed frames are skipped.

export interface SseEvent {
  type?: string;
  [k: string]: unknown;
}

/**
 * Parse an SSE byte stream into JSON event objects. Calls `onChunk` on every network read
 * (used to reset a stall timer). Terminates cleanly on a `[DONE]` sentinel.
 */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  onChunk?: () => void,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.();
      buf += decoder.decode(value, { stream: true });
      const segments = buf.split(/\r?\n\r?\n/);
      buf = segments.pop() ?? ""; // keep the trailing (possibly incomplete) frame
      for (const seg of segments) {
        const ev = parseEventBlock(seg);
        if (ev === "DONE") return;
        if (ev) yield ev;
      }
    }
    buf += decoder.decode();
    const ev = parseEventBlock(buf);
    if (ev && ev !== "DONE") yield ev;
  } finally {
    reader.releaseLock();
  }
}

function parseEventBlock(block: string): SseEvent | "DONE" | null {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue; // blank or comment/keepalive
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    // `event:` lines are intentionally ignored — we read the payload's own `type`.
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join("\n");
  if (payload.trim() === "[DONE]") return "DONE";
  try {
    return JSON.parse(payload) as SseEvent;
  } catch {
    return null;
  }
}
