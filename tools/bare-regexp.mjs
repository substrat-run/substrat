/**
 * A bare RegExp as a `toMatchObject` value asserts nothing (#2313).
 *
 * `toMatchObject` is a subset match: it walks the expected object's own keys. A RegExp has
 * no own enumerable keys, so `expect({ detail: 'abc' }).toMatchObject({ detail: /zzz/ })`
 * PASSES — the pattern is never applied to the string. #2300 found 22 assertions in two
 * scope-store suites that held nothing for that reason, and `attachment-text.test.ts` still
 * held two on main. The correct spelling is `expect.stringMatching(/…/)`.
 *
 * Measured on vitest 5 rather than assumed (the forms that look alike differ):
 *
 *   vacuous  toMatchObject({ a: /re/ }) · nested objects · inside arrays · `new RegExp(…)`
 *            · `toMatchObject(/re/)` itself
 *   correct  toEqual / toStrictEqual / toHaveProperty / toHaveBeenCalledWith with a RegExp,
 *            `expect.objectContaining({ a: /re/ })`, `expect.arrayContaining([/re/])`,
 *            and every `expect.*(…)` asymmetric matcher nested inside a `toMatchObject` —
 *            those compare with `equals`, which does apply the pattern.
 *
 * So the rule is narrow on purpose: a RegExp literal, `new RegExp(…)` or `RegExp(…)` whose
 * path to the `toMatchObject(` call crosses only object literals, array literals and
 * grouping parentheses. Any call on the way (`expect.stringMatching(/re/)`,
 * `expect.objectContaining({ a: /re/ })`, `'x'.replace(/a/g, 'b')`) hands the pattern to a
 * function, which is that function's business. A RegExp followed by `.` or `[` is a member
 * access (`/re/.source`), not the pattern itself.
 *
 * This reads tokens, not lines: strings, template literals (with their `${…}`), comments and
 * regex literals are lexed, so a message that mentions `toMatchObject({ a: /x/ })` is not
 * accused. What it cannot see is a pattern reached through a variable
 * (`const expected = { a: /re/ }; …toMatchObject(expected)`); that needs the type checker.
 * Division vs. regex after `)` / `]` / `}` is read as division, so a regex literal that
 * starts a statement right after one of those is not seen — nothing a matcher argument does.
 */

/** Keywords after which a `/` starts a regex rather than dividing. */
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case',
  'do', 'else', 'yield', 'await',
]);

const isIdStart = (c) => /[A-Za-z_$\u0080-￿]/.test(c);
const isIdPart = (c) => /[A-Za-z0-9_$\u0080-￿]/.test(c);

/**
 * @typedef {{ kind: 'word' | 'punct' | 'regex' | 'string' | 'number', text: string, line: number }} Token
 * @param {string} src
 * @returns {Token[]}
 */
