#!/usr/bin/env node
/**
 * Refuse to deploy while D1 migrations are pending.
 *
 * `wrangler deploy` ships code and does not touch D1, so a migration that was
 * written but never applied breaks production on the next deploy — and it breaks it
 * *opaquely*. The staff roster (#42) moved platform access into a `staff_actor`
 * table; the migration was never applied to the remote database, so every
 * authenticated control-plane request threw and returned 500. Sign-in still worked,
 * because Better Auth's own tables were there. Nothing in that failure mentioned
 * migrations, and it cost an afternoon.
 *
 * This does NOT apply anything. Migrations are a human checkpoint (CLAUDE.md §"Two
 * human checkpoints"), and a deploy step that silently mutates schema is exactly the
 * thing that checkpoint exists to prevent. It turns a silent 500 into a loud message
 * at deploy time, and leaves the decision where it belongs.
 *
 * Usage:  node tools/preflight-migrations.mjs [packageDir] [--env <name>]
 *
 * With `--env test`, the check reads the D1 bindings from that wrangler
 * environment (`env.test.d1_databases`) instead of the top-level ones, so a
 * `--env test` deploy is gated on the TEST database's migration state, not prod's.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const envIdx = argv.indexOf('--env');
const envName = envIdx !== -1 ? argv[envIdx + 1] : undefined;
const positional = argv.filter((a, i) => a !== '--env' && i !== envIdx + 1);
const pkgDir = resolve(positional[0] ?? process.cwd());

/**
 * Strip JSONC comments without destroying strings.
 *
 * A naive `//` strip corrupts every URL in the config — `"https://example.com"`
 * becomes `"https:` — so this tracks whether it is inside a string literal.
 */
function parseJsonc(text) {
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

const configPath = ['wrangler.jsonc', 'wrangler.json'].map((f) => join(pkgDir, f)).find(existsSync);
if (!configPath) {
  console.log('preflight-migrations: no wrangler config here — nothing to check.');
  process.exit(0);
}

const config = parseJsonc(readFileSync(configPath, 'utf8'));
// A named environment redefines bindings (wrangler does not inherit d1_databases
// into `env.<name>`), so gate on that environment's databases when one is given.
const scope = envName ? (config.env?.[envName] ?? {}) : config;
if (envName && !config.env?.[envName]) {
  console.log(`preflight-migrations: no [env.${envName}] in ${configPath} — nothing to check.`);
  process.exit(0);
}
const databases = scope.d1_databases ?? [];
if (databases.length === 0) {
  console.log('preflight-migrations: no D1 databases bound — nothing to check.');
  process.exit(0);
}

const pending = [];

for (const db of databases) {
  const name = db.database_name ?? db.binding;
  const dir = join(pkgDir, db.migrations_dir ?? 'migrations');
  if (!existsSync(dir)) continue;

  const onDisk = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  if (onDisk.length === 0) continue;

  // Compared against the bookkeeping table rather than `d1 migrations list`, whose
  // output is meant for humans and has no --json. A missing table means the
  // database has never had a migration applied, which is "all pending", not an error.
  let applied = new Set();
  try {
    const raw = execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', name, '--remote', '--json', '--command', 'SELECT name FROM d1_migrations'],
      { cwd: pkgDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const rows = JSON.parse(raw)?.[0]?.results ?? [];
    applied = new Set(rows.map((r) => r.name));
  } catch (err) {
    const text = String(err.stdout ?? '') + String(err.stderr ?? '');
    if (!/no such table/i.test(text)) {
      console.error(`preflight-migrations: could not read migration state for '${name}'.`);
      console.error(text.trim().split('\n').slice(-6).join('\n'));
      process.exit(2);
    }
  }

  const missing = onDisk.filter((f) => !applied.has(f));
  if (missing.length) pending.push({ name, dir, missing });
}

if (pending.length === 0) {
  console.log('preflight-migrations: all D1 migrations applied.');
  process.exit(0);
}

console.error('\npreflight-migrations: refusing to deploy — D1 migrations are pending.\n');
for (const { name, missing } of pending) {
  console.error(`  ${name}`);
  for (const f of missing) console.error(`    · ${f}`);
  console.error(`\n  Apply them, then deploy:\n    npx wrangler d1 migrations apply ${name} --remote\n`);
}
console.error(
  'Not applied automatically on purpose: a schema change is a human checkpoint, and a\n' +
    'deploy that mutates schema on its own is what that checkpoint exists to prevent.\n',
);
console.error(
  'If the schema looks already present, the ledger is what is missing — a database\n' +
    'whose tables were created outside `migrations apply` has no `d1_migrations` rows,\n' +
    'so nothing can say what is applied. Re-applying is safe when migrations are\n' +
    'idempotent, and it repairs the ledger. That reconcile is the point, not noise.\n',
);
process.exit(1);
