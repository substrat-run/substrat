#!/usr/bin/env node
/**
 * The smoke test that turns the control plane's lake query engine on (#1334, K-70). The R2 SQL
 * client (`packages/control-plane-api/src/r2-sql-engine.ts`) has never been run against the real
 * lake, so the control plane is deployed without the `LAKE_BUCKET` var that switches it on. This
 * runs the client and the SQL the control plane compiles, with the token the control plane holds,
 * against the lake as it is, and says whether each shape works:
 *
 *   pnpm --filter @substrat-run/control-plane-api build      # the client and compilers are run from dist
 *   node scripts/lake-sql-smoke.mjs                          # every query shape, matching no row
 *   node scripts/lake-sql-smoke.mjs --sample                 # also one row per data set, decoded
 *
 * **Read-only, and quiet by default.** Every shape query carries a predicate that matches no row
 * (a tenant, kind and cursor no tenant has), so it proves the token's permissions, the endpoint,
 * the response envelope and that R2 SQL accepts the SQL (the timestamp comparisons included), and
 * reads nothing. `--sample` reads the newest row of each data set the lake holds, to prove the
 * decode path (the `row` JSON, the time columns' types, an admin-log row becoming an entry). It
 * prints only counts and types, never a value. It is a person's read with the control plane's
 * query token, outside the control plane, so it is not in the access log: run `--sample` only as
 * part of turning the engine on.
 *
 * Credentials from the secrets file, never argv: `CF_ACCOUNT_ID` and `R2_LAKE_SQL_TOKEN` (the
 * token `scripts/env-provision.mjs` mints as `substrat-<env>-lake-sql` and `scripts/secrets.mjs`
 * pushes as `R2_SQL_TOKEN`). The bucket and tables are `scripts/lake/lakes.mjs`'s.
 *
 * When every line is ✓, the next step is a reviewed PR that sets `LAKE_BUCKET` in prod's vars
 * (`apps/control-plane/wrangler.jsonc`). That switches on BOTH readers of the engine: the staff
 * events gateway (`GET /tenants/:id/lake/events`, 501 until then) and the directory history reads,
 * which stay `off` until `DIRECTORY_LAKE_READS` says otherwise.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { LAKES } from './lake/lakes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'packages/control-plane-api/dist');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const flag = (n) => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const secretsFile = flag('file') ?? 'secrets/platform.prod.env';
const sample = has('sample');

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** Same flat-env parse as scripts/secrets.mjs — KEY=VALUE, `#` comments, optional quotes. */
function readSecret(key) {
  let text;
  try {
    text = readFileSync(resolve(ROOT, secretsFile), 'utf8');
  } catch {
    fail(`secrets file not found: ${secretsFile}`);
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0 || line.slice(0, eq).trim() !== key) continue;
    let v = line.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    return v === '' ? undefined : v;
  }
  return undefined;
}

const account = readSecret('CF_ACCOUNT_ID');
const token = readSecret('R2_LAKE_SQL_TOKEN');
if (!account) fail(`CF_ACCOUNT_ID blank in ${secretsFile}.`);
if (!token) fail(`R2_LAKE_SQL_TOKEN blank in ${secretsFile} — scripts/env-provision.mjs mints it (prod only).`);

const buckets = [...new Set(Object.values(LAKES).map((l) => l.bucket))];
if (buckets.length !== 1) fail(`the lakes span ${buckets.length} buckets; the control plane's LAKE_BUCKET names one`);
const bucket = buckets[0];

const load = async (file) => {
  const path = join(DIST, file);
  if (!existsSync(path)) fail(`${path} not built — run: pnpm --filter @substrat-run/control-plane-api build`);
  return import(pathToFileURL(path).href);
};
const { createR2SqlEngine } = await load('r2-sql-engine.js');
const { compileLakeEvents } = await load('lake-gateway.js');
const { compileDirectoryLakeQuery, queryDirectoryLake, adminLogEntryOfLakeRow, directoryWindowStart } = await load('directory-lake-reads.js');
const { DIRECTORY_LAKE_DATASET_NAMES } = await import(pathToFileURL(join(ROOT, 'packages/kernel/dist/index.js')).href);

const engine = createR2SqlEngine({ accountId: account, bucket, token });

// Values no tenant, kind or key has, inside the lake alphabet, so every shape below matches nothing.
const NONE = 'lake-smoke-matches-nothing';
const nowMs = Date.now();
const windowStart = directoryWindowStart(nowMs);
const weekBefore = new Date(Date.parse(windowStart) - 7 * 86_400_000).toISOString();

