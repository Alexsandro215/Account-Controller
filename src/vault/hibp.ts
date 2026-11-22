import { createHash } from "node:crypto";

// Have I Been Pwned "range" API with k-anonymity: only the first 5 hex characters of each
// password's SHA-1 leave this server; the match happens locally. Padding hides how many
// real matches a prefix has. https://haveibeenpwned.com/API/v3#PwnedPasswords

const RANGE_URL = "https://api.pwnedpasswords.com/range/";
const CONCURRENCY = 4;
const TIMEOUT_MS = 10_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function sha1Hex(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("hex").toUpperCase();
}

/** Times each password appears in known breaches. Throws if the service is unreachable. */
export async function pwnedCounts(passwords: string[], fetchImpl: FetchLike = fetch): Promise<Map<string, number>> {
  const hashes = new Map(passwords.map((password) => [password, sha1Hex(password)]));
  const prefixes = [...new Set([...hashes.values()].map((hash) => hash.slice(0, 5)))];
  const suffixCounts = new Map<string, Map<string, number>>();

  for (let i = 0; i < prefixes.length; i += CONCURRENCY) {
    await Promise.all(
      prefixes.slice(i, i + CONCURRENCY).map(async (prefix) => {
        suffixCounts.set(prefix, await fetchRange(prefix, fetchImpl));
      })
    );
  }

  const result = new Map<string, number>();

  for (const [password, hash] of hashes) {
    result.set(password, suffixCounts.get(hash.slice(0, 5))?.get(hash.slice(5)) ?? 0);
  }

  return result;
}

async function fetchRange(prefix: string, fetchImpl: FetchLike): Promise<Map<string, number>> {
  const response = await fetchImpl(`${RANGE_URL}${prefix}`, {
    headers: { "Add-Padding": "true", "User-Agent": "account-controller-vault" },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`Pwned Passwords returned ${response.status}`);
  }

  return parseRange(await response.text());
}

export function parseRange(body: string): Map<string, number> {
  const counts = new Map<string, number>();

  for (const line of body.split(/\r?\n/)) {
    const [suffix, count] = line.trim().split(":");

    if (suffix && count) {
      counts.set(suffix.toUpperCase(), Number(count));
    }
  }

  return counts;
}
