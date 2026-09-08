#!/usr/bin/env node
/**
 * The runtime's `fetch` is never handed on bare.
 *
 * workerd checks the receiver: `const o = { fetch: globalThis.fetch }; o.fetch(url)`
 * throws `TypeError: Illegal invocation` before a byte leaves the runtime. Node's
 * fetch accepts any `this`, and so does the wrapper `@cloudflare/vitest-pool-workers`
 * installs — so NO suite in this repo can reproduce the refusal; only a real worker
 * can. A connector is free to call the fetch it was handed as a method (`input.fetch(…)`,
 * `options.fetch(…)`), which is how the dashboard's Fortnox consent callback shipped
 * green and failed every hosted round: the code exchange never left the worker, the
 * page said "the exchange with Fortnox failed", and the log named the line but not
 * the error (#1291).
 *
 * The sanctioned spelling is `globalFetch` from `@substrat-run/kernel` — an arrow that
 * closes over the global, so the receiver is never in play and the structural cast to
 * `FetchLike` lives in one place. This check holds the rule for everything else: on a
 * line that reaches `fetch` through `globalThis` — plainly (`globalThis.fetch`) or
 * through a cast (`(globalThis as unknown as { fetch: FetchLike }).fetch`) — every such
 * `.fetch` must be CALLED right there, BOUND (`.bind(globalThis)`), or a `typeof`. A
 * `.fetch` followed by anything else is a value handed on, and is refused.
 *
 * Text, not an AST: comment lines are skipped, and a loud false positive beats a
 * silent pass. Tests and browser bundles are exempt — a test runs in Node or under the
 * wrapper, and a browser's `window.fetch` accepts `window`-or-undefined as Node does.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['packages', 'engines', 'connectors', 'demos', 'apps'];
const SOURCE = /\.(?:ts|mts|tsx|js|mjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', 'tests', '__tests__', 'app', 'web', '.wrangler']);
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*)/;
/**
 * Every `fetch` reached from `globalThis` — `globalThis.fetch` or the cast form
 * `{ fetch: FetchLike }).fetch` — with what follows it. Anchored on the receiver so an
 * unrelated `options.fetch` on the same line is not judged.
 */
const FETCH_MEMBER = /(?:globalThis|\}\))\.fetch\b(?<after>\.bind\(globalThis\)|\()?/g;
const TYPEOF = /typeof\s+globalThis\.fetch\b/g;

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SOURCE.test(e) && !/\.(?:test|generated)\.\w+$/.test(e)) out.push(p);
  }
  return out;
};

/** True when the line hands the runtime's fetch on as a value. */
const handsFetchOn = (line) => {
  if (!line.includes('globalThis') || COMMENT_LINE.test(line)) return false;
  const stripped = line.replace(TYPEOF, '');
  return [...stripped.matchAll(FETCH_MEMBER)].some((m) => m.groups.after === undefined);
};

const offenders = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (handsFetchOn(line)) offenders.push(`${relative(process.cwd(), file)}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
  }
}

if (offenders.length > 0) {
  console.error('bound-fetch: the runtime fetch is handed on bare — use `globalFetch` from @substrat-run/kernel:');
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log('bound-fetch: ok');
