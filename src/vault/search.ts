// Forgiving search over the clear-text metadata: accents and case are ignored, every word
// of the query must match something, and small typos ("netflx", "gmial") still match.

export type Searchable = {
  service: string;
  email: string;
  category: string;
  aliases?: string[];
};

export function foldText(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

export function searchCredentials<T extends Searchable>(items: T[], query: string): T[] {
  const tokens = foldText(query).split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return [];
  }

  return items
    .map((item) => ({ item, score: scoreItem(item, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.service.localeCompare(b.item.service, "es"))
    .map((entry) => entry.item);
}

function scoreItem(item: Searchable, tokens: string[]): number {
  const fields = {
    service: foldText(item.service),
    category: foldText(item.category),
    email: foldText(item.email),
    aliases: (item.aliases ?? []).map(foldText)
  };
  let total = 0;

  for (const token of tokens) {
    const score = scoreToken(fields, token);

    if (score === 0) {
      return 0;
    }

    total += score;
  }

  return total;
}

function scoreToken(
  fields: { service: string; category: string; email: string; aliases: string[] },
  token: string
): number {
  const serviceWords = words(fields.service);

  if (fields.service === token) return 100;
  if (fields.aliases.includes(token)) return 90;
  if (fields.service.startsWith(token)) return 80;
  if (serviceWords.some((word) => word.startsWith(token))) return 70;
  if (fields.service.includes(token)) return 60;
  if (fields.category === token) return 55;
  if (fields.category.includes(token) || fields.aliases.some((alias) => alias.includes(token))) return 45;
  if (fields.email.includes(token)) return 40;

  if (token.length >= 4) {
    if ([fields.service, ...serviceWords, ...fields.aliases].some((candidate) => closeEnough(candidate, token))) {
      return 35;
    }

    if ([fields.category, ...words(fields.email)].some((candidate) => closeEnough(candidate, token))) {
      return 25;
    }
  }

  return 0;
}

function words(value: string): string[] {
  return value.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function closeEnough(candidate: string, token: string): boolean {
  const allowed = token.length >= 8 ? 2 : 1;

  if (Math.abs(candidate.length - token.length) > allowed) {
    // A typo while typing only the start of a longer word ("ntefl" for "netflix").
    return candidate.length > token.length && editDistance(candidate.slice(0, token.length), token) <= 1;
  }

  return editDistance(candidate, token) <= allowed;
}

/** Optimal string alignment distance (Levenshtein + adjacent transpositions). */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => {
    const row = new Array<number>(cols).fill(0);
    row[0] = i;
    return row;
  });

  for (let j = 0; j < cols; j++) {
    d[0][j] = j;
  }

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }

  return d[rows - 1][cols - 1];
}
