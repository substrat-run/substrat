#!/usr/bin/env node
/**
 * Heal previews that kept a production serving pin (#1724).
 *
 * A preview adopted onto its vertical's serving script before #1731 still routes by
 * `COALESCE(servingRef, deploymentRef)`, so it serves production code while its binding names
 * the version it was pushed from. #1962 heals one on its next `scope bind`; this walks the
 * fleet for the ones nobody binds again. Per preview it does what that bind does with the
 * version the preview is already bound to: carry the data off the serving script into that
 * version's own script, bind, then clear the pin.
 *
 *   node scripts/repair-preview-pins.mjs --dry-run
 *   node scripts/repair-preview-pins.mjs
 *
 * `--dry-run` lists the previews a real run would repair and moves nothing.
 *
 * The control plane pages the walk and this follows `nextCursor` to the end, so a run that is
 * interrupted is finished by running it again. It is idempotent: a healed preview is no longer
 * pinned, so a second run reports nothing to repair. A preview that FAILS is reported and left
 * pinned (its data is still where its route points), and the exit code is 1 so the run is not
 * mistaken for a clean one; run it again once the cause is fixed.
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
const limit = Number(flag('limit') ?? 25);

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

if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('--limit must be an integer from 1 to 100.');
const token = readSecret('SERVICE_TOKEN');
if (!token) fail(`SERVICE_TOKEN blank in ${secretsFile} — the control-plane route needs it.`);

async function pass(cursor) {
  const res = await fetch(`${cpUrl}/api/previews/repair-serving-pins`, {
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
  if (!res.ok || !json) fail(`POST /previews/repair-serving-pins → ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

console.log(`Heal legacy preview serving pins  (${cpUrl})${dryRun ? '  [dry-run]' : ''}\n`);

const label = (r) => `${r.tenantId}/${r.scopeId}`;
let repaired = 0;
let candidates = 0;
const skipped = [];
const failed = [];
let cursor;
do {
  const out = await pass(cursor);
  for (const r of out.repaired) {
    repaired += 1;
    console.log(`  ✓ ${label(r)}  ${r.from} → ${r.to}  (${r.tables} table(s))`);
  }
  for (const r of out.candidates) {
    candidates += 1;
    console.log(`  · ${label(r)}  pinned to ${r.servingRef}`);
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
    ? `\n${candidates} preview(s) would be repaired.`
    : `\n${repaired} repaired, ${skipped.length} skipped, ${failed.length} failed.`,
);
if (skipped.length) console.log('Skipped previews keep their pin: nothing was moved for them.');
if (failed.length) {
  console.log('Failed previews keep their pin and their data; run again once the cause is fixed.');
  process.exit(1);
}
