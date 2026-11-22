import type { CredentialSummary } from "./credentials.js";
import { passwordStrength } from "./generator.js";
import { pwnedCounts, type FetchLike } from "./hibp.js";

export const OLD_PASSWORD_DAYS = 365;

export type HealthEntry = { credential: CredentialSummary; password: string | null };

export type HealthReport = {
  total: number;
  /** null when the online check was disabled or failed. */
  pwned: { credential: CredentialSummary; count: number }[] | null;
  reused: CredentialSummary[][];
  weak: { credential: CredentialSummary; label: string }[];
  old: { credential: CredentialSummary; days: number }[];
  unreadable: CredentialSummary[];
  /** Share of credentials without any problem, 0-100. */
  score: number;
};

export async function buildHealthReport(
  entries: HealthEntry[],
  options: { checkPwned: boolean; now?: Date; fetchImpl?: FetchLike }
): Promise<HealthReport> {
  const now = options.now ?? new Date();
  const readable = entries.filter((entry): entry is { credential: CredentialSummary; password: string } => entry.password !== null);
  const unreadable = entries.filter((entry) => entry.password === null).map((entry) => entry.credential);

  let pwned: HealthReport["pwned"] = null;

  if (options.checkPwned && readable.length > 0) {
    try {
      const counts = await pwnedCounts(
        readable.map((entry) => entry.password),
        options.fetchImpl
      );
      pwned = readable
        .map((entry) => ({ credential: entry.credential, count: counts.get(entry.password) ?? 0 }))
        .filter((entry) => entry.count > 0)
        .sort((a, b) => b.count - a.count);
    } catch (error) {
      console.error("Pwned password check failed", error);
    }
  } else if (options.checkPwned) {
    pwned = [];
  }

  const byPassword = new Map<string, CredentialSummary[]>();

  for (const entry of readable) {
    byPassword.set(entry.password, [...(byPassword.get(entry.password) ?? []), entry.credential]);
  }

  const reused = [...byPassword.values()].filter((group) => group.length > 1);

  const weak = readable
    .map((entry) => ({ credential: entry.credential, strength: passwordStrength(entry.password) }))
    .filter((entry) => entry.strength.score <= 1)
    .map((entry) => ({ credential: entry.credential, label: entry.strength.label }));

  const old = readable
    .map((entry) => ({
      credential: entry.credential,
      days: Math.floor((now.getTime() - entry.credential.passwordChangedAt.getTime()) / 86_400_000)
    }))
    .filter((entry) => entry.days >= OLD_PASSWORD_DAYS)
    .sort((a, b) => b.days - a.days);

  const withProblems = new Set<string>([
    ...(pwned ?? []).map((entry) => entry.credential.id),
    ...reused.flat().map((credential) => credential.id),
    ...weak.map((entry) => entry.credential.id),
    ...old.map((entry) => entry.credential.id),
    ...unreadable.map((credential) => credential.id)
  ]);

  const score = entries.length === 0 ? 100 : Math.round((100 * (entries.length - withProblems.size)) / entries.length);

  return { total: entries.length, pwned, reused, weak, old, unreadable, score };
}
