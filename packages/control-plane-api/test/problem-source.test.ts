import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The source half of #113's witness. The tripwire (`test/setup/problem-tripwire.ts`) fails a
 * test that REACHES a non-problem refusal; a route branch no test reaches would merge green.
 * This reads `src/api.ts` itself and refuses any response it builds whose status is not a 2xx
 * or 3xx literal — every refusal goes through `refuse`/`refuseStatus`/`relayRefusal`/`problem`.
 *
 * A scanner rather than the compiler: it finds each `.json(` / `.text(` / `.body(` call and each
 * `Response.json(` / `new Response(`, splits the arguments at top-level commas (skipping strings,
 * template literals and comments), and judges the status argument.
 */

const API = fileURLToPath(new URL('../src/api.ts', import.meta.url));

/** The one call allowed a computed status: `problem()`'s own serialization. */
const PROBLEM_SERIALIZER = 'answer.status';

interface Call {
  line: number;
  callee: string;
  args: string[];
}

/** Skip a string, template literal or comment starting at `i`; return the index after it, or `i`. */
function skipLiteral(src: string, i: number): number {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') {
    const end = src.indexOf('\n', i);
    return end === -1 ? src.length : end;
  }
  if (c === '/' && src[i + 1] === '*') return src.indexOf('*/', i + 2) + 2;
  if (c === "'" || c === '"') {
    let j = i + 1;
    while (src[j] !== c) j += src[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  if (c === '`') {
    let j = i + 1;
    while (src[j] !== '`') {
      if (src[j] === '\\') j += 2;
      else if (src[j] === '$' && src[j + 1] === '{') j = closeOf(src, j + 1, '{', '}') + 1;
      else j += 1;
    }
    return j + 1;
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
  throw new Error(`unbalanced ${o} at ${open}`);
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
    const ch = src[i];
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

export function responseCalls(src: string): Call[] {
  const calls: Call[] = [];
  const re = /\bnew Response\(|\bResponse\.json\(|\.(?:json|text|body)\(/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const open = m.index + m[0].length - 1;
    // Only code: a match inside a comment or a string is not a call.
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const before = src.slice(lineStart, m.index);
    if (/^\s*(\/\/|\*)/.test(before)) continue;
    calls.push({ line: src.slice(0, m.index).split('\n').length, callee: m[0], args: argsOf(src, open) });
  }
  return calls;
}

/** Is this call's status a refusal answered outside the problem helpers? */
export function offends(call: Call): boolean {
  const isConstructor = call.callee.startsWith('new Response') || call.callee.startsWith('Response.json');
  const status = isConstructor ? /\bstatus:\s*([^,}]+)/.exec(call.args[1] ?? '')?.[1]?.trim() : call.args[1];
  if (status === undefined) return false; // no status: a 200, or a body read (`res.json()`)
  if (status === PROBLEM_SERIALIZER && call.callee === '.body(') return false;
  // A literal, or a ternary of literals, all below 400.
  const literals = status.split(/[?:]/).map((s) => s.trim());
  if (literals.length === 1 || literals.length === 3) {
    const numbers = (literals.length === 3 ? literals.slice(1) : literals).map(Number);
    if (numbers.every((n) => Number.isInteger(n) && n >= 200 && n < 400)) return false;
  }
  return true;
}

describe('control-plane-api source: every response it builds with a failure status is a problem document (#113)', () => {
  it('src/api.ts answers no refusal outside refuse/refuseStatus/relayRefusal/problem', () => {
    const offenders = responseCalls(readFileSync(API, 'utf8'))
      .filter(offends)
      .map((c) => `api.ts:${c.line} ${c.callee}${c.args.join(', ').replace(/\s+/g, ' ').slice(0, 120)})`);
    expect(offenders).toEqual([]);
  });

  it('the scanner refuses the hand-rolled shapes, multi-line and computed included', () => {
    const src = [
      "if (!x) return c.json({ error: 'unknown' }, 404);",
      'return c.json(\n  { error: `a ${b}, c`, detail },\n  502,\n);',
      'return c.json({ error: e.message }, e.status);',
      "return c.text('nope', 403);",
      "return new Response('gone', { status: 410 });",
      "return Response.json({ error: 'x' }, { status: 400 });",
    ].join('\n');
    expect(responseCalls(src).map(offends)).toEqual([true, true, true, true, true, true]);
  });

  it('and passes successes, redirects, body reads and the problem serializer', () => {
    const src = [
      'return c.json(rows);',
      'return c.json(created, 201);',
      'return c.json(out, out.reused ? 200 : 201);',
      'return c.body(null, 204);',
      "return c.json({ moved: true, note: 'a, b' }, 302);",
      'const body = await res.json();',
      "return c.body(JSON.stringify(answer.body), answer.status, { 'content-type': PROBLEM_CONTENT_TYPE });",
      "// return c.json({ error }, 404) in a comment",
    ].join('\n');
    expect(responseCalls(src).filter(offends)).toEqual([]);
  });
});
