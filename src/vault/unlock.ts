import type { KeyObject } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { MAX_FREE_UNLOCK_ATTEMPTS, unlockLockDurationMs } from "../security/unlockPolicy.js";
import { audit } from "./audit.js";
import { VaultError } from "./errors.js";
import { openWithSecret } from "./keys.js";

// The decrypted private key lives only here, in memory, while the vault is open. Every use
// pushes the auto-lock back (VAULT_UNLOCK_MINUTES of inactivity). A restart locks it.

type OpenVault = { key: KeyObject; expiresAt: number; timer: NodeJS.Timeout };

let open: OpenVault | undefined;

function idleMs(): number {
  return config.VAULT_UNLOCK_MINUTES * 60_000;
}

export function unlockVault(key: KeyObject): Date {
  lockVault();
  const expiresAt = Date.now() + idleMs();
  open = { key, expiresAt, timer: armAutoLock(expiresAt) };
  return new Date(expiresAt);
}

export function lockVault(): void {
  if (open) {
    clearTimeout(open.timer);
    open = undefined;
  }
}

export function isUnlocked(): boolean {
  return open !== undefined && Date.now() < open.expiresAt;
}

export function unlockExpiresAt(): Date | undefined {
  return isUnlocked() ? new Date(open!.expiresAt) : undefined;
}

/** The private key if the vault is open (and keeps it open a bit longer), else undefined. */
export function unlockedKey(): KeyObject | undefined {
  if (!open || Date.now() >= open.expiresAt) {
    lockVault();
    return undefined;
  }

  clearTimeout(open.timer);
  open.expiresAt = Date.now() + idleMs();
  open.timer = armAutoLock(open.expiresAt);
  return open.key;
}

export function requireUnlockedKey(): KeyObject {
  const key = unlockedKey();

  if (!key) {
    throw new VaultError("vault_locked");
  }

  return key;
}

function armAutoLock(expiresAt: number): NodeJS.Timeout {
  const timer = setTimeout(lockVault, Math.max(0, expiresAt - Date.now()));
  timer.unref();
  return timer;
}

// ---------------------------------------------------------------------------------------
// Unlock attempts with brute-force protection (shared by the bot and the Mini App).
// ---------------------------------------------------------------------------------------

export type UnlockAttempt =
  | { ok: true; via: "master" | "recovery"; key: KeyObject; expiresAt: Date }
  | { ok: false; reason: "wrong"; remainingAttempts: number; lockedUntil?: Date }
  | { ok: false; reason: "locked"; lockedUntil: Date };

const attemptQueues = new Map<string, Promise<unknown>>();

/**
 * Runs secret checks for a user one at a time. Without this, a burst of concurrent guesses
 * (bot + Mini App, or parallel API calls) would all pass the lockout check before any failure
 * is recorded.
 */
export function serializeAttempts<T>(userId: string, run: () => Promise<T>): Promise<T> {
  const previous = attemptQueues.get(userId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  attemptQueues.set(userId, next);

  next
    .finally(() => {
      if (attemptQueues.get(userId) === next) {
        attemptQueues.delete(userId);
      }
    })
    .catch(() => undefined);

  return next;
}

/**
 * Tries a master password, or a recovery code when `allowRecovery` and the input looks
 * like one. On success the vault is opened.
 */
export async function attemptUnlock(userId: string, secret: string, allowRecovery = true): Promise<UnlockAttempt> {
  return serializeAttempts(userId, async () => {
    // Checked before trying the secret so a locked vault never confirms a correct guess.
    const lockedUntil = await currentLock(userId);

    if (lockedUntil) {
      return { ok: false, reason: "locked", lockedUntil };
    }

    const opened = await openWithSecret(secret, allowRecovery);

    if (!opened) {
      return registerFailure(userId);
    }

    await db().unlockGuard.reset(userId);
    const expiresAt = unlockVault(opened.key);
    await audit(opened.via === "recovery" ? "recovery_used" : "unlock");

    return { ok: true, via: opened.via, key: opened.key, expiresAt };
  });
}

export async function currentLock(userId: string): Promise<Date | undefined> {
  const guard = await db().unlockGuard.get(userId);

  if (guard?.lockedUntil && guard.lockedUntil.getTime() > Date.now()) {
    return guard.lockedUntil;
  }

  return undefined;
}

/** For callers that verify a secret themselves (e.g. restoring a backup). */
export async function registerFailure(userId: string): Promise<UnlockAttempt & { ok: false; reason: "wrong" }> {
  const guard = await db().unlockGuard.increment(userId);
  const lockMs = unlockLockDurationMs(guard.failedAttempts);
  await audit("unlock_failed");

  if (lockMs === 0) {
    return { ok: false, reason: "wrong", remainingAttempts: MAX_FREE_UNLOCK_ATTEMPTS - guard.failedAttempts };
  }

  const lockedUntil = new Date(Date.now() + lockMs);
  await db().unlockGuard.setLock(userId, lockedUntil);
  await audit("lockout", null, `${guard.failedAttempts} intentos`);
  console.warn(`Vault locked for user ${userId} after ${guard.failedAttempts} failed attempts`);

  return { ok: false, reason: "wrong", remainingAttempts: 0, lockedUntil };
}

export async function resetFailures(userId: string): Promise<void> {
  await db().unlockGuard.reset(userId);
}