export function lex(src) {
  /** @type {Token[]} */
  const out = [];
  let i = 0;
  let line = 1;
  /** Brace stack: 'b' = a `{`, 't' = a `${` that resumes a template on its `}`. */
  const braces = [];
  const push = (kind, text, startLine) => out.push({ kind, text, line: startLine });

  const regexAllowed = () => {
    const prev = out[out.length - 1];
    if (!prev) return true;
    if (prev.kind === 'word') return REGEX_AFTER_WORD.has(prev.text);
    if (prev.kind === 'string' || prev.kind === 'number' || prev.kind === 'regex') return false;
    return !(prev.text === ')' || prev.text === ']' || prev.text === '}');
  };

  /** Scan template text from `i` (just past the opening backtick or a closing `}`). */
  const template = () => {
    const startLine = line;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (c === '\n') line += 1;
      else if (c === '\\') {
        if (src[i + 1] === '\n') line += 1;
        i += 1;
      } else if (c === '`') {
        i += 1;
        push('string', '`', startLine);
        return;
      } else if (c === '$' && src[i + 1] === '{') {
        i += 2;
        braces.push('t');
        push('string', '`', startLine);
        return;
      }
    }
  };

  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const startLine = line;
      i += 1;
      while (i < src.length && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i += 1;
      push('string', c, startLine);
      continue;
    }
    if (c === '`') { i += 1; template(); continue; }
    if (c === '/' && regexAllowed()) {
      const startLine = line;
      const start = i;
      let inClass = false;
      i += 1;
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '\\') i += 1;
        else if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) break;
        i += 1;
      }
      i += 1;
      while (i < src.length && isIdPart(src[i])) i += 1;
      push('regex', src.slice(start, i), startLine);
      continue;
    }
    if (isIdStart(c)) {
      const start = i;
      while (i < src.length && isIdPart(src[i])) i += 1;
      push('word', src.slice(start, i), line);
      continue;
    }
    if (/[0-9]/.test(c)) {
      const start = i;
      while (i < src.length && /[0-9A-Za-z_.]/.test(src[i])) i += 1;
      push('number', src.slice(start, i), line);
      continue;
    }
    if (c === '{') braces.push('b');
    if (c === '}') {
      const top = braces.pop();
      if (top === 't') { i += 1; template(); continue; }
    }
    push('punct', c, line);
    i += 1;
  }
  return out;
}

/**
 * Every bare RegExp inside a `toMatchObject(…)` argument.
 * @param {string} src
 * @returns {{ line: number, text: string }[]}
 */
export function findBareRegExps(src) {
  if (!src.includes('toMatchObject')) return [];
  const t = lex(src);
  const found = [];
  for (let k = 0; k < t.length; k += 1) {
    if (t[k].text !== 'toMatchObject' || t[k].kind !== 'word') continue;
    // `?.(` is two tokens; accept `toMatchObject(` only.
    if (t[k + 1]?.text !== '(') continue;
    /** Each open bracket on the way down: true when it is a call's argument list. */
    const stack = [{ open: '(', call: false }];
    let j = k + 2;
    for (; j < t.length && stack.length > 0; j += 1) {
      const tok = t[j];
      if (tok.kind === 'punct' && (tok.text === '(' || tok.text === '[' || tok.text === '{')) {
        const prev = t[j - 1];
        const call =
          tok.text === '(' &&
          (prev.kind === 'word' ? !REGEX_AFTER_WORD.has(prev.text) : prev.text === ')' || prev.text === ']');
        stack.push({ open: tok.text, call });
        continue;
      }
      if (tok.kind === 'punct' && (tok.text === ')' || tok.text === ']' || tok.text === '}')) {
        stack.pop();
        continue;
      }
      if (stack.some((s) => s.call)) continue;
      const next = t[j + 1];
      const member = next && next.kind === 'punct' && (next.text === '.' || next.text === '[');
      if (tok.kind === 'regex' && !member) {
        found.push({ line: tok.line, text: tok.text });
      } else if (tok.kind === 'word' && tok.text === 'RegExp' && t[j - 1]?.text !== '.') {
        // `new RegExp(…)` / `RegExp(…)`: the value is the constructed pattern. Skip its own
        // argument list, so a literal passed to it is not reported a second time.
        if (next?.text === '(') {
          found.push({ line: tok.line, text: `${t[j - 1]?.text === 'new' ? 'new ' : ''}RegExp(…)` });
          let depth = 0;
          for (j += 1; j < t.length; j += 1) {
            if (t[j].kind !== 'punct') continue;
            if (t[j].text === '(') depth += 1;
            else if (t[j].text === ')' && (depth -= 1) === 0) break;
          }
        }
      }
    }
  }
  return found;
}

/** The remedy, printed once under the list of sites. */
export const REMEDY =
  'A RegExp has no own keys, so toMatchObject never applies it: `{ detail: /zzz/ }` matches\n' +
  "    any value. Write `expect.stringMatching(/zzz/)` (or assert the string with `toMatch`).";
