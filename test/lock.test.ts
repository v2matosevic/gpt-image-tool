import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRefreshLock } from "../dist/auth.js";
import { sleep } from "../dist/retry.js";

// Point the lock file at a temp dir (lock lives next to the auth file).
process.env.GPT_IMAGE_AUTH_FILE = join(tmpdir(), "gpt-image-locktest-auth.json");

test("withRefreshLock serializes concurrent refreshes (single-flight)", async () => {
  let active = 0;
  let maxActive = 0;
  const order: number[] = [];
  const task = (id: number) =>
    withRefreshLock(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(40);
      order.push(id);
      active--;
      return id;
    });

  const results = await Promise.all([task(1), task(2), task(3)]);
  assert.equal(maxActive, 1, "no two refreshes may run at once");
  assert.deepEqual(results.sort(), [1, 2, 3]);
  assert.equal(order.length, 3);
});
