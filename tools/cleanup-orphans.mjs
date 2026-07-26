#!/usr/bin/env node
/**
 * Orphan cleanup — reclaim what deletion flows leave behind (dry-run by default).
 *
 * Deletion on the platform is deliberately tombstone-shaped: delete-org flips
 * statuses (`tenants.status = 'deleting'`, `scopes.status = 'archived'`,
 * `hostnames.status = 'failed'`) and only the snapshot reaper hard-deletes
 * anything. That keeps the audit trail, but three kinds of debris accumulate:
 *
 *   1. HOSTNAME rows whose scope is archived, gone, or under a deleting tenant —
 *      routing config that can never serve again. Removed via the audited
 *      `DELETE /hostnames/:hostname` (unbindHostname).
 *   2. FORK scopes (snapshots/previews) the cron sweep never reaps: their parent
 *      is archived or gone, their tenant is deleting, or their expiry passed but
 *      the sweep hasn't caught up. Reaped via the orchestrated
 *      `DELETE /tenants/:t/scopes/:s` — fork-only below the seam, so a
 *      mislabeled row fails closed there.
 *   3. WfP DISPATCH SCRIPTS with no recorded version: deploy is upload-then-
 *      record (api.ts), so a failed record leaves a namespace script nothing
 *      references. Removed via the Cloudflare API (needs CLOUDFLARE_API_TOKEN).
 *
 * What it deliberately does NOT touch: tenant tombstones, archived primary
 * scopes and their DO storage, revoked tuples/entitlements — those are the
 * audit evidence the tombstone policy (K-21) exists to keep. They are REPORTED
 * (so a human can decide) but never deleted here.
 *
 * Auth + URL resolve like the substrat CLI (packages/cli/src/config.ts):
 *   URL:   --cp → SUBSTRAT_CP_URL → ~/.substrat/config.json
 *   auth:  SUBSTRAT_SERVICE_TOKEN → stored browser session → stored service token
 * The directory routes are staff-only, so run `substrat login` first.
 *
 * Usage:
 *   node tools/cleanup-orphans.mjs                 # dry run: report, delete nothing
 *   node tools/cleanup-orphans.mjs --apply         # actually delete
 *   --cp <url>            control-plane base URL (e.g. https://console.substrat.net)
 *   --namespace <name>    WfP dispatch namespace (default substrat-verticals)
 *   --skip-hostnames / --skip-forks / --skip-wfp   skip a phase
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const APPLY = flag('--apply');

// -- control-plane client (the CLI's resolve order, config.ts) ---------------

function loadCliConfig() {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.substrat', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

const cfg = loadCliConfig();
// The stored CLI URL already ends in /api (push.ts appends routes directly);
// a bare origin passed via --cp does not. Normalize to the origin either way.
const cpUrl = (opt('--cp') ?? process.env.SUBSTRAT_CP_URL ?? cfg.controlPlaneUrl)
  ?.replace(/\/$/, '')
  .replace(/\/api$/, '');
if (!cpUrl) {
  console.error('no control-plane URL — pass --cp, set SUBSTRAT_CP_URL, or run `substrat login`');
  process.exit(1);
}
const authHeader = process.env.SUBSTRAT_SERVICE_TOKEN
  ? { 'x-service-token': process.env.SUBSTRAT_SERVICE_TOKEN }
  : cfg.bearerToken
    ? { authorization: `Bearer ${cfg.bearerToken}` }
    : cfg.serviceToken
      ? { 'x-service-token': cfg.serviceToken }
      : undefined;
if (!authHeader) {
  console.error('not authenticated — run `substrat login`, or set SUBSTRAT_SERVICE_TOKEN');
  process.exit(1);
}

async function cp(method, path) {
  const res = await fetch(`${cpUrl}/api${path}`, { method, headers: authHeader });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.status === 204 ? undefined : res.json();
}

// -- gather the directory ----------------------------------------------------

console.log(`${APPLY ? 'CLEANUP' : 'DRY RUN'} against ${cpUrl}\n`);

const [tenants, scopes, hostnames] = await Promise.all([
  cp('GET', '/tenants'),
  cp('GET', '/scopes'),
  cp('GET', '/hostnames'),
]);
const tenantById = new Map(tenants.map((t) => [t.id, t]));
const scopeById = new Map(scopes.map((s) => [s.id, s]));
console.log(`directory: ${tenants.length} tenants, ${scopes.length} scopes, ${hostnames.length} hostnames`);

const now = new Date().toISOString();

// -- phase 1: orphaned forks (reap first — the reap also removes their hostnames)

const orphanForks = (flag('--skip-forks') ? [] : scopes)
  .filter((s) => s.forkedFrom !== null)
  .map((s) => {
    const parent = scopeById.get(s.forkedFrom);
    const reason =
      tenantById.get(s.tenantId)?.status === 'deleting' ? 'tenant is deleting'
      : !parent ? 'parent scope is gone'
      : parent.status === 'archived' ? 'parent scope is archived'
      : s.expiresAt !== null && s.expiresAt <= now ? `expired ${s.expiresAt}`
      : null;
    return reason ? { scope: s, reason } : null;
  })
  .filter(Boolean);
const reapedScopeIds = new Set(orphanForks.map((f) => f.scope.id));

// -- phase 2: orphaned hostname rows ------------------------------------------

const orphanHostnames = (flag('--skip-hostnames') ? [] : hostnames)
  // rows the fork reap removes on its own are not double-counted here
  .filter((h) => !reapedScopeIds.has(h.scopeId))
  .map((h) => {
    const scope = scopeById.get(h.scopeId);
    const reason =
      !scope ? 'scope is gone'
      : scope.status === 'archived' ? 'scope is archived'
      : tenantById.get(h.tenantId)?.status === 'deleting' ? 'tenant is deleting'
      : null;
    return reason ? { row: h, reason } : null;
  })
  .filter(Boolean);

// -- phase 3: orphaned WfP dispatch scripts -----------------------------------

const cfToken = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN;
const cfAccount = process.env.CLOUDFLARE_ACCOUNT_ID ?? '8cbb7553a78d4d4bc4159906c77214a3';
const namespace = opt('--namespace') ?? 'substrat-verticals';
let orphanScripts = [];
let wfpNote = '';
if (flag('--skip-wfp')) {
  wfpNote = 'skipped (--skip-wfp)';
} else if (!cfToken) {
  wfpNote = 'skipped — set CLOUDFLARE_API_TOKEN to include dispatch scripts';
} else {
  const verticals = await cp('GET', '/verticals');
  const versionLists = await Promise.all(
    verticals.map((v) => cp('GET', `/verticals/${encodeURIComponent(v.slug)}/versions`)),
  );
  const recordedRefs = new Set(
    versionLists.flat().map((v) => v.deploymentRef).filter((r) => r != null),
  );
  const cfBase = `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/workers/dispatch/namespaces/${namespace}`;
  const cfHeaders = { authorization: `Bearer ${cfToken}` };
  const listed = await fetch(`${cfBase}/scripts?per_page=1000`, { headers: cfHeaders });
  if (!listed.ok) {
    wfpNote = `skipped — CF list scripts failed (${listed.status})`;
  } else {
    const scripts = (await listed.json()).result ?? [];
    orphanScripts = scripts
      .map((s) => s.id ?? s.script_name ?? s.name)
      .filter((name) => name && !recordedRefs.has(name));
    wfpNote = `${scripts.length} scripts in '${namespace}', ${recordedRefs.size} recorded versions`;
  }
}

// -- report -------------------------------------------------------------------

const list = (title, items, render) => {
  console.log(`\n${title}: ${items.length}`);
  for (const item of items) console.log(`  - ${render(item)}`);
};

list('orphaned forks (reap: storage + directory row + hostnames)', orphanForks,
  (f) => `${f.scope.id} (tenant ${f.scope.tenantId}, slug '${f.scope.slug}') — ${f.reason}`);
list('orphaned hostname rows (unbind)', orphanHostnames,
  (h) => `${h.row.hostname} [${h.row.status}] → scope ${h.row.scopeId} — ${h.reason}`);
console.log(`\norphaned dispatch scripts: ${orphanScripts.length}${wfpNote ? ` (${wfpNote})` : ''}`);
for (const name of orphanScripts) console.log(`  - ${name}`);

// Report-only: debris a human should look at, but that the tombstone policy
// (K-21) says a script must not delete on its own.
const deletingTenants = tenants.filter((t) => t.status === 'deleting');
const pinnedForks = scopes.filter(
  (s) => s.forkedFrom !== null && s.expiresAt === null && !reapedScopeIds.has(s.id),
);
if (deletingTenants.length) {
  list('report only — tenant tombstones (kept by design)', deletingTenants, (t) => {
    const live = scopes.filter((s) => s.tenantId === t.id && s.status !== 'archived').length;
    return `${t.id} '${t.slug}' — ${live} non-archived scope(s) remain`;
  });
}
if (pinnedForks.length) {
  list('report only — never-expiring forks (set an expiry or delete deliberately)', pinnedForks,
    (s) => `${s.id} (tenant ${s.tenantId}, slug '${s.slug}', forked ${s.forkedAt})`);
}

// -- apply --------------------------------------------------------------------

const total = orphanForks.length + orphanHostnames.length + orphanScripts.length;
if (total === 0) {
  console.log('\nnothing to clean up.');
  process.exit(0);
}
if (!APPLY) {
  console.log(`\ndry run — ${total} orphan(s) found; re-run with --apply to delete them.`);
  process.exit(0);
}

let failed = 0;
const attempt = async (label, fn) => {
  try {
    await fn();
    console.log(`  deleted ${label}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAILED ${label}: ${err.message}`);
  }
};

if (orphanForks.length) {
  console.log('\nreaping orphaned forks…');
  for (const { scope } of orphanForks) {
    await attempt(`fork ${scope.id}`, () =>
      cp('DELETE', `/tenants/${scope.tenantId}/scopes/${scope.id}`));
  }
}
if (orphanHostnames.length) {
  console.log('\nunbinding orphaned hostnames…');
  for (const { row } of orphanHostnames) {
    await attempt(`hostname ${row.hostname}`, () =>
      cp('DELETE', `/hostnames/${encodeURIComponent(row.hostname)}`));
  }
}
if (orphanScripts.length) {
  console.log(`\ndeleting orphaned dispatch scripts from '${namespace}'…`);
  for (const name of orphanScripts) {
    await attempt(`script ${name}`, async () => {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/workers/dispatch/namespaces/${namespace}/scripts/${encodeURIComponent(name)}?force=true`,
        { method: 'DELETE', headers: { authorization: `Bearer ${cfToken}` } },
      );
      if (!res.ok) throw new Error(`CF delete → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    });
  }
}

console.log(failed ? `\ndone with ${failed} failure(s) — re-run to retry (everything here is idempotent).`
                   : '\ndone.');
process.exit(failed ? 1 : 0);
