// Telegram rejects messages longer than 4096 UTF-16 units. HTML tags count toward the
// raw length here but not on Telegram's side, so splitting at 4000 is conservative.
const DEFAULT_CHUNK_LIMIT = 4000;

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Splits a message into chunks that fit in a Telegram message, cutting at line breaks
 * so HTML tags opened on a line stay closed inside the same chunk.
 */
export function splitMessage(text: string, limit = DEFAULT_CHUNK_LIMIT): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let current = "";

  for (const line of text.split("\n")) {
    const pieces = line.length > limit ? hardSplit(line, limit) : [line];

    for (const piece of pieces) {
      const candidate = current === "" ? piece : `${current}\n${piece}`;

      if (candidate.length > limit) {
        chunks.push(current);
        current = piece;
      } else {
        current = candidate;
      }
    }
  }

  if (current !== "") {
    chunks.push(current);
  }

  return chunks;
}

function hardSplit(line: string, limit: number): string[] {
  // Array.from keeps surrogate pairs (emoji) intact.
  const codePoints = Array.from(line);
  const pieces: string[] = [];
  let piece = "";

  for (const codePoint of codePoints) {
    if (piece.length + codePoint.length > limit) {
      pieces.push(piece);
      piece = "";
    }

    piece += codePoint;
  }

  if (piece !== "") {
    pieces.push(piece);
  }

  return pieces;
}
