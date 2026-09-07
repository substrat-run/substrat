#!/usr/bin/env node
/**
 * The global `fetch` is handed on BOUND, never bare.
 *
 * workerd checks the receiver: `const o = { fetch: globalThis.fetch }; o.fetch(url)`
 * throws `TypeError: Illegal invocation` before a byte leaves the runtime. Node's
 * fetch accepts any `this`, and so does the wrapper `@cloudflare/vitest-pool-workers`
 * installs — so NO suite in this repo can reproduce the refusal; only a real worker
 * can. A connector is free to call the fetch it was handed as a method (`input.fetch(…)`,
 * `options.fetch(…)`), which is how the dashboard's Fortnox consent callback shipped
 * green and failed every hosted round: the code exchange never left the worker, the
 * page said "the exchange with Fortnox failed", and the log named the line but not
 * the error (#1263).
 *
 * So this is a source check, the only kind that can hold the rule. A reference to
 * `globalThis.fetch` that is not a type (`typeof globalThis.fetch`), not a direct call
 * (`globalThis.fetch(…)`), and not bound (`globalThis.fetch.bind(globalThis)`) is a
 * handoff of the bare global, and is refused. Text, not an AST: comment lines are
 * skipped, and anything else that mentions the global in prose should say
 * `globalThis.fetch.bind` or rephrase — a loud false positive over a silent pass.
 *
 * Tests and browser bundles are exempt: a test runs in Node or under the wrapper, and
 * a browser's `window.fetch` accepts `window`-or-undefined the same way Node does.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['packages', 'engines', 'connectors', 'demos', 'apps'];
const SOURCE = /\.(?:ts|mts|tsx|js|mjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', 'tests', '__tests__', 'app', 'web', '.wrangler']);
const UNBOUND = /(?<!typeof\s)globalThis\.fetch(?!\.bind\(|\()/;
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*)/;

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SOURCE.test(e) && !/\.test\.\w+$/.test(e)) out.push(p);
  }
  return out;
};

const offenders = [];
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (COMMENT_LINE.test(line)) return;
      if (UNBOUND.test(line)) offenders.push(`${relative(process.cwd(), file)}:${i + 1}: ${line.trim()}`);
    });
  }
}

if (offenders.length > 0) {
  console.error('bound-fetch: the bare global `fetch` is handed on — bind it (`globalThis.fetch.bind(globalThis)`):');
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log('bound-fetch: ok');
