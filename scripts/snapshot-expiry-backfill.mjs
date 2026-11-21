#!/usr/bin/env node
/**
 * Give the pre-promote snapshots taken before they were born expiring an end (#3314).
 *
 * A fork-before-promote snapshot now carries an `expiresAt` 30 days out, and the platform sweep's
 * snapshot GC reaps it. The ones taken before that change carry none, so the GC never reaps them.
 * This walks the directory for `archive` forks with no expiry and gives each one this rule names:
 *
 *   pre-promote  its source scope was rebound (`bindScopeVersion` in the admin log) within two
 *                minutes of the fork's creation: the snapshot a promote took first.
 *   stuck        still `provisioning` a day after creation: a snapshot that crashed half-made.
 *
 * Each gets `max(createdAt + 30 days, now + grace)`, so none is reaped on the next pass without
 * `--grace-days` (default 7) of notice. Anything else (a deliberate manual snapshot, a fork whose
 * history the admin log no longer holds) is listed and left alone: absent an expiry, it is kept.
 *
 *   node scripts/snapshot-expiry-backfill.mjs                 # dry run: lists, writes nothing
 *   node scripts/snapshot-expiry-backfill.mjs --apply         # writes the expiries
 *   node scripts/snapshot-expiry-backfill.mjs --env test      # the test control plane
 *
 * The write is `PUT /tenants/:t/scopes/:s/expires-at`, audited as `setScopeExpiresAt`; pin one back
 * with `{ "expiresAt": null }` on the same route. Idempotent: a snapshot with an expiry is no longer
 * a candidate, so a second run lists only what the first skipped. A failed write is reported and the
 * exit code is 1.
 *
 * Credentials from the secrets file, never argv: `SERVICE_TOKEN`. The routes are staff/service only.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAY_MS = 86_400_000;
/** The kernel's `PRE_PROMOTE_SNAPSHOT_TTL_MS`, in days: what a snapshot taken today is given. */
const TTL_DAYS = 30;
/** How close after the fork's creation its source's rebind must be to call it a promote's snapshot. */
const PROMOTE_WINDOW_MS = 2 * 60_000;

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const flag = (n) => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const apply = has('apply');
const env = flag('env') ?? 'prod';
const secretsFile = flag('file') ?? `secrets/platform.${env}.env`;
const cpUrl = (flag('cp') ?? (env === 'prod' ? 'https://console.substrat.net' : 'https://console-test.substrat.net'))
  .replace(/\/$/, '')
  .replace(/\/api$/, '');
const graceDays = Number(flag('grace-days') ?? 7);

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

if (!Number.isInteger(graceDays) || graceDays < 1) fail('--grace-days must be a whole number of days, at least 1.');
const token = readSecret('SERVICE_TOKEN');
if (!token) fail(`SERVICE_TOKEN blank in ${secretsFile} — the control-plane routes need it.`);

async function call(method, path, body) {
  const res = await fetch(`${cpUrl}/api${path}`, {
    method,
    headers: { 'x-service-token': token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Left null: reported as the raw text, which is what a proxy error page is.
  }
  return { ok: res.ok, status: res.status, json, text };
}

async function get(path) {
  const r = await call('GET', path);
  if (!r.ok || !r.json) fail(`GET ${path} → ${r.status}: ${r.text.slice(0, 300)}`);
  return r.json;
}

async function allScopes() {
  const rows = [];
  let cursor;
  do {
    const page = await get(`/scopes?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    rows.push(...page.entries);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return rows;
}

/** Did the fork's source get rebound within the window after the fork was created? */
async function promotedRightAfter(scope) {
  const since = new Date(Date.parse(scope.createdAt)).toISOString();
  const until = new Date(Date.parse(scope.createdAt) + PROMOTE_WINDOW_MS).toISOString();
  const q = new URLSearchParams({ tenantId: scope.tenantId, scopeId: scope.forkedFrom, action: 'bindScopeVersion', since, until, limit: '1' });
  const page = await get(`/admin-log?${q}`);
  return (page.entries ?? []).length > 0;
}

console.log(`Backfill pre-promote snapshot expiries  (${cpUrl})${apply ? '' : '  [dry run: nothing is written]'}\n`);

const now = Date.now();
const candidates = (await allScopes()).filter(
  (s) => s.kind === 'archive' && s.forkedFrom && s.expiresAt === null && (s.status === 'active' || s.status === 'provisioning'),
);

const given = [];
const left = [];
const failed = [];
for (const s of candidates) {
  const created = Date.parse(s.createdAt);
  const stuck = s.status === 'provisioning' && now - created > DAY_MS;
  const why = stuck ? 'stuck' : (await promotedRightAfter(s)) ? 'pre-promote' : null;
  const label = `${s.tenantId}/${s.id}  ${s.vertical ?? '-'}  ${s.status}  made ${s.createdAt.slice(0, 10)}`;
  if (!why) {
    left.push(s);
    console.log(`  – ${label}  left: no promote beside it in the admin log`);
    continue;
  }
  const expiresAt = new Date(Math.max(created + TTL_DAYS * DAY_MS, now + graceDays * DAY_MS)).toISOString();
  if (!apply) {
    given.push(s);
    console.log(`  · ${label}  ${why} → expires ${expiresAt}`);
    continue;
  }
  const r = await call('PUT', `/tenants/${s.tenantId}/scopes/${s.id}/expires-at`, { expiresAt });
  if (r.ok) {
    given.push(s);
    console.log(`  ✓ ${label}  ${why} → expires ${expiresAt}`);
  } else {
    failed.push(s);
    console.log(`  ✗ ${label}  ${r.status} ${r.text.slice(0, 200)}`);
  }
}

console.log(
  `\n${candidates.length} archive fork(s) with no expiry: ${given.length} ${apply ? 'given' : 'would be given'} one, ` +
    `${left.length} left as they are${apply ? `, ${failed.length} failed` : ''}.`,
);
if (failed.length) {
  console.log('A failed snapshot keeps no expiry; run again once the cause is fixed.');
  process.exit(1);
}
