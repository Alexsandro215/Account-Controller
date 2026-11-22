import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDuration, MAX_FREE_UNLOCK_ATTEMPTS, unlockLockDurationMs } from "../src/security/unlockPolicy.js";

describe("unlockLockDurationMs", () => {
  it("does not lock before the free attempts run out", () => {
    for (let attempts = 0; attempts < MAX_FREE_UNLOCK_ATTEMPTS; attempts++) {
      assert.equal(unlockLockDurationMs(attempts), 0);
    }
  });

  it("doubles the lock on every further failure", () => {
    assert.equal(unlockLockDurationMs(MAX_FREE_UNLOCK_ATTEMPTS), 60_000);
    assert.equal(unlockLockDurationMs(MAX_FREE_UNLOCK_ATTEMPTS + 1), 120_000);
    assert.equal(unlockLockDurationMs(MAX_FREE_UNLOCK_ATTEMPTS + 2), 240_000);
  });

  it("caps the lock at 24 hours", () => {
    assert.equal(unlockLockDurationMs(1_000), 24 * 60 * 60_000);
  });
});

describe("formatDuration", () => {
  it("rounds up to whole minutes", () => {
    assert.equal(formatDuration(1), "1 min");
    assert.equal(formatDuration(61_000), "2 min");
  });

  it("uses hours for long locks", () => {
    assert.equal(formatDuration(60 * 60_000), "1 h");
    assert.equal(formatDuration(64 * 60_000), "1 h 4 min");
  });
});
