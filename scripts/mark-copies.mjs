#!/usr/bin/env node
/**
 * Mark every existing preview, fork and snapshot as a copy, in its own storage (#2005).
 *
 * A hosted vertical with no control-plane directory reads a scope's own copy marker to hold a
 * preview's or a fork's effects inert. Every copy made since #2005 carries the marker, and every
 * carry onto one stamps it; a copy made before either, and never carried since, holds none. This
 * walks the fleet for those: the control plane picks every scope its directory says is not
 * primary, asks the vertical holding it to stamp the marker, and logs each one. An install is
 * never touched.
 *
 *   node scripts/mark-copies.mjs --dry-run
 *   node scripts/mark-copies.mjs
 *
 * `--dry-run` lists the scopes a real run would visit and touches nothing.
 *
 * Suspended and archived copies are visited too, since either can be reactivated (and a
 * reactivation marks a copy first, so neither path brings an unmarked copy back to life).
 *
 * The control plane pages the walk and this follows `nextCursor` to the end, so a run that is
 * interrupted is finished by running it again. It is idempotent: a marked scope answers
 * "already". A scope that FAILS — a vertical too old to have the verb, or a hosted copy whose
 * deployment does not currently resolve — is reported and left unmarked, and the exit code is 1;
 * fix the cause and run again. SKIPPED is legitimately finished: a copy bound to no vertical, or a
 * co-located one, whose host reads the directory and needs no marker.
 *
 * Credentials from the secrets file, never argv: `SERVICE_TOKEN`. The route is staff/service
 * only (on neither the builder nor the tenant-credential allowlist).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

const dryRun = has('dry-run');
const secretsFile = flag('file') ?? 'secrets/platform.prod.env';
const cpUrl = (flag('cp') ?? 'https://console.substrat.net').replace(/\/$/, '').replace(/\/api$/, '');
const limit = Number(flag('limit') ?? 50);

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

if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('--limit must be an integer from 1 to 200.');
const token = readSecret('SERVICE_TOKEN');
if (!token) fail(`SERVICE_TOKEN blank in ${secretsFile} — the control-plane route needs it.`);

async function pass(cursor) {
  const res = await fetch(`${cpUrl}/api/scopes/mark-copies`, {
    method: 'POST',
    headers: { 'x-service-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ limit, dryRun, ...(cursor ? { cursor } : {}) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Left null: reported as the raw text, which is what a proxy error page is.
  }
  if (!res.ok || !json) fail(`POST /scopes/mark-copies → ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

console.log(`Mark existing copies as copies  (${cpUrl})${dryRun ? '  [dry-run]' : ''}\n`);

const label = (r) => `${r.tenantId}/${r.scopeId}`;
let marked = 0;
let already = 0;
let candidates = 0;
const skipped = [];
const failed = [];
let cursor;
do {
  const out = await pass(cursor);
  for (const r of out.marked) {
    marked += 1;
    console.log(`  ✓ ${label(r)}  marked`);
  }
  already += out.already.length;
  for (const r of out.candidates) {
    candidates += 1;
    console.log(`  · ${label(r)}`);
  }
  for (const r of out.skipped) {
    skipped.push(r);
    console.log(`  – ${label(r)}  skipped: ${r.reason}`);
  }
  for (const r of out.failed) {
    failed.push(r);
    console.log(`  ✗ ${label(r)}  ${r.status} ${r.error}`);
  }
  cursor = out.nextCursor ?? undefined;
} while (cursor);

console.log(
  dryRun
    ? `\n${candidates} scope(s) would be visited.`
    : `\n${marked} marked, ${already} already marked, ${skipped.length} skipped, ${failed.length} failed.`,
);
if (failed.length) {
  console.log('Failed scopes are still unmarked; run again once the cause is fixed.');
  process.exit(1);
}
