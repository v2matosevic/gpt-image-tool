// Shared retry/backoff helpers so a transient rate limit (429) or server blip (5xx) recovers on its
// own instead of failing the call. Bounded — never an unbounded wait loop.

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Max automatic retries on retryable failures (429 / 5xx / network). Configurable. */
export const MAX_RETRIES = Math.max(0, Number(process.env.GPT_IMAGE_MAX_RETRIES) || 3);

/** 429 (rate limit) and 5xx (transient server) are worth retrying; 4xx (bad request) is not. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/** Honor a `Retry-After` header (seconds or HTTP-date) if present, capped. Returns ms or null. */
export function retryAfterMs(res: Response, capMs = 90_000): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(Math.max(0, secs * 1000), capMs);
  const when = Date.parse(h);
  if (!Number.isNaN(when)) return Math.min(Math.max(0, when - Date.now()), capMs);
  return null;
}

/** Exponential backoff with jitter: ~4s, 8s, 16s … capped. */
export function backoffMs(attempt: number, base = 4_000, cap = 60_000): number {
  const exp = Math.min(base * 2 ** attempt, cap);
  return Math.round(exp * (0.75 + Math.random() * 0.5)); // ±25% jitter to avoid thundering herd
}

/** A network-level fetch failure (not an HTTP status, not our own abort) — worth retrying. */
export function isNetworkError(e: unknown, aborted: boolean): boolean {
  return !aborted && e instanceof TypeError;
}
