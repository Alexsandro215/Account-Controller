import { randomInt } from "node:crypto";

// Ambiguous characters (l, I, O, 0, 1) are left out so generated passwords can be typed
// by hand from the phone without mistakes.
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*-_=+?";

export const MIN_GENERATED_LENGTH = 8;
export const MAX_GENERATED_LENGTH = 128;

export type GeneratorOptions = {
  length?: number;
  symbols?: boolean;
};

export function generatePassword(options: GeneratorOptions = {}): string {
  const length = Math.min(
    MAX_GENERATED_LENGTH,
    Math.max(MIN_GENERATED_LENGTH, Math.floor(options.length ?? 20))
  );
  const sets = options.symbols === false ? [LOWER, UPPER, DIGITS] : [LOWER, UPPER, DIGITS, SYMBOLS];
  const all = sets.join("");

  // One character from each set guarantees site rules like "must contain a digit".
  const chars = sets.map(pick);

  while (chars.length < length) {
    chars.push(pick(all));
  }

  // Fisher-Yates with a CSPRNG so the guaranteed characters are not always first.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join("");
}

function pick(set: string): string {
  return set[randomInt(set.length)];
}

// ---------------------------------------------------------------------------------------
// Strength estimate (rough, offline). Good enough to flag "123456" and "Netflix2020".
// ---------------------------------------------------------------------------------------

export type Strength = {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  bits: number;
};

const COMMON = new Set([
  "123456", "123456789", "12345678", "1234567", "12345", "1234567890", "111111", "000000",
  "password", "password1", "contrasena", "contraseña", "qwerty", "qwerty123", "abc123",
  "iloveyou", "teamo", "admin", "welcome", "letmein", "monkey", "dragon", "football",
  "futbol", "america", "mexico", "princesa", "superman", "batman", "123123", "654321",
  "666666", "121212", "asdfgh", "zxcvbn", "passw0rd", "1q2w3e4r", "qwertyuiop"
]);

const LABELS = ["Muy débil", "Débil", "Aceptable", "Fuerte", "Muy fuerte"] as const;

export function passwordStrength(password: string): Strength {
  const lowered = password.toLowerCase();

  if (password.length === 0 || COMMON.has(lowered) || COMMON.has(lowered.replace(/[\d!.]+$/, ""))) {
    return { score: 0, label: LABELS[0], bits: 0 };
  }

  // A single word plus a number or symbol ("Netflix2020", "mariposa!") is the classic
  // human password: estimate it as a dictionary word, not as random characters.
  const wordLike = /^([A-Za-zÀ-ÿ]{1,12})([\d!@#$%.*_-]{0,6})$/.exec(password);

  if (wordLike && /^[A-ZÀ-Ý]?[a-zà-ÿ]+$|^[A-ZÀ-Ý]+$/.test(wordLike[1])) {
    const bits = Math.round(16 + 1 + wordLike[2].length * 3.3);
    return scored(bits);
  }

  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/\d/.test(password)) pool += 10;
  if (/[^A-Za-z0-9]/.test(password)) pool += 33;

  // Repeats and runs ("aaaa", "1234", "abcd") add almost nothing.
  const effectiveLength = [...password].reduce((count, char, index, chars) => {
    if (index === 0) return 1;
    const previous = chars[index - 1];
    const repeat = char === previous;
    const run = Math.abs(char.charCodeAt(0) - previous.charCodeAt(0)) === 1;
    return count + (repeat || run ? 0.25 : 1);
  }, 0);

  // A year or a trailing number is the most predictable "complexity" there is.
  const predictableSuffix = /(19|20)\d{2}$|\d{1,3}$/.test(password) && /[A-Za-z]/.test(password) ? 6 : 0;
  const bits = Math.max(0, Math.round(effectiveLength * Math.log2(Math.max(pool, 1)) - predictableSuffix));
  return scored(bits);
}

function scored(bits: number): Strength {
  const score = bits < 28 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
  return { score, label: LABELS[score], bits };
}
