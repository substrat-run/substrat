#!/usr/bin/env node
/**
 * Load a raw Cloudflare usage snapshot into the daily cost rollup (#3316), for the days the
 * analytics no longer answer for (they keep 90 days).
 *
 * The snapshot is a folder of JSON lines, one object per line, as Cloudflare's GraphQL Analytics
 * returned them, each carrying its UTC `date`:
 *
 *   workers.jsonl          workersInvocationsAdaptive               scriptName, cpuTimeUs
 *   do_invocations.jsonl   durableObjectsInvocationsAdaptiveGroups  namespaceId, scriptName, requests
 *   do_objects.jsonl       durableObjectsPeriodicGroups             namespaceId, objectId, rowsRead,
 *                                                                   rowsWritten, storageWriteUnits, duration
 *
 * Each day goes to `POST /meters/cloudflare-costs/days`, which attributes it through the directory
 * with the same code the scheduled pass runs. A day the pass already read is refused there (409) and
 * counted as skipped here, so the snapshot never replaces a read that carries confidence intervals.
 * A snapshot carries none: the adaptive figures load as estimates without an interval.
 *
 *   node scripts/cloudflare-cost-backfill.mjs --dir <snapshot>              # dry run: validates, writes nothing
 *   node scripts/cloudflare-cost-backfill.mjs --dir <snapshot> --apply      # loads every day not yet read
 *   node scripts/cloudflare-cost-backfill.mjs --dir <snapshot> --until 2026-08-27 --apply
 *   ... --namespaces <file.json>   # optional: [{ id, script, class }], so objects keep their class
 *
 * Apply it after the deploy that carries the rollup, once the scheduled pass has recorded the scopes'
 * object ids (its log line stops reporting `scopeObjects`) and caught up on the days it can still
 * read: the snapshot then fills only the days before the pass's lookback, attributed against every
 * object id the directory knows. A loaded day is not re-attributed later.
 *
 * The dry run prints counts and totals only, never a script, tenant or vertical, so its output can
 * be pasted where the snapshot cannot. Credentials from the secrets file, never argv: `SERVICE_TOKEN`.
 * Needs `pnpm build` first: each day is checked against the contracts schema the route parses with.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const flag = (n) => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const apply = has('apply');
const dir = flag('dir');
if (!dir) fail('--dir <snapshot folder> is required (the folder holding workers.jsonl, do_objects.jsonl, do_invocations.jsonl).');
const from = flag('from');
const until = flag('until');
const namespacesFile = flag('namespaces');
const env = flag('env') ?? 'prod';
const secretsFile = flag('file') ?? `secrets/platform.${env}.env`;
const cpUrl = (flag('cp') ?? (env === 'prod' ? 'https://console.substrat.net' : 'https://console-test.substrat.net'))
  .replace(/\/$/, '')
  .replace(/\/api$/, '');

const contractsDist = join(ROOT, 'packages/contracts/dist/index.js');
if (!existsSync(contractsDist)) fail('packages/contracts is not built: run `pnpm build` first.');
const { cloudflareUsageDay } = await import(pathToFileURL(contractsDist).href);

/** Every JSON line of one snapshot file, or none when the file is absent. */
function lines(name) {
  const path = resolve(dir, name);
  if (!existsSync(path)) fail(`${name} not found in ${dir}`);
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        fail(`${name}:${i + 1} is not JSON`);
      }
    });
}

const inWindow = (day) => (!from || day >= from) && (!until || day <= until);
const days = new Map();
const dayOf = (day) => {
  if (!days.has(day)) days.set(day, { day, workers: [], doInvocations: [], doObjects: [], namespaces: [] });
  return days.get(day);
};
for (const r of lines('workers.jsonl')) {
  if (inWindow(r.date)) dayOf(r.date).workers.push({ script: r.scriptName, cpuTimeUs: r.cpuTimeUs });
}
for (const r of lines('do_invocations.jsonl')) {
  if (inWindow(r.date)) dayOf(r.date).doInvocations.push({ namespaceId: r.namespaceId, script: r.scriptName, requests: r.requests });
}
for (const r of lines('do_objects.jsonl')) {
  if (!inWindow(r.date)) continue;
  dayOf(r.date).doObjects.push({
    namespaceId: r.namespaceId,
    objectId: r.objectId,
    rowsRead: r.rowsRead,
    rowsWritten: r.rowsWritten,
    storageWriteUnits: r.storageWriteUnits,
    duration: r.duration,
  });
}
const namespaces = namespacesFile
  ? JSON.parse(readFileSync(resolve(namespacesFile), 'utf8')).map((n) => ({ id: n.id, script: n.script ?? null, class: n.class ?? null }))
  : [];

const ordered = [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
if (ordered.length === 0) fail('the snapshot holds no day in that window.');

let token;
if (apply) {
  token = readSecret('SERVICE_TOKEN');
  if (!token) fail(`SERVICE_TOKEN blank in ${secretsFile}: the control-plane route needs it.`);
}

/** Same flat-env parse as scripts/secrets.mjs: KEY=VALUE, `#` comments, optional quotes. */
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

console.log(
  `Load a Cloudflare usage snapshot into the cost rollup  (${apply ? cpUrl : 'dry run: nothing is sent'})\n` +
    `${ordered.length} day(s), ${ordered[0].day} → ${ordered.at(-1).day}\n`,
);

const totals = { rowsWritten: 0, rowsRead: 0, durationGbS: 0, objects: 0, loaded: 0, skipped: 0, failed: 0 };
for (const raw of ordered) {
  const parsed = cloudflareUsageDay.safeParse({ ...raw, namespaces });
  if (!parsed.success) {
    totals.failed += 1;
    console.log(`  ✗ ${raw.day}  does not parse: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
    continue;
  }
  const usage = parsed.data;
  const written = usage.doObjects.reduce((n, o) => n + o.rowsWritten, 0);
  const read = usage.doObjects.reduce((n, o) => n + o.rowsRead, 0);
  const gbs = usage.doObjects.reduce((n, o) => n + o.duration, 0);
  totals.rowsWritten += written;
  totals.rowsRead += read;
  totals.durationGbS += gbs;
  totals.objects += usage.doObjects.length;
  const label =
    `${usage.day}  ${String(usage.workers.length).padStart(4)} scripts  ${String(usage.doInvocations.length).padStart(4)} namespaces  ` +
    `${String(usage.doObjects.length).padStart(5)} objects  ${written.toLocaleString('en').padStart(12)} rows written`;
  if (!apply) {
    console.log(`  · ${label}`);
    continue;
  }
  const res = await fetch(`${cpUrl}/api/meters/cloudflare-costs/days`, {
    method: 'POST',
    headers: { 'x-service-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(usage),
  });
  const text = await res.text();
  if (res.status === 201) {
    totals.loaded += 1;
    console.log(`  ✓ ${label}  → ${JSON.parse(text).recorded} rows`);
  } else if (res.status === 409) {
    totals.skipped += 1;
    console.log(`  – ${label}  already read by the scheduled pass`);
  } else {
    totals.failed += 1;
    console.log(`  ✗ ${label}  ${res.status} ${text.slice(0, 200)}`);
  }
}

console.log(
  `\n${totals.objects.toLocaleString('en')} object-days, ${totals.rowsWritten.toLocaleString('en')} rows written, ` +
    `${totals.rowsRead.toLocaleString('en')} rows read, ${totals.durationGbS.toFixed(1)} GB-s.` +
    (apply ? `\n${totals.loaded} day(s) loaded, ${totals.skipped} already read, ${totals.failed} failed.` : ''),
);
if (totals.failed) process.exit(1);
