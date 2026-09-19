/**
 * Parse wrangler's JSONC dialect, with no dependency.
 *
 * Shared because two deploy preflights read the same config file and a second copy of
 * this would be a second chance to get the string handling wrong. A naive `//` strip
 * corrupts every URL in a wrangler config — `"https://example.com"` becomes `"https:` —
 * so this tracks whether it is inside a string literal, and an escape inside one.
 *
 * Not a general JSONC parser, and deliberately not marked as one: it handles the two
 * things wrangler configs actually carry beyond JSON — comments and trailing commas.
 *
 * Trailing commas are dropped by the same scan, so a `,` before `}` or `]` inside a string
 * value (`"x,}"`) is never touched. A regex over the finished text cannot tell the two apart.
 * Anything else malformed is left for `JSON.parse` to refuse.
 */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  // Where in `out` the last comma sits while only whitespace has followed it, else -1. A
  // comma right after `[`, `{` or another comma is not a trailing one: it is malformed, and
  // stays so.
  let pendingComma = -1;
  let prev = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') { out += next ?? ''; i++; }
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    if (/\s/.test(c)) { out += c; continue; }
    if ((c === '}' || c === ']') && pendingComma !== -1) {
      out = out.slice(0, pendingComma) + out.slice(pendingComma + 1);
    }
    pendingComma = c === ',' && prev !== '' && !'[{,'.includes(prev) ? out.length : -1;
    prev = c;
    if (c === '"') inString = true;
    out += c;
  }
  return JSON.parse(out);
}