console.log(`Lake query smoke test  (bucket ${bucket})${sample ? '  [sample]' : ''}\n`);
let failed = 0;
const check = async (label, run) => {
  try {
    const said = await run();
    console.log(`  ✓ ${label}${said ? `  ${said}` : ''}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${label}\n      ${(err && err.message) || String(err)}`);
  }
};
const none = (rows) => {
  if (rows.length !== 0) throw new Error(`expected no row for a predicate nothing matches, got ${rows.length}`);
  return '0 rows';
};

// The events gateway's one shape (#1334), every conjunct it can carry.
const events = LAKES.events;
await check(`${events.namespace}.${events.table}: a tenant's page, every filter`, async () =>
  none(
    await engine.query(
      compileLakeEvents(NONE, {
        scopeId: NONE, type: NONE, entityType: NONE, entityId: NONE, actor: NONE, operation: NONE,
        version: NONE, impersonated: true, since: weekBefore, until: windowStart, cursor: NONE, limit: 1,
      }),
    ),
  ),
);

// The directory history read's shapes (directory-lake-reads.ts): a tenant's page with every
// conjunct, a staff-wide page with a kind list, and the ascending walk the export pages.
const directory = LAKES.directory;
const table = `${directory.namespace}.${directory.table}`;
await check(`${table}: a tenant's page, every filter, newest first`, async () =>
  none(await engine.query(compileDirectoryLakeQuery('admin_log', {
    tenantId: NONE, scopeId: NONE, actor: NONE, kind: NONE, since: weekBefore, until: windowStart, cursor: NONE, order: 'desc', limit: 1,
  }))),
);
await check(`${table}: a staff-wide page, a kind list`, async () =>
  none(await engine.query(compileDirectoryLakeQuery('ops_failures', { kind: [NONE, `${NONE}.2`], until: windowStart, order: 'desc', limit: 1 }))),
);
await check(`${table}: the oldest-first walk`, async () =>
  none(await engine.query(compileDirectoryLakeQuery('sweep_runs', { tenantId: NONE, cursor: NONE, until: windowStart, order: 'asc', limit: 1 }))),
);
// A day-keyed data set's `at` is that day's UTC midnight: compared with an instant like the rest.
await check(`${table}: a day-keyed data set's window`, async () =>
  none(await engine.query(compileDirectoryLakeQuery('meter_days', { tenantId: NONE, since: weekBefore, until: windowStart, order: 'desc', limit: 1 }))),
);

if (sample) {
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  for (const dataset of DIRECTORY_LAKE_DATASET_NAMES) {
    await check(`${table}: newest ${dataset} row decodes`, async () => {
      const raw = await engine.query(compileDirectoryLakeQuery(dataset, { order: 'desc', limit: 1 }));
      if (raw.length === 0) return 'no row yet (not captured, or not backfilled)';
      const first = raw[0];
      const types = ['seq', 'at', 'captured_at', 'row'].map((c) => `${c}: ${typeOf(first[c])}`).join(', ');
      const { records } = await queryDirectoryLake(engine, dataset, { order: 'desc', limit: 1 });
      if (records.length !== 1 || typeof records[0].row !== 'object' || records[0].row === null) {
        throw new Error(`the row column did not decode to an object (${types})`);
      }
      if (dataset === 'admin_log') {
        try {
          adminLogEntryOfLakeRow(records[0].row);
        } catch (err) {
          // The fields that failed, never their values.
          const fields = (err?.issues ?? []).map((i) => i.path.join('.')).filter(Boolean);
          throw new Error(`the row does not parse as an admin-log entry${fields.length ? ` (fields: ${fields.join(', ')})` : ''}`);
        }
      }
      return `${raw.length} version(s) read; ${types}${dataset === 'admin_log' ? '; parses as an admin-log entry' : ''}`;
    });
  }
}

if (failed > 0) {
  console.log(`\n${failed} check(s) failed. Leave LAKE_BUCKET unset: the control plane would answer these reads with the errors above.`);
  process.exit(1);
}
console.log(`
Every check passed. To switch the engine on:
  1. A reviewed PR adds "LAKE_BUCKET": "${bucket}" to prod's vars in apps/control-plane/wrangler.jsonc.
     Its release turns on the staff events gateway and lets DIRECTORY_LAKE_READS mean something.
  2. Then DIRECTORY_LAKE_READS=compare, once each data set read from the lake is captured and backfilled
     (node scripts/directory-lake-backfill.mjs).`);
