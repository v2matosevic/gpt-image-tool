import { test } from "node:test";
import assert from "node:assert/strict";
import { cmpVersion, jwtExpiryMs, isExpired } from "../src/auth.ts";

test("cmpVersion orders semver triples", () => {
  assert.equal(cmpVersion("0.130.0", "0.130.0"), 0);
  assert.equal(Math.sign(cmpVersion("0.131.0", "0.130.0")), 1);
  assert.equal(Math.sign(cmpVersion("0.129.9", "0.130.0")), -1);
  assert.equal(Math.sign(cmpVersion("1.0.0", "0.130.0")), 1);
});

test("cmpVersion tolerates short / non-numeric parts", () => {
  assert.equal(Math.sign(cmpVersion("0.130", "0.130.0")), 0);
  assert.equal(Math.sign(cmpVersion("0.130.x", "0.130.0")), 0); // NaN part -> 0
});

// Build an unsigned JWT with the given payload (only the payload segment is read).
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

test("jwtExpiryMs decodes exp (seconds -> ms)", () => {
  assert.equal(jwtExpiryMs(jwt({ exp: 1_700_000_000 })), 1_700_000_000_000);
  assert.equal(jwtExpiryMs(jwt({ sub: "x" })), null); // no exp
  assert.equal(jwtExpiryMs("not-a-jwt"), null);
});

test("isExpired honors skew and unknown-exp default", () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const past = Math.floor(Date.now() / 1000) - 10;
  assert.equal(isExpired(jwt({ exp: future })), false);
  assert.equal(isExpired(jwt({ exp: past })), true);
  // within the default 60s skew window -> treated as expired
  const soon = Math.floor(Date.now() / 1000) + 30;
  assert.equal(isExpired(jwt({ exp: soon })), true);
  // unknown exp -> false (defer to a reactive 401 refresh)
  assert.equal(isExpired(jwt({ sub: "x" })), false);
});
