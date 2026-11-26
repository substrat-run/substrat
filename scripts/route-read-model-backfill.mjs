#!/usr/bin/env node
/**
 * Fill the routing read model once (#3395): every route the directory serves, and every vertical's
 * serving policy, published to the ROUTES KV namespace the router reads.
 *
 * The directory publishes every later change itself (its triggers capture them, and it drains them
 * after each call), and switching the read model on already marks every key dirty. This is the
 * operator's handle on the same thing: run it after the control plane first deploys with the
 * ROUTES binding, and before the router's ROUTE_READ_MODEL is set to `compare` or `on`.
 *
 *   node scripts/route-read-model-backfill.mjs                 # dry run: counts, writes nothing
 *   node scripts/route-read-model-backfill.mjs --apply         # marks every key dirty and publishes
 *   node scripts/route-read-model-backfill.mjs --env test      # the test control plane
 *
 * The dry run prints what the read model holds (`published`), what a complete one holds (`routable`
 * routes, `refused` refusals and `verticals` policies) and what is queued (`outbox`). `pinned` routes
 * are never published (K-36: KV has no jurisdiction, and a route naming a pinned sibling would carry
 * its name); the router reads those from the directory.
 *
 * The service token is never sent across a redirect (`redirect: 'error'`), nor over plain http but to
 * localhost; `--cp <url>` names the control plane's final URL when the default one moves. The first
 * request is bounded by `--timeout` (default 120 s); on timeout the result is unknown, and the dry
 * run says where it stands.
 *
 * `--apply` publishes up to 2,000 keys in the call; the directory publishes the rest in the rounds
 * that follow. It then polls the status until the outbox is empty (or `--wait` seconds pass,
 * default 120). Idempotent: an entry whose content is unchanged is not written again, so a second
 * run writes nothing. `POST /api/route-read-model/publish` changes no directory row and writes no
 * admin-log entry; the run is logged by the control plane.
 *
 * Credentials from the secrets file, never argv: `SERVICE_TOKEN`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
/**
 * A flag's value, or undefined when the flag is absent. A flag given WITHOUT a value (`--env` last,
 * or followed by another `--flag`) is refused here, before any default is chosen: `--apply --env`
 * must never fall through to prod.
 */
const flag = (n) => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) {
    const v = eq.slice(n.length + 3);
    if (v === '') fail(`--${n} needs a value`);
    return v;
  }
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || (v.startsWith('--') && !/^-?\d/.test(v.slice(1)))) fail(`--${n} needs a value`);
  return v;
};

const apply = has('apply');
const env = flag('env') ?? 'prod';
if (env !== 'prod' && env !== 'test') fail(`--env must be prod or test, not ${env}`);
const secretsFile = flag('file') ?? `secrets/platform.${env}.env`;
const cpUrl = (flag('cp') ?? (env === 'prod' ? 'https://console.substrat.net' : 'https://console-test.substrat.net'))
  .replace(/\/$/, '')
  .replace(/\/api$/, '');
const waitSeconds = Number(flag('wait') ?? 120);
/** How long the first request (the dry run, or the apply round) may take, headers and body. */
const firstTimeoutSeconds = Number(flag('timeout') ?? 120);

// The service token goes only over TLS. Plain http is allowed for a loopback host (local dev) alone.
{
  let url;
  try {
    url = new URL(cpUrl);
  } catch {
    fail(`--cp is not a URL: ${cpUrl}`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    fail(`refusing to send the service token to ${url.origin}: use https (plain http only for localhost)`);
  }
}

/**
 * Same flat-env grammar as scripts/secrets.mjs (`parseEnvText`) — KEY=VALUE, `#` comments, optional
 * quotes — and the same answer: the LAST non-blank assignment wins, so a rotated token appended below
 * the old one is the one sent.
 */
function readSecret(key) {
  let text;
  try {
    text = readFileSync(resolve(ROOT, secretsFile), 'utf8');
  } catch {
    fail(`secrets file not found: ${secretsFile}`);
  }
  let found;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0 || line.slice(0, eq).trim() !== key) continue;
    let v = line.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\n/g, '\n');
    if (v !== '') found = v;
  }
  return found;
}

if (!Number.isFinite(waitSeconds) || waitSeconds < 0) fail('--wait must be a number of seconds, 0 or more.');
if (!Number.isFinite(firstTimeoutSeconds) || firstTimeoutSeconds <= 0) fail('--timeout must be a number of seconds, more than 0.');
const token = readSecret('SERVICE_TOKEN');
if (!token) fail(`SERVICE_TOKEN blank in ${secretsFile} — the control-plane route needs it.`);

async function publish(body, signal) {
  // `redirect: 'error'`: the token rides a custom header, which a followed cross-origin redirect
  // would carry to the other origin. A redirect is refused; point --cp at the final URL instead.
  let res;
  try {
    res = await fetch(`${cpUrl}/api/route-read-model/publish`, {
      method: 'POST',
      headers: { 'x-service-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (signal?.aborted) return null;
    fail(`POST ${cpUrl}/api/route-read-model/publish failed (${err instanceof Error ? err.message : err}) — a redirect is refused; pass --cp with the control plane's final URL.`);
  }
  let text;
  try {
    text = await res.text();
  } catch (err) {
    if (signal?.aborted) return null;
    throw err;
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Reported as the raw text below, which is what a proxy error page is.
  }
  if (!res.ok || !json) fail(`POST /api/route-read-model/publish → ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

const show = (label, status) => {
  if (!status.enabled) {
    fail(`${label}: the read model is OFF on ${env} — the control plane has no ROUTES namespace bound.`);
  }
  console.log(
    `${label}: published ${status.published} of ${status.routable + status.refused + status.verticals} ` +
      `(routes ${status.routable}, refusals ${status.refused}, vertical policies ${status.verticals}) · ` +
      `queued ${status.outbox} · left to the directory (pinned) ${status.pinned}`,
  );
};

// Bounded on its own (`--timeout`), headers and body: `--wait 0` skips the polling, not this.
const first = await publish({ apply }, AbortSignal.timeout(firstTimeoutSeconds * 1000));
if (!first) {
  console.log(
    `No answer within ${firstTimeoutSeconds}s, so the result is unknown${apply ? ': publishing may already be running' : ''}. ` +
      'Run the dry run (without --apply) to see where it stands.',
  );
  process.exit(1);
}
show(apply ? 'after the first round' : 'dry run', first.status);
if (!apply) {
  console.log('Nothing written. Re-run with --apply to publish.');
  process.exit(0);
}
console.log(`  this round: ${JSON.stringify(first.flushed)}`);

const deadline = Date.now() + waitSeconds * 1000;
let status = first.status;
// Every wait and every poll is held to the deadline; `--wait 0` polls nothing.
while (status.outbox > 0 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, Math.min(5000, deadline - Date.now())));
  const left = deadline - Date.now();
  if (left <= 0) break;
  const polled = await publish({}, AbortSignal.timeout(left));
  if (!polled) break;
  status = polled.status;
  show('  waiting', status);
}
if (status.outbox > 0) {
  console.log(`Still ${status.outbox} key(s) queued after ${waitSeconds}s; the directory keeps publishing. Re-run the dry run to watch.`);
  process.exit(0);
}
console.log('✓ the outbox is empty: every routable route and policy is published.');
