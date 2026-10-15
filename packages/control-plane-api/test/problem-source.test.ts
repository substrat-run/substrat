import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The source half of #113's witness. The tripwire (`test/setup/problem-tripwire.ts`) fails a
 * test that REACHES a non-problem refusal; a route branch no test reaches would merge green.
 * This reads `src/api.ts` itself and holds every response it builds to the rule.
 *
 * What it judges, exactly:
 * - `.json(` / `.text(` / `.body(`: the status argument must be a 2xx or 3xx literal (or a
 *   ternary of them), or absent. The one exception is `problem()`'s own serialization.
 * - `new Response(` / `Response.json(`: an init, when given, must be an inline object whose
 *   `status:` is such a literal. An init held in a variable, or a `{ status }` shorthand, is
 *   refused — the scanner cannot see what it holds.
 * - Refused outright, wherever they appear, because each sets a status this scanner could not
 *   judge and `api.ts` has no use for any of them: `.status(` (Hono's `c.status(404)` before a
 *   `c.json(body)`), `.newResponse(`, `.html(`, and a generic `.json<T>(`/`.text<T>(`/`.body<T>(`.
 *
 * A scanner rather than the compiler, because the workspace's `typescript` is the native 7.x
 * compiler, which exposes no JS API to walk. It skips strings, template literals, comments and
 * regex literals, and every loop is bounded by the source's length: an unterminated literal is
 * a thrown error naming its line, never a hang.
 */

const API = fileURLToPath(new URL('../src/api.ts', import.meta.url));

/** The one call allowed a computed status: `problem()`'s own serialization. */
const PROBLEM_SERIALIZER = 'answer.status';

interface Call {
  line: number;
  callee: string;
  args: string[];
}

const lineOf = (src: string, i: number): number => src.slice(0, i).split('\n').length;

function unterminated(src: string, start: number, what: string): never {
  throw new Error(`unterminated ${what} at line ${lineOf(src, start)}`);
}

/**
 * Could a `/` at `i` start a regex literal? Only where an expression may begin: after an
 * operator, an opening bracket, a comma, a keyword-free start. After an identifier, a number or
 * a closing bracket it is division.
 */
function regexMayStart(src: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j]!)) j -= 1;
  if (j < 0) return true;
  if ('(,=:[!&|?{};+-*%<>~^'.includes(src[j]!)) return true;
  const word = /([A-Za-z_$][\w$]*)$/.exec(src.slice(Math.max(0, j - 10), j + 1))?.[1];
  return word === 'return' || word === 'typeof' || word === 'case' || word === 'in' || word === 'of';
}

/** Skip a string, template literal, comment or regex literal starting at `i`; return the index after it, or `i`. */
function skipLiteral(src: string, i: number): number {
  const c = src[i];
  const n = src.length;
  if (c === '/' && src[i + 1] === '/') {
    const end = src.indexOf('\n', i);
    return end === -1 ? n : end;
  }
  if (c === '/' && src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    if (end === -1) unterminated(src, i, 'comment');
    return end + 2;
  }
  if (c === "'" || c === '"') {
    let j = i + 1;
    while (j < n && src[j] !== c) {
      if (src[j] === '\n') unterminated(src, i, 'string');
      j += src[j] === '\\' ? 2 : 1;
    }
    if (j >= n) unterminated(src, i, 'string');
    return j + 1;
  }
  if (c === '`') {
    let j = i + 1;
    while (j < n && src[j] !== '`') {
      if (src[j] === '\\') j += 2;
      else if (src[j] === '$' && src[j + 1] === '{') j = closeOf(src, j + 1, '{', '}') + 1;
      else j += 1;
    }
    if (j >= n) unterminated(src, i, 'template literal');
    return j + 1;
  }
  if (c === '/' && regexMayStart(src, i)) {
    let j = i + 1;
    let inClass = false;
    while (j < n && (inClass || src[j] !== '/')) {
      if (src[j] === '\n') unterminated(src, i, 'regex literal');
      if (src[j] === '\\') j += 1;
      else if (src[j] === '[') inClass = true;
      else if (src[j] === ']') inClass = false;
      j += 1;
    }
    if (j >= n) unterminated(src, i, 'regex literal');
    j += 1;
    while (j < n && /[a-z]/.test(src[j]!)) j += 1; // flags
    return j;
  }
  return i;
}

