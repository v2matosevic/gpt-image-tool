import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffMs, isNetworkError, isRetryableStatus, retryAfterMs } from "../dist/retry.js";

test("isRetryableStatus: 429 and 5xx retry; 4xx and 2xx do not", () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(200), false);
});

test("retryAfterMs parses seconds and caps, returns null without the header", () => {
  const withSecs = new Response(null, { headers: { "retry-after": "5" } });
  assert.equal(retryAfterMs(withSecs), 5000);
  const huge = new Response(null, { headers: { "retry-after": "100000" } });
  assert.equal(retryAfterMs(huge, 90_000), 90_000); // capped
  assert.equal(retryAfterMs(new Response(null)), null);
});

test("backoffMs grows exponentially within a jittered band and respects the cap", () => {
  for (let i = 0; i < 4; i++) {
    const v = backoffMs(i, 4000, 60000);
    const base = Math.min(4000 * 2 ** i, 60000);
    assert.ok(v >= base * 0.7 && v <= base * 1.3, `attempt ${i}: ${v} near ${base}`);
  }
  // capped
  assert.ok(backoffMs(20, 4000, 60000) <= 60000 * 1.3);
});

test("isNetworkError: TypeError when not aborted is retryable; aborted is not", () => {
  assert.equal(isNetworkError(new TypeError("fetch failed"), false), true);
  assert.equal(isNetworkError(new TypeError("fetch failed"), true), false);
  assert.equal(isNetworkError(new Error("other"), false), false);
});
