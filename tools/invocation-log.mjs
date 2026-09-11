#!/usr/bin/env node
/**
 * A deployable vertical mounts `invocationLog()` FIRST, or it has no tenant-facing logs.
 *
 * Observability is keyed on the deployed unit — a worker script — and one vertical's
 * script serves every tenant that installed it. Script-grain data is therefore safe for
 * staff and for the vertical's builder and unsafe for an installer, whose own numbers are
 * inseparable from everyone else's (`docs/architecture/observability.md` §3). The router
 * stamps the tenant onto the datapoints and log lines IT emits, which is why tenant-keyed
 * *metrics* need nothing from a vertical. Logs are the other half, and the router cannot
 * supply it: a trace does not cross the dispatch hop. Verified against production — a
 * router line's `traceId` reaches `substrat-control-plane` (a service binding) and never
 * the dispatched vertical, and every vertical event is a trace of exactly one event.
 *
 * So each vertical writes the line itself, and this refuses the two ways that goes wrong.
 *
 * ## Why ORDER is the thing being checked, not just presence
 *
 * Hono composes matching handlers in REGISTRATION order and stops at the first that
 * returns a response. Middleware registered after a route therefore never wraps that
 * route — silently, with no error anywhere. A vertical that mounts the log below some of
 * its routes gets lines for part of its surface and silence for the rest, and the silence
 * is indistinguishable from no traffic. That is strictly worse than mounting nothing,
 * because it is a wrong answer wearing the clothes of a right one.
 *
 * ## Why a gate and not a sentence in CLAUDE.md
 *
 * The same reason `lint:vite-proxy` exists. That rule was prose for a year while nine of
 * eleven demo configs violated it and every suite stayed green, because no test reaches
 * `server.ts` (#1388). This rule has the identical shape: no scenario suite drives the
 * mounted app, so a vertical that forgets the middleware is green here and empty in
 * production, where nobody is looking until a tenant asks why their logs are blank.
 *
 * ## Scope
 *
 * A package is in scope when it declares `substrat.slug` (it is a vertical) AND has a
 * `src/worker.ts` (it is deployable). Local-only demos — the ones with a `server.ts`
 * harness and no worker entry — are deliberately out: they run with no router in front,
 * so no request carries an asserted tenant and the middleware would emit nothing anyway.
 * The scaffold template is in scope explicitly, since every future vertical starts there.
 *
 * Text, not an AST — a loud false positive beats a silent pass.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Where verticals live. The template is not a workspace member, so it is named directly. */
const ROOTS = ['demos', 'engines', 'apps'];
const TEMPLATE = 'packages/create-substrat/template';

/** A top-level Hono app, however it is typed. */
const CONSTRUCTS_APP = /^const app = new Hono\b/m;
/** Any registration on that app — `app.use(`, `app.get(`, `app.all(`, `app.on(`, … */
const REGISTRATION = /^app\.(\w+)\s*\(/gm;
/** The mount we require, quote- and spacing-tolerant. */
const MOUNT = /^app\.use\(\s*['"`]\*['"`]\s*,\s*invocationLog\(\)\s*\)/m;

/**
 * The offence in one file, or null when it is fine.
 *
 * Deliberately anchored on the FIRST registration rather than searching for the mount
 * anywhere: "present" is not the property that matters, "present before everything else"
 * is, and a check for mere presence would pass the exact arrangement that breaks.
 */
function offence(source) {
  if (!CONSTRUCTS_APP.test(source)) return null; // not an app file
  REGISTRATION.lastIndex = 0;
  const first = REGISTRATION.exec(source);
  if (!first) return null; // an app with no routes registers nothing to miss
  const line = source.slice(first.index).split('\n')[0].trim();
  if (MOUNT.test(line)) return null;
  return MOUNT.test(source)
    ? `invocationLog() is mounted, but AFTER \`${line}\` — Hono will not wrap the routes above it`
    : `no \`app.use('*', invocationLog())\` — first registration is \`${line}\``;
}

// ── The predicate has to be able to tell its own cases apart, or a green run means
//    nothing. Same guard `lint:vite-proxy` carries, for the same reason.
const SELF_TEST = [
  ["const app = new Hono();\napp.use('*', invocationLog());\napp.get('/x', h);", false],
  ['const app = new Hono<{ Bindings: Env }>();\napp.get("/x", h);', true],
  ["const app = new Hono();\napp.get('/x', h);\napp.use('*', invocationLog());", true],
  ["const app = new Hono();\napp.use('*', invocationLog())\n", false],
  ['const notAnApp = 1;\n', false],
];
const drift = SELF_TEST.filter(([src, shouldFail]) => Boolean(offence(src)) !== shouldFail);
if (drift.length > 0) {
  console.error('invocation-log: the predicate no longer tells its own cases apart:');
  for (const [src] of drift) console.error(`  ${JSON.stringify(src)} -> ${offence(src)}`);
  process.exit(2);
}

/** Every directory that declares a vertical slug and ships a worker entry. */
function verticals() {
  const found = [];
  for (const root of ROOTS) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      const dir = join(root, name);
      const manifest = join(dir, 'package.json');
      if (!existsSync(manifest) || !existsSync(join(dir, 'src', 'worker.ts'))) continue;
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      } catch {
        continue;
      }
      if (pkg.substrat?.slug) found.push(dir);
    }
  }
  if (existsSync(join(TEMPLATE, 'src', 'worker.ts'))) found.push(TEMPLATE);
  return found;
}

/**
 * The app-constructing files reachable from the DEPLOYED entry, found by walking relative
 * imports out from `src/worker.ts`.
 *
 * Not "every file under src/ that constructs an app", which was the first cut and was
 * wrong: most of these packages also ship a `server.ts` local dev harness that builds its
 * own Hono app for `node`. That app runs with no router in front of it, so no request
 * carries an asserted tenant and the middleware would emit nothing — requiring the mount
 * there would be demanding a no-op, and the gate would be training people to add lines
 * that do nothing. The deployed entry is the one the router dispatches to, and reachability
 * from `worker.ts` is exactly that distinction.
 */
function appFiles(dir) {
  const entry = join(dir, 'src', 'worker.ts');
  const seen = new Set();
  const found = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    if (CONSTRUCTS_APP.test(source)) found.push(file);
    // Relative imports only — a constructed app never comes from a published package.
    for (const m of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const rel = m[1].replace(/\.js$/, '.ts');
      queue.push(join(file, '..', rel));
    }
  }
  return found;
}

const dirs = verticals();
if (dirs.length === 0) {
  console.error('invocation-log: found no deployable vertical — the check would pass by scanning nothing.');
  process.exit(2);
}

const offenders = [];
let checked = 0;
for (const dir of dirs) {
  const files = appFiles(dir);
  if (files.length === 0) {
    // A vertical with a worker entry but no constructed app is a shape this gate does not
    // understand. Say so rather than counting it as a pass.
    offenders.push(`${dir}: no file under src/ constructs a top-level Hono app`);
    continue;
  }
  for (const file of files) {
    checked++;
    const why = offence(readFileSync(file, 'utf8'));
    if (why) offenders.push(`${file}: ${why}`);
  }
}

if (offenders.length > 0) {
  console.error("invocation-log: a vertical's tenant-facing logs would be partly or wholly empty.");
  console.error("  Mount it directly after the app is constructed, before any route:");
  console.error("    app.use('*', invocationLog());   // from '@substrat-run/kernel'");
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log(`invocation-log: ok (${checked} app file(s) across ${dirs.length} deployable vertical(s))`);
