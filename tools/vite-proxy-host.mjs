#!/usr/bin/env node
/**
 * A demo's Vite proxy passes Host through, and says so out loud.
 *
 * Every demo signs in through a real OIDC round-trip, and `packages/oidc-rp` builds the
 * `redirect_uri` from `new URL(c.req.url).origin` — the Host the API was handed — unless
 * `BASE_URL` overrides it, which no demo sets. So the browser's origin has to survive the
 * dev proxy, or the callback comes back on the API's port and the round-trip ends on a 404.
 *
 * The trap is that the rule reads as "leave `changeOrigin` alone", and leaving it alone is
 * the one thing that breaks it. Vite's string shorthand is not a bare target:
 *
 *   proxy: { '/api': 'http://localhost:8871' }   // → { target, changeOrigin: TRUE }
 *
 * (`vite/dist/node/chunks/…`: `opts = { target: opts, changeOrigin: true }`, in 5 and 6
 * alike). Writing nothing and writing `false` are opposites here. Nine of eleven demo
 * configs carried the shorthand when this check was written, two of the correct ones had
 * been fixed by hand without the rule being updated, and no suite could see any of it —
 * the scenario suites drive the module directly and never reach `server.ts`, so a demo
 * whose sign-in is dead is green (#1388).
 *
 * So: inside a `demos/*` Vite config, every proxy entry is the OBJECT form carrying
 * `changeOrigin: false`. A whole file opts out with `vite-proxy-allow: <reason>` in a
 * comment — `demos/auth-server` does, because the issuer takes its origin from `PORT`
 * rather than from Host and has nothing to lose.
 *
 * Demos only, deliberately. `apps/*` mount the same OIDC routes but reach the browser
 * through the router in production and are not the surface this issue was about; two of
 * them set `changeOrigin: true` today, which is worth a look and is not this gate's call
 * to make.
 *
 * Text, not an AST: comments are stripped and `${…}` collapsed before the braces are
 * matched, and a loud false positive beats a silent pass.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'demos';
const CONFIG = /^vite\.config\.(?:ts|mts|js|mjs)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.wrangler']);
/** A whole-file opt-out, and it has to give a reason. */
const ALLOW = /vite-proxy-allow:\s*\S/;

/**
 * Comments gone, `${…}` collapsed — so a brace count means what it looks like.
 *
 * String-aware on purpose: a naive `//`-to-end-of-line strip eats `http://localhost/…`
 * and takes the rest of the config with it, which is exactly the false NEGATIVE this
 * check exists to avoid. The self-check below catches it if this is ever simplified back.
 */
const flatten = (src) => {
  let out = '';
  let quote = null;
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const next = src[i + 1];
    if (quote !== null) {
      if (c === '\\') {
        out += c + (next ?? '');
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    out += c;
    i++;
  }
  return out.replace(/\$\{[^}]*\}/g, 'X');
};

/** The text between the braces of the first `{` at or after `from`, or null. */
const braced = (src, from) => {
  const start = src.indexOf('{', from);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return { body: src.slice(start + 1, i), end: i };
  }
  return null;
};

/**
 * Every proxy entry whose Host would be rewritten, as `path: why`. An entry is judged on
 * its VALUE: the object form must carry `changeOrigin: false`, and anything else — the
 * string shorthand, a variable, a spread — is refused, because only the object form can
 * carry the flag at all.
 */
const rewritesHost = (source) => {
  const src = flatten(source);
  const at = src.search(/\bproxy\s*:/);
  if (at === -1) {
    // No `proxy:` at all is the honest answer for a config that has no proxy. `{ proxy }`
    // — the shorthand property, pointing at an object built elsewhere — is not: this check
    // cannot follow it, and passing something it did not read is the failure mode it
    // exists to avoid. So it says so instead.
    return /\bproxy\b/.test(src) ? ['proxy: named but not written here — this check cannot read it'] : [];
  }
  const region = braced(src, at);
  if (region === null) return [];

  const offenders = [];
  const key = /(['"`])(\/[^'"`]*)\1\s*:/g;
  let m;
  while ((m = key.exec(region.body)) !== null) {
    const rest = region.body.slice(m.index + m[0].length);
    if (!/^\s*\{/.test(rest)) {
      offenders.push(`${m[2]}: the string shorthand — Vite expands it to changeOrigin: true`);
      continue;
    }
    const entry = braced(rest, 0);
    if (entry === null || !/\bchangeOrigin\s*:\s*false\b/.test(entry.body)) {
      offenders.push(`${m[2]}: the object form without changeOrigin: false`);
    }
    // Entries do not nest, so resuming after this one's brace keeps a nested
    // `rewrite: (p) => …` from being read as another key.
    key.lastIndex = m.index + m[0].length + (entry?.end ?? 0) + 1;
  }
  return offenders;
};

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (CONFIG.test(e)) out.push(p);
  }
  return out;
};

/**
 * The predicate, judged against every shape it exists to tell apart, on every run and
 * before the tree is read — the same reason `lint:bound-fetch` carries one. A text rule
 * drifts silently when a regex is tidied, and a check that has stopped checking is green.
 */
const SELF_CHECK = [
  ["server: { proxy: { '/api': `http://localhost:${P}` } }", 1],
  ["server: { proxy: { '/api': 'http://localhost:8871' } }", 1],
  ["server: { proxy: { '/api': { target: `http://x:${P}` } } }", 1],
  ["server: { proxy: { '/api': { target: T, changeOrigin: true } } }", 1],
  ["server: { proxy: { '/api': API, '/.well-known': API } }", 2],
  ["server: { proxy: { '/api': { target: T, changeOrigin: false } } }", 0],
  ["server: { proxy: {\n  // changeOrigin: true would break sign-in\n  '/api': { target: T,\n    changeOrigin: false } } }", 0],
  ["server: { proxy: { '/api': { target: T, rewrite: (p) => p.replace(/^\\/api/, ''), changeOrigin: false } } }", 0],
  ["server: { proxy: { '/api': { target: `http://x:${P}`, changeOrigin: false }, '/.well-known': { target: T, changeOrigin: false } } }", 0],
  ['server: { port: 5271 }', 0],
  ['const proxy = mkProxy(P);\nexport default defineConfig({ server: { port: 5271, proxy } });', 1],
];
const drift = SELF_CHECK.filter(([src, want]) => rewritesHost(src).length !== want);
if (drift.length > 0) {
  console.error('vite-proxy: the rule no longer tells its own cases apart — fix the predicate before trusting a run:');
  for (const [src, want] of drift) {
    console.error(`  expected ${want} offender(s), got ${rewritesHost(src).length}: ${src.replace(/\n/g, ' ')}`);
  }
  process.exit(2);
}

const configs = walk(ROOT);
if (configs.length === 0) {
  console.error(`vite-proxy: no vite config found under ${ROOT}/ — the check would pass by scanning nothing.`);
  process.exit(2);
}

let checked = 0;
const offenders = [];
for (const file of configs) {
  const source = readFileSync(file, 'utf8');
  if (ALLOW.test(source)) continue;
  checked++;
  for (const why of rewritesHost(source)) offenders.push(`${file}: ${why}`);
}

if (offenders.length > 0) {
  console.error('vite-proxy: a demo proxy would rewrite Host, which sends the OIDC callback to the API port (#1388).');
  console.error("  Write the object form out: '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: false }");
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log(`vite-proxy: ok (${checked} of ${configs.length} demo configs checked, ${configs.length - checked} opted out)`);
