export const MAX_FREE_UNLOCK_ATTEMPTS = 3;

const BASE_LOCK_MS = 60_000;
const MAX_LOCK_MS = 24 * 60 * 60_000;

/**
 * Lock duration after `failedAttempts` consecutive wrong master passwords: none for the first
 * attempts, then 1 min, 2 min, 4 min... capped at 24 h. This turns
 * a brute force from minutes into centuries.
 */
export function unlockLockDurationMs(failedAttempts: number): number {
  if (failedAttempts < MAX_FREE_UNLOCK_ATTEMPTS) {
    return 0;
  }

  return Math.min(BASE_LOCK_MS * 2 ** (failedAttempts - MAX_FREE_UNLOCK_ATTEMPTS), MAX_LOCK_MS);
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes} min`;
  }

  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}
