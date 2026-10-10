/**
 * Numeric faithfulness: every number the assistant writes must be traceable to a tool result
 * or to the category description. Anything else is flagged to the reader.
 */
// A number, optionally with $, thousands commas, decimals and %. Digits glued to letters are
// names, not results ("24-pack", "llama-3.3-70b", "6oz"), so they are skipped.
const NUMBER = /(?<![A-Za-z\d.,]|[A-Za-z]-)-?\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?(?![A-Za-z\d]|-[A-Za-z\d])/g;

function parse(token: string): number {
  return Math.abs(Number(token.replace(/[$,%]/g, "")));
}

/** All numbers appearing anywhere in a JSON-like value or text. */
export function numbersIn(source: unknown): number[] {
  const text = typeof source === "string" ? source : JSON.stringify(source);
  return (text.match(NUMBER) ?? []).map(parse).filter((n) => Number.isFinite(n));
}

function close(a: number, b: number): boolean {
  // the model may round what the tool gave it: allow half a unit in the last shown digit, or 1%
  return Math.abs(a - b) <= Math.max(0.5, 0.01 * Math.abs(b));
}

export interface Verification { checked: number; unsupported: string[] }

export function verifyNumbers(answer: string, sources: unknown[]): Verification {
  const known = sources.flatMap(numbersIn);
  const tokens = answer.match(NUMBER) ?? [];
  const unsupported: string[] = [];
  let checked = 0;
  for (const token of tokens) {
    const value = parse(token);
    // small bare counts ("2 items", "one week") are wording, not results
    if (!/[$%.,]/.test(token) && value <= 12) continue;
    checked++;
    if (!known.some((k) => close(value, k))) unsupported.push(token);
  }
  return { checked, unsupported };
}
