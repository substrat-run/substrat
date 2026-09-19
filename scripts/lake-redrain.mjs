#!/usr/bin/env node
/**
 * Re-send drained history into a rebuilt Tier-2 lake table (#1334).
 *
 * The drain stamps `drained_at` on every outbox row it ships, and the stamp is one-way.
 * Dropping the lake table — which a schema change forces, since a Pipelines stream cannot
 * change its schema in place and a sink refuses to write to an existing table — does not
 * clear those stamps. So without this, a rebuilt table starts at the rebuild with a silent
 * hole behind it. This walks every active scope and reopens the rows stamped before an
 * instant you name; the ordinary drain then ships them into the new table.
 *
 *   node scripts/lake-redrain.mjs --drained-before=2026-09-17T10:42:00.000Z --dry-run
 *   node scripts/lake-redrain.mjs --drained-before=2026-09-17T10:42:00.000Z
 *
 * `--dry-run` counts (#1545): one read-only aggregate per scope, so it answers how many rows
 * the real run would reopen without reopening any of them. The count is unbounded where the
 * reopen is batched, so it is the whole window per scope, not the first batch of it.
 *
 * `--drained-before` is REQUIRED, and choosing it is the only judgement in the whole run.
 * The safe answer is the moment the deploy carrying the NEW stream id finished; anything
 * from the teardown onwards is equally safe, and later still only re-sends rows the new
 * table already has. When unsure, pick later — a duplicate is reconcilable by event id, a
 * hole is not.
 *
 * This used to say the teardown was the WRONG instant, because "until the new id is live
 * the old plane may keep stamping rows into a stream that is gone". That is false, and it
 * mattered: it describes a hole this script would be the only way to repair, so it invites
 * a redrain that is not needed. **The drain fails closed.** `drainScopeEvents`
 * (`packages/kernel/src/platform-sweep.ts`) awaits `sink.ship(...)` and only then
 * `markEventsDrained(...)`, and `createPipelinesEventSink` throws when `send` does — so
 * while the binding names a stream that no longer exists, NOTHING is stamped. Those rows
 * stay undrained and ship by themselves once the id is fixed. The window between a
 * teardown and its deploy therefore contains no stamped rows at all, which is why the
 * choice of instant inside it cannot lose anything.
 *
 * What a recreate really costs, and what this script is for, is the rows stamped BEFORE
 * the teardown: the table that held them was dropped, and the stamp is one-way, so the
 * drain will never offer them again.
 *
 * Active scopes only, because those are the scopes the drain drains: reopening an archived
 * scope's rows would mark them eligible for a shipment that is never coming.
 *
 * It is idempotent. A second run over the same instant reopens nothing, writes no receipt,
 * and reports zero — so a run interrupted halfway is finished by running it again.
 *
 * Credentials from the secrets file, never argv: `SERVICE_TOKEN`, the control plane's own
 * service credential. The route it calls is staff/service-only by construction (absent
 * from `BUILDER_ROUTES`) and writes a `redrainEvents` receipt per scope that changed.
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

// ── The instant ──────────────────────────────────────────────────────────────────────

const drainedBeforeArg = flag('drained-before');
if (!drainedBeforeArg) {
  fail(
    '--drained-before=<ISO 8601> is required.\n' +
      '  It is the time the control-plane deploy carrying the NEW stream id finished.\n' +
      '  Earlier leaves holes in the rebuilt table; later re-sends a few rows it already has.\n' +
      '  When unsure, pick later.',
  );
}
// The same rule the platform's `instant` schema applies (contracts ids.ts, #963): a full
// date-time with a zone, normalised to `toISOString()`'s one fixed form. The adapters compare
// `drained_at` as TEXT, which is a time comparison only when both sides share that form — so
// "2026-09-17" is refused outright (it parses, then sorts before every stamp that day and
// reopens nothing while reporting success) and "…T12:00:00+02:00" is converted, not refused.
const at = Date.parse(drainedBeforeArg);
if (!/T\d{2}:\d{2}/.test(drainedBeforeArg) || !/(Z|[+-]\d{2}:?\d{2})$/.test(drainedBeforeArg) || Number.isNaN(at)) {
  fail(
    `--drained-before=${drainedBeforeArg} is not a date-time with a zone.\n` +
      `  Use ISO 8601 with a time and a zone, e.g. ${new Date().toISOString()}`,
  );
}
const drainedBefore = new Date(at).toISOString();
if (at > Date.now()) {
  fail(`--drained-before=${drainedBefore} is in the future — it would reopen rows already in the rebuilt table.`);
}

const token = readSecret('SERVICE_TOKEN');
if (!token) fail(`SERVICE_TOKEN blank in ${secretsFile} — the control-plane route needs it.`);

// ── The control plane ────────────────────────────────────────────────────────────────

async function cp(method, path, body) {
  const res = await fetch(`${cpUrl}/api${path}`, {
    method,
    headers: { 'x-service-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Left null: the caller reports the raw text, which is what a proxy error page is.
  }
  return { ok: res.ok, status: res.status, json, text };
}

/** Every active scope. The list route pages, and a bare GET silently truncates. */
async function activeScopes() {
  const all = [];
  let cursor;
  for (;;) {
    const q = `/scopes?status=active&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await cp('GET', q);
    if (!r.ok) fail(`GET ${q} → ${r.status}: ${r.text.slice(0, 300)}`);
    const entries = r.json?.entries ?? [];
    all.push(...entries);
    cursor = r.json?.nextCursor;
    if (!cursor) return all;
  }
}

console.log(`Re-send drained history — rows stamped before ${drainedBefore}  (${cpUrl})${dryRun ? '  [dry-run]' : ''}\n`);

const scopes = await activeScopes();
console.log(`${scopes.length} active scope(s)\n`);

/**
 * The dry run COUNTS (#1545), and the count is the answer it exists to give.
 *
 * It used to print `would reopen <scope>` for every active scope, which read as a per-scope
 * finding and was nothing of the kind: the line was unconditional, and no row was ever
 * counted. #1546 replaced it with an honest report of what a dry run could then establish —
 * everything except the number — because `redrainEvents` only ever reopened. `redrain-count`
 * is the read-only half that was missing: one unbounded aggregate per scope, no rows
 * touched, no receipt written.
 *
 * A scope whose control plane or deployment predates #1545 answers 404/501 rather than
 * reopening the window it was asked to count, and lands in the error list below. That is
 * the deliberate shape of the seam: a dry run must never be the thing that moves rows.
 */
if (dryRun) {
  console.log('Checked:');
  console.log(`  · control plane reachable at ${cpUrl}, SERVICE_TOKEN accepted`);
  console.log(`  · --drained-before parses and is in-window: ${drainedBefore}`);
  console.log(`  · ${scopes.length} active scope(s) to walk\n`);

  let wouldTotal = 0;
  let wouldScopes = 0;
  const countErrors = [];
  for (const scope of scopes) {
    const label = `${scope.tenantId}/${scope.id}${scope.vertical ? ` (${scope.vertical})` : ''}`;
    const r = await cp('POST', `/tenants/${scope.tenantId}/scopes/${scope.id}/redrain-count`, { drainedBefore });
    if (!r.ok) {
      countErrors.push({ label, why: `${r.status} ${r.json?.error ?? r.text.slice(0, 200)}` });
      console.log(`  ✗ ${label}  ${r.status}`);
      continue;
    }
    // Unbounded, so this is the WHOLE window for the scope — not one batch of it. A 200
    // without the number is a disagreement about the answer's shape, never a zero: reading
    // it as one would print "nothing to reopen" for a scope nothing counted.
    const n = r.json?.redrainable;
    if (typeof n !== 'number') {
      countErrors.push({ label, why: `200 without a count: ${r.text.slice(0, 200)}` });
      console.log(`  ✗ ${label}  no count in the reply`);
      continue;
    }
    wouldTotal += n;
    if (n > 0) wouldScopes += 1;
    console.log(`  ${n > 0 ? '●' : '='} ${label}  ${n > 0 ? `${n} row(s) would reopen` : 'nothing to reopen'}`);
  }

  console.log(`\n${wouldTotal} row(s) would reopen across ${wouldScopes} scope(s).`);
  console.log(`
Two things still decide whether you should:

  · Does the lake table hold anything? A table with zero Iceberg snapshots has never
    received a row, so there is nothing a re-send would be duplicating.
  · Is the history worth re-sending? This has NO lower bound — it reopens every stamped
    row before the instant, not just the ones since a teardown — and the drain ships 200
    per scope per 15 minutes, so a long backlog takes as long to re-send as it took to send.

Nothing changed. Drop --dry-run to reopen.`);
  if (countErrors.length > 0) {
    console.error(`\n✗ ${countErrors.length} scope(s) not counted (the total above excludes them):`);
    for (const e of countErrors) console.error(`    ${e.label}  ${e.why}`);
    console.error('  A 404 or 501 here is a control plane or a deployment older than the count verb (#1545).');
    process.exit(1);
  }
  process.exit(0);
}

let total = 0;
let changed = 0;
const errors = [];
for (const scope of scopes) {
  const label = `${scope.tenantId}/${scope.id}${scope.vertical ? ` (${scope.vertical})` : ''}`;
  // LOOP until the scope answers 0. One call reopens a bounded batch (`REDRAIN_BATCH`),
  // because the outbox is never pruned and an unbounded update on an old scope would not
  // fit in a single Durable Object request — it would fail, and fail again on every retry.
  // A caller that asked once would silently reopen a prefix of the window and report it as
  // the whole thing, which is the reading this loop exists to make impossible.
  let n = 0;
  let failed = false;
  for (;;) {
    const r = await cp('POST', `/tenants/${scope.tenantId}/scopes/${scope.id}/redrain-events`, { drainedBefore });
    if (!r.ok) {
      // One scope failing — typically a vertical with no serving deployment — never stops the
      // walk. Reported, and the exit code says the run is not finished. Whatever earlier
      // batches reopened stands: each is committed on its own, which is what makes the
      // operation resumable by simply running it again with the same instant.
      errors.push({ label, why: `${r.status} ${r.json?.error ?? r.text.slice(0, 200)}` });
      console.log(`  ✗ ${label}  ${r.status}${n > 0 ? `  (${n} reopened before the failure)` : ''}`);
      failed = true;
      break;
    }
    const batch = r.json?.redrained ?? 0;
    if (batch === 0) break;
    n += batch;
  }
  if (failed) continue;
  total += n;
  if (n > 0) changed += 1;
  console.log(`  ${n > 0 ? '●' : '='} ${label}  ${n > 0 ? `${n} reopened` : 'nothing to reopen'}`);
}

// Past the dry-run exit above, so this is always the real run's report.
console.log(`\n${total} row(s) reopened across ${changed} scope(s). The drain ships them on its next ticks —`);
console.log('200 per scope per 15 minutes, so a large backlog takes as long to re-send as it took to send.');
console.log('Re-running with the same instant is safe: it reopens nothing twice.');
if (errors.length > 0) {
  console.error(`\n✗ ${errors.length} scope(s) not reopened:`);
  for (const e of errors) console.error(`    ${e.label}  ${e.why}`);
  console.error('  Fix the cause and re-run with the same --drained-before; finished scopes report zero.');
  process.exit(1);
}
