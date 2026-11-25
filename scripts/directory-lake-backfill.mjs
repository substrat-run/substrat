#!/usr/bin/env node
/**
 * Backfill the lake's directory table with the rows each directory data set held before its
 * capture was switched on (K-70, tenants × time data leaves the objects; docs/rfc/tenant-scale.md
 * §12 step 2). The control plane reads one page per call and, on a real run, ships it to the
 * directory lake stream and records it in the directory, so a later prune can rely on the walk
 * having no gap (`packages/control-plane-api/src/directory-lake-backfill.ts`).
 *
 *   node scripts/directory-lake-backfill.mjs                       # dry run, every data set
 *   node scripts/directory-lake-backfill.mjs --dataset admin_log   # dry run, one
 *   node scripts/directory-lake-backfill.mjs --apply               # ship
 *
 * A DRY RUN BY DEFAULT: it walks each data set and prints how many rows a real run would ship
 * and the span of their times; it ships and records nothing. `--apply` ships. A real run needs the
 * data set's capture switched on first (`DIRECTORY_LAKE_CAPTURE` on the control plane, applied by
 * its next pass) and refuses otherwise, because rows written after the walk passed would reach
 * the lake only through the outbox.
 *
 * Resumable and idempotent: a real run starts where the directory says the last recorded page
 * ended, so an interrupted run is finished by running it again; a data set already backfilled is
 * reported and skipped.
 *
 * Credentials from the secrets file, never argv: `SERVICE_TOKEN`. The route is staff/service
 * only (on neither the builder nor the tenant-credential allowlist).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `DIRECTORY_LAKE_DATASET_NAMES` in packages/kernel/src/directory-lake.ts. The route refuses any other. */
const DATASETS = [
  'admin_log', 'access_log', 'ops_failures', 'sweep_runs', 'model_usage', 'build_usage',
  'request_days', 'cost_days', 'meter_days',
];

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const flag = (n) => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const apply = has('apply');
const secretsFile = flag('file') ?? 'secrets/platform.prod.env';
const cpUrl = (flag('cp') ?? 'https://console.substrat.net').replace(/\/$/, '').replace(/\/api$/, '');
const limit = Number(flag('limit') ?? 500);
const only = flag('dataset');

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

if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail('--limit must be an integer from 1 to 1000.');
if (only !== undefined && !DATASETS.includes(only)) fail(`--dataset must be one of ${DATASETS.join(', ')}`);
const token = readSecret('SERVICE_TOKEN');
if (!token) fail(`SERVICE_TOKEN blank in ${secretsFile} — the control-plane route needs it.`);

async function page(dataset, after, dryRun = !apply) {
  const res = await fetch(`${cpUrl}/api/directory-lake/backfill`, {
    method: 'POST',
    headers: { 'x-service-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ dataset, dryRun, after, limit }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Left null: reported as the raw text, which is what a proxy error page is.
  }
  if (!res.ok || !json) fail(`POST /directory-lake/backfill (${dataset}, after ${after}) → ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

console.log(`Directory lake backfill  (${cpUrl})${apply ? '' : '  [dry-run]'}\n`);

let total = 0;
for (const dataset of only ? [only] : DATASETS) {
  // A dry first page answers whether the data set captures and where a real walk resumes.
  const probe = await page(dataset, 0, true);
  let out = probe;
  if (apply) {
    if (probe.backfilledAt) {
      console.log(`  = ${dataset}  already backfilled at ${probe.backfilledAt}`);
      continue;
    }
    if (!probe.capturing) {
      console.log(`  – ${dataset}  not capturing; switch its capture on first`);
      continue;
    }
    out = await page(dataset, probe.resumeAfter);
  }
  let rows = out.rows;
  let from = out.from;
  let to = out.to;
  while (!out.done && out.next !== null) {
    out = await page(dataset, out.next);
    rows += out.rows;
    from ??= out.from;
    to = out.to ?? to;
  }
  total += rows;
  const span = rows > 0 ? `  ${from} … ${to}` : '';
  console.log(`  ${apply ? '✓' : '·'} ${dataset}  ${rows} row(s)${span}${out.capturing ? '' : '  (not capturing)'}`);
}
console.log(apply ? `\n${total} row(s) shipped.` : `\n${total} row(s) would be shipped. Run with --apply to ship.`);
