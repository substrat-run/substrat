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
 */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
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
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  // Trailing commas are legal in wrangler.jsonc and not in JSON.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