/** The index of the bracket closing the one at `open`. */
function closeOf(src: string, open: number, o: string, c: string): number {
  let depth = 0;
  for (let i = open; i < src.length; ) {
    const skipped = skipLiteral(src, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (src[i] === o) depth += 1;
    else if (src[i] === c && --depth === 0) return i;
    i += 1;
  }
  return unterminated(src, open, `'${o}'`);
}

/** The top-level arguments of the call whose `(` is at `open`. */
function argsOf(src: string, open: number): string[] {
  const close = closeOf(src, open, '(', ')');
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; ) {
    const skipped = skipLiteral(src, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = src[i]!;
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) {
      args.push(src.slice(start, i).trim());
      start = i + 1;
    }
    i += 1;
  }
  const last = src.slice(start, close).trim();
  if (last !== '') args.push(last);
  return args;
}

const CALL = /\bnew Response\(|\bResponse\.json\(|\.(?:json|text|body)(?:<[^()]*>)?\(|\.(?:status|newResponse|html)\(/g;

/** Every response-building call in `src`, found in code only (never in a string or a comment). */
export function responseCalls(src: string): Call[] {
  const calls: Call[] = [];
  for (let i = 0; i < src.length; ) {
    const skipped = skipLiteral(src, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    CALL.lastIndex = i;
    const m = CALL.exec(src);
    if (m === null) break;
    // Code between here and the match may hold a literal that hides the match: walk to it.
    let k = i;
    while (k < m.index) {
      const s = skipLiteral(src, k);
      if (s !== k) {
        if (s > m.index) break;
        k = s;
      } else k += 1;
    }
    if (k !== m.index) {
      i = Math.max(k, i + 1);
      continue;
    }
    const open = m.index + m[0].length - 1;
    calls.push({ line: lineOf(src, m.index), callee: m[0], args: argsOf(src, open) });
    i = open + 1;
  }
  return calls;
}

const OK_STATUS = (literal: string): boolean => {
  const n = Number(literal.trim());
  return Number.isInteger(n) && n >= 200 && n < 400;
};

/** A status expression this scanner accepts: a 2xx/3xx literal, or a ternary of two. */
function acceptedStatus(status: string): boolean {
  const ternary = /^[^?]+\?([^:]+):(.+)$/.exec(status);
  return ternary ? OK_STATUS(ternary[1]!) && OK_STATUS(ternary[2]!) : OK_STATUS(status);
}

/** Why this call breaks the rule, or `null` when it keeps it. */
export function offence(call: Call): string | null {
  const { callee, args } = call;
  if (/^\.(status|newResponse|html)\($/.test(callee)) return 'a status this scanner cannot judge — answer through the problem helpers';
  if (/</.test(callee)) return 'a generic-typed response call — drop the type argument so its status can be judged';
  if (callee.startsWith('new Response') || callee.startsWith('Response.json')) {
    const init = args[1];
    if (init === undefined) return null;
    const literal = /^\{[\s\S]*\bstatus:\s*([^,}\s]+)[\s\S]*\}$/.exec(init)?.[1];
    if (literal === undefined) return 'a Response init the scanner cannot read — write `{ status: <literal> }` inline';
    return OK_STATUS(literal) ? null : `status ${literal} outside the problem helpers`;
  }
  const status = args[1];
  if (status === undefined) return null; // a 200, or a body read (`res.json()`)
  if (status === PROBLEM_SERIALIZER && callee === '.body(') return null;
  return acceptedStatus(status) ? null : `status ${status.replace(/\s+/g, ' ')} outside the problem helpers`;
}

const judge = (src: string): Array<string | null> => responseCalls(src).map(offence);

describe('control-plane-api source: every response it builds with a failure status is a problem document (#113)', () => {
  it('src/api.ts answers no refusal outside refuse/refuseStatus/relayRefusal/problem', () => {
    const offenders = responseCalls(readFileSync(API, 'utf8'))
      .map((c) => ({ c, why: offence(c) }))
      .filter(({ why }) => why !== null)
      .map(({ c, why }) => `api.ts:${c.line} ${c.callee}… — ${why}`);
    expect(offenders).toEqual([]);
  });

  it('refuses the hand-rolled shapes, multi-line and computed included', () => {
    const bad = [
      "if (!x) return c.json({ error: 'unknown' }, 404);",
      'return c.json(\n  { error: `a ${b}, c`, detail },\n  502,\n);',
      'return c.json({ error: e.message }, e.status);',
      "return c.text('nope', 403);",
      "return new Response('gone', { status: 410 });",
      "return Response.json({ error: 'x' }, { status: 400 });",
    ];
    for (const src of bad) expect(judge(src), src).toEqual([expect.any(String)]);
  });

  it('refuses each construct that sets a status it cannot judge, one by one', () => {
    const bad = {
      'c.status then c.json': "c.status(404);\nreturn c.json({ error: 'x' });",
      'Response init shorthand': "return new Response('x', { status });",
      'Response init in a variable': "const init = { status: 404 };\nreturn new Response('x', init);",
      'Response.json init in a variable': "return Response.json({ error: 'x' }, init);",
      'c.newResponse': "return c.newResponse('x', 404);",
      'c.html': "return c.html('<p>no</p>', 403);",
      'generic c.json': "return c.json<{ error: string }>({ error: 'x' }, 404);",
    };
    for (const [name, src] of Object.entries(bad)) {
      expect(judge(src).some((why) => why !== null), name).toBe(true);
    }
  });

  it('passes successes, redirects, body reads, the problem serializer and anything in a literal', () => {
    const good = [
      'return c.json(rows);',
      'return c.json(created, 201);',
      'return c.json(out, out.reused ? 200 : 201);',
      'return c.body(null, 204);',
      "return c.json({ moved: true, note: 'a, b' }, 302);",
      'const body = await res.json();',
      "return new Response(stream, { status: 200, headers: { 'x-a': 'b' } });",
      "return c.body(JSON.stringify(answer.body), answer.status, { 'content-type': PROBLEM_CONTENT_TYPE });",
      '// return c.json({ error }, 404) in a comment',
      "const doc = 'return c.json({ error }, 404)';",
      'const t = `c.status(404) ${x}`;',
    ].join('\n');
    expect(judge(good).filter((why) => why !== null)).toEqual([]);
  });

  it('reads past a regex literal holding a quote, inside a response call and out', () => {
    const src = [
      "const quote = /'/g;",
      "return c.json({ cleaned: name.replace(/'/g, '') }, 200);",
      "return c.json({ error: name.replace(/[\"'/]/g, '') }, 404);",
    ].join('\n');
    expect(judge(src)).toEqual([null, expect.stringContaining('404')]);
  });

  it('throws on an unterminated literal rather than looping', () => {
    expect(() => responseCalls("return c.json({ error: 'never closed }, 404);")).toThrow(/unterminated string at line 1/);
    expect(() => responseCalls('return c.json({ error: `never closed }, 404);')).toThrow(/unterminated template literal/);
    expect(() => responseCalls('return c.json({ a: /never closed }, 404);')).toThrow(/unterminated regex literal/);
    expect(() => responseCalls('return c.json({ a: 1 }, 404;')).toThrow(/unterminated '\('/);
  });
});
