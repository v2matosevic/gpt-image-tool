// The single place that knows how to talk to the ChatGPT-backend Codex Responses endpoint:
// URL + the exact header shape the backend gates on. Both the image provider (subscription.ts)
// and the vision proof-loop (proof.ts) call this — a header/originator rotation is fixed once.

import { randomUUID } from "node:crypto";
import { userAgent } from "./auth.js";
import type { SubscriptionCreds } from "./auth.js";

export const CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

/** POST a Responses-API body as the given subscription credentials (SSE reply expected). */
export function codexResponsesRequest(
  creds: SubscriptionCreds,
  version: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  const uuid = randomUUID();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${creds.accessToken}`,
    Accept: "text/event-stream",
    Connection: "Keep-Alive",
    version,
    session_id: uuid,
    "x-client-request-id": uuid,
    "User-Agent": userAgent(version),
    originator: "codex_cli_rs",
  };
  if (creds.accountId) headers["chatgpt-account-id"] = creds.accountId;
  return fetch(CODEX_RESPONSES_ENDPOINT, { method: "POST", headers, body: JSON.stringify(body), signal });
}
