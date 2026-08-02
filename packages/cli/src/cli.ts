#!/usr/bin/env node
/**
 * substrat — authenticated deploy tooling for the platform.
 *
 *   substrat login  [--cp <url>] [--token <serviceToken>]
 *   substrat push   [dir]  [--slug <slug>] [--version <v>] [--name <name>]
 *                   [--cp <url>] [--token <serviceToken>]
 *
 * `push` defaults dir to '.', slug/name from the vertical's package.json (`substrat` block
 * or derived), and version to the registry's latest patch-bumped — flags override each.
 * The workspace a push acts for comes from the project (`substrat.tenant`, --tenant, or
 * SUBSTRAT_TENANT), never the machine-wide login default — see cmdPush.
 *
 * Auth is a service token (the control plane's SERVICE_TOKEN), sent as x-service-token
 * and resolved to the platform's service actor. `login` stores it in ~/.substrat/config.json
 * so `push` just works; any command also accepts --cp/--token or SUBSTRAT_CP_URL /
 * SUBSTRAT_SERVICE_TOKEN. A push is not a deploy — the version lands PENDING; admission
 * (in the console) still gates serving.
 */
import { createInterface } from 'node:readline';
import { loadConfig, saveConfig, resolveAuth } from './config.js';
import { browserLogin } from './login.js';
import { push, readVerticalMeta, nextVersion, pinTenant } from './push.js';
import { printVersions } from './versions.js';
import { promote } from './promote.js';
import { setListing, requestPublish } from './listing.js';
import { fetchWhoami } from './whoami.js';
import { cliVersion } from './version.js';
import { pullScope, restoreScope, resolveTenantId, adoptScopeServing, adoptVerticalServing, provisionScope } from './scope.js';
import { createPreview, deletePreview, listPreviews, formatPreviews, parseTtlHours } from './preview.js';
import {
  listVerticalHostnames,
  bindSurfaceHostname,
  unbindHostname,
  verifyHostname,
  formatHostnames,
  formatDnsRecords,
} from './hostnames.js';

const argv = process.argv.slice(2);

/** `--name value` → value, else undefined. */
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Prompt on the TTY for a plain (non-secret) value. */
function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const USAGE = `substrat — authenticated deploy tooling

Usage:
  substrat login    [--cp <url>] [--fresh]    sign in via the browser (per-human);
                                              --fresh re-prompts past any live browser
                                              or IdP session (switch accounts)
  substrat login    --token <serviceToken>    store a service credential (CI)
  substrat whoami                             show who you are + your workspaces
  substrat workspaces                         list your workspaces (alias of whoami)
  substrat version                            print the CLI version (also --version, -v)
  substrat push     [dir] [--promote <channel>] push a vertical (slug/name/version default
                                               from package.json; version auto-bumps);
                                               --promote points the channel at it in the
                                               same run (merge-to-main deploys with
                                               --promote prod). A push that would CREATE
                                               a new lineage next to a same-named one
                                               (another owner) is refused — pass
                                               --allow-fork to do it deliberately
  substrat promote  <slug> --channel dev|staging|prod --version <versionId>
                    [--ack-permissions] [--ack-migrations]
  substrat publish  <slug>                    request listing on the public marketplace (staff reviews)
  substrat unpublish <slug>                   remove from the public marketplace (staff)
  substrat versions <slug>                    list a vertical's versions + channels
  substrat scope pull <scopeId> [--full] [--out <dir>]
                                              pull a scope's data to a local SQLite file
                                              (masked by default; --full is break-glass,
                                              audited server-side; 'global' scopes only)
  substrat scope restore <scopeId> --file <backup>
                                              load a backup into an existing hosted scope,
                                              REPLACING its data (a pull's .sqlite, a local
                                              adapter-sqlite scope file, or a .dump.json)
  substrat scope adopt-serving <scopeId>      migrate a legacy scope onto its vertical's
                                              stable serving script so promotes stop
                                              stranding its data (idempotent). Use
                                              --vertical <slug> to backfill every scope.
  substrat hostnames <slug>                   list an install's hostname bindings
  substrat hostnames bind <slug> --surface <s> [--domain <d>] [--scope <id>]
                                              give a surface a URL: no --domain mints a
                                              platform hostname (live immediately);
                                              --domain records a custom domain (pending
                                              until DNS validation completes)
  substrat hostnames verify <hostname>        re-poll a custom domain's DNS/cert issuance
                                              and print any records still to publish
  substrat hostnames unbind <hostname>        remove a binding (the surface's canonical
                                              flag moves only when you bind a new one)
  substrat preview create [dir] --tag <tag>   push this tree and run it against a FORK of
                    [--source-scope <id>] [--ttl 72h] [--surface app] [--refresh]
                                              prod on its own --<tag> URL (private
                                              verticals only). Re-running the same --tag
                                              rebinds the new push onto the same fork;
                                              --refresh re-forks from prod. --ttl is the
                                              GC backstop (default 72h)
  substrat preview delete --tag <tag> [--slug <s>]  reap a preview (idempotent)
  substrat preview ls [--slug <s>]            list a vertical's active previews

'substrat push' defaults everything from the vertical's package.json — run it from inside the
directory with no flags. Override any of: --slug, --name, --version. The slug/name come from a
"substrat": { "slug", "name" } block (else derived from the package name); --version omitted
means "the registry's latest, patch-bumped".

Options (any command):
  --cp <url>       control-plane API base, e.g. https://console.substrat.net/api
  --token <tok>    the control plane's SERVICE_TOKEN (service-actor credential, for CI)
  --tenant <t>     the workspace to act for (id or slug); a builder never types the
                   '<tenant>/' slug prefix — the control plane forms it. For push:
                   --tenant → SUBSTRAT_TENANT → package.json "substrat": { "tenant" }
                   (the pin; first push offers to write it) — never the login default,
                   since the first push of a slug claims it for a workspace. Other
                   commands fall back to the workspace stored at login.

A builder pushes a BARE --slug; the control plane forms '<tenantSlug>/<slug>' (§5). A
PRIVATE vertical's push lands ADMITTED and every channel is self-serve — prod included —
so '--promote prod' is a complete deploy. Once a vertical is LISTED on the marketplace its
pushes land PENDING and prod promotion + admission are a staff decision again. A promotion
that changes the permission or migration surface is refused until the change is
acknowledged (--ack-permissions / --ack-migrations) — read the diff it names first.

Auth resolves: explicit --token/SUBSTRAT_SERVICE_TOKEN → stored browser session →
stored service token. URL resolves flag → SUBSTRAT_CP_URL → ~/.substrat/config.json.

The control plane advertises the CLI's minimum-supported and latest versions on every
authenticated response; an out-of-date CLI prints a one-line upgrade nudge to stderr
(TTY only, so scripts and CI stay quiet).
`;

async function cmdLogin(): Promise<void> {
  const existing = loadConfig();
  const cpDefault = existing.controlPlaneUrl ?? 'https://console.substrat.net/api';
  const cp = ((flag('cp') ?? (await ask(`control-plane URL [${cpDefault}]: `))) || cpDefault).replace(/\/$/, '');

  // CI path: a service credential, no browser.
  const serviceToken = flag('token');
  if (serviceToken) {
    const path = saveConfig({ ...existing, controlPlaneUrl: cp, serviceToken });
    console.log(`✓ saved service credential → ${path}`);
    return;
  }

  // Default: browser loopback login → a per-human session token. `--fresh` forces a
  // real re-authentication (skips the browser's live session AND the IdP SSO cookie)
  // so signing in as a different account actually works.
  const bearerToken = await browserLogin(cp, { fresh: argv.includes('--fresh') });

  // Resolve the builder's workspace so `promote`/`scope` just work (builder-plane.md §5).
  // `push` never uses this default — its workspace is the project's (package.json pin).
  // One tenant → store it; several → pick; none → they still need to sign up in the app.
  const { user, tenants } = await fetchWhoami(cp, { authorization: `Bearer ${bearerToken}` }).catch(
    () => ({ user: null, tenants: [] as { id: string; slug: string; name: string }[] }),
  );
  let defaultTenant = existing.defaultTenant;
  if (tenants.length === 1) {
    defaultTenant = tenants[0]!.slug;
    console.log(`  workspace: ${defaultTenant}`);
  } else if (tenants.length > 1) {
    console.log('  you belong to several workspaces:');
    tenants.forEach((t, i) => console.log(`    ${i + 1}. ${t.name}  [${t.slug}]`));
    const pick = await ask(`  default workspace [1-${tenants.length}, or a slug]: `);
    defaultTenant =
      tenants[Number(pick) - 1]?.slug ??
      tenants.find((t) => t.slug === pick || t.id === pick)?.slug ??
      tenants[0]!.slug;
    console.log(`  default workspace: ${defaultTenant} (promote/scope use it; push pins one per project)`);
  } else if (user) {
    console.log('  no workspace yet — create one at your dashboard, then `substrat push`.');
  }
  const path = saveConfig({ ...existing, controlPlaneUrl: cp, bearerToken, defaultTenant });
  console.log(`✓ signed in${user?.email ? ` as ${user.email}` : ''}. session saved to ${path}`);
}

/**
 * The interactive workspace picker for a push with no pinned tenant. Lists the builder's
 * workspaces (whoami), auto-selects a sole one, and offers to pin the choice into the
 * project's package.json — so the question is answered once per project, not once per push.
 * Non-TTY (CI) refuses instead: a script must say which workspace it means.
 */
async function pickWorkspace(auth: { controlPlaneUrl: string; header: Record<string, string> }, dir: string): Promise<string> {
  const hint = 'add `"substrat": { "tenant": "…" }` to package.json, pass --tenant, or set SUBSTRAT_TENANT';
  if (!process.stdin.isTTY) {
    throw new Error(`no workspace selected — ${hint}`);
  }
  const { tenants } = await fetchWhoami(auth.controlPlaneUrl, auth.header);
  if (tenants.length === 0) {
    throw new Error('you have no workspace yet — create one in the dashboard, then push again');
  }
  let tenant: string;
  if (tenants.length === 1) {
    tenant = tenants[0]!.slug;
    console.log(`workspace: ${tenant} (your only one)`);
  } else {
    console.log('this project has no pinned workspace. you belong to:');
    tenants.forEach((t, i) => console.log(`  ${i + 1}. ${t.name}  [${t.slug}]`));
    const suggested = loadConfig().defaultTenant;
    const def = tenants.findIndex((t) => t.slug === suggested) + 1; // 0 = no login default among them
    const pick = await ask(`push as [1-${tenants.length}${def ? `, enter = ${def}` : ''}]: `);
    const chosen =
      (pick === '' && def ? tenants[def - 1] : undefined) ??
      tenants[Number(pick) - 1] ??
      tenants.find((t) => t.slug === pick || t.id === pick);
    if (!chosen) throw new Error(`'${pick}' is not one of your workspaces`);
    tenant = chosen.slug;
  }
  const pin = await ask(`pin '${tenant}' in package.json so this project always pushes there? [Y/n]: `);
  if (pin === '' || /^y/i.test(pin)) {
    try {
      pinTenant(dir, tenant);
      console.log(`✓ pinned — package.json now carries "substrat": { "tenant": "${tenant}" }`);
    } catch {
      console.log(`  (could not write ${dir}/package.json — ${hint})`);
    }
  }
  return tenant;
}

async function cmdPush(): Promise<void> {
  // Directory defaults to '.' — run `substrat push` from inside the vertical.
  const dir = argv[1] && !argv[1].startsWith('--') ? argv[1] : '.';

  // Slug + name default from the vertical's package.json (`substrat` block, else derived);
  // a flag still wins. So `cd demos/meridian && substrat push` needs no --slug/--name.
  const meta = readVerticalMeta(dir);
  const slug = flag('slug') ?? meta.slug;
  const name = flag('name') ?? meta.name;
  if (!slug) {
    console.error('no --slug given and none in package.json — add `"substrat": { "slug": "…" }` or pass --slug');
    process.exit(1);
  }
  // #399 prevention: a derived slug silently FOLLOWS a package rename, forking the
  // lineage (versions land under the new name while installs stay on the old). One
  // line per push until the project pins it.
  if (!flag('slug') && !meta.slugExplicit) {
    console.log(
      `note: slug '${slug}' is derived from the package name — pin it with ` +
        `\`"substrat": { "slug": "${slug}" }\` so a package rename cannot fork the lineage.`,
    );
  }

  // Which workspace the push acts for is the PROJECT's call: --tenant → SUBSTRAT_TENANT →
  // package.json `substrat.tenant`. Never the machine-wide login default — the first push
  // of a slug CLAIMS `<tenant>/<slug>` for whatever tenant resolved, so a silent global
  // fallback would claim it for the wrong owner. No pin → interactive pick (offering to
  // write one), non-TTY → refuse. A service token is the platform, not a builder — no
  // workspace involved.
  let tenant = flag('tenant') ?? process.env.SUBSTRAT_TENANT ?? meta.tenant;
  let auth = resolveAuth({ cp: flag('cp'), token: flag('token'), tenant, useDefaultTenant: false });
  if (auth.kind === 'session' && !tenant) {
    tenant = await pickWorkspace(auth, dir);
    auth = resolveAuth({ cp: flag('cp'), token: flag('token'), tenant, useDefaultTenant: false });
  }
  const { controlPlaneUrl, header, as } = auth;
  console.log(`authenticating with ${as}`);
  // Version defaults to the registry's latest, patch-bumped — no hand-tracking. --version
  // wins. A pinned push may land on `<tenant>/<slug>` or a legacy bare row the pin owns,
  // so both lineages feed the bump (nextVersion takes the max across them).
  const versionSlugs = tenant ? [`${tenant}/${slug}`, slug] : [slug];
  const version = flag('version') ?? (await nextVersion(controlPlaneUrl, header, versionSlugs, meta.versionSeed));
  console.log(`pushing ${tenant ? `${tenant}/` : ''}${slug}@${version}${name && name !== slug ? ` (${name})` : ''} …`);
  const v = await push({
    dir, slug, version, name, tenant,
    // The control plane refuses a push that would silently fork a same-named lineage
    // (#388); --allow-fork acknowledges a deliberate second lineage.
    allowFork: argv.includes('--allow-fork'),
    envSpec: meta.envSpec,
    ownerGrants: meta.ownerGrants,
    entitlements: meta.entitlements,
    provides: meta.provides,
    requires: meta.requires,
    surfaces: meta.surfaces,
    controlPlaneUrl, authHeader: header,
  });
  console.log(`✓ pushed ${v.verticalSlug ?? slug}. version ${v.id} (${version}) is ${v.admission}; deploymentRef=${v.deploymentRef}`);
  // Advisory, same spirit as the permission-surface gate: a bound surface the new
  // version stopped declaring keeps serving, but probably not what its users expect.
  for (const w of v.warnings ?? []) console.warn(`⚠ ${w}`);
  // `--promote <channel>` completes the deploy in the same run — the merge-to-main
  // workflow's shape. A private vertical's push is already admitted, so this succeeds
  // immediately; a listed vertical's lands pending and the refusal below names why.
  // Addressed by the REGISTRY id the deploy actually landed on (`verticalSlug`), not the
  // bare name — for staff the two differ, and effectiveSlug keeps the full id valid for
  // builders too.
  const promoteTo = flag('promote');
  if (promoteTo) {
    const ch = await promote({ controlPlaneUrl, header, slug: v.verticalSlug ?? slug, channel: promoteTo, versionId: v.id });
    console.log(`✓ ${v.verticalSlug ?? slug} → ${ch.channel} now points at ${version}`);
  } else if (v.admission === 'admitted') {
    console.log('  promote it to a channel to go live (or push with --promote prod).');
  } else {
    console.log('  admit it in the console to let a scope bind it.');
  }
}

async function cmdVersions(): Promise<void> {
  const slug = argv[1];
  if (!slug || slug.startsWith('--')) {
    console.error('usage: substrat versions <slug>');
    process.exit(1);
  }
  const { controlPlaneUrl, header } = resolveAuth({ cp: flag('cp'), token: flag('token'), tenant: flag('tenant') });
  // Best-effort: a tenant lets `versions` cross-check installs for a lineage fork (#399).
  // Absent or unresolvable, the listing still works — only the fork hint degrades.
  const tenantId = await resolveTenantId(controlPlaneUrl, header, flag('tenant')).catch(() => undefined);
  await printVersions(controlPlaneUrl, header, slug, tenantId);
}

async function cmdPromote(): Promise<void> {
  const slug = argv[1];
  const channel = flag('channel');
  const version = flag('version');
  if (!slug || slug.startsWith('--') || !channel || !version) {
    console.error('usage: substrat promote <slug> --channel dev|staging|prod --version <versionId> [--ack-permissions] [--ack-migrations]');
    process.exit(1);
  }
  const { controlPlaneUrl, header, as } = resolveAuth({ cp: flag('cp'), token: flag('token'), tenant: flag('tenant') });
  console.log(`authenticating with ${as}`);
  const acknowledge =
    argv.includes('--ack-permissions') || argv.includes('--ack-migrations')
      ? {
          ...(argv.includes('--ack-permissions') ? { permissionChange: true } : {}),
          ...(argv.includes('--ack-migrations') ? { migrationChange: true } : {}),
        }
      : undefined;
  const ch = await promote({ controlPlaneUrl, header, slug, channel, versionId: version, acknowledge });
  console.log(`✓ ${slug} → ${ch.channel} now points at ${ch.versionId}`);
}

async function cmdPublish(): Promise<void> {
  const slug = argv[1];
  if (!slug || slug.startsWith('--')) {
    console.error('usage: substrat publish <slug>');
    process.exit(1);
  }
  const { controlPlaneUrl, header, as } = resolveAuth({ cp: flag('cp'), token: flag('token'), tenant: flag('tenant') });
  console.log(`authenticating with ${as}`);
  await requestPublish({ controlPlaneUrl, header, slug });
  console.log(`✓ publish requested for ${slug} — a Substrat operator will review it`);
}

async function cmdUnpublish(): Promise<void> {
  const slug = argv[1];
  if (!slug || slug.startsWith('--')) {
    console.error('usage: substrat unpublish <slug>');
    process.exit(1);
  }
  const { controlPlaneUrl, header, as } = resolveAuth({ cp: flag('cp'), token: flag('token'), tenant: flag('tenant') });
  console.log(`authenticating with ${as}`);
  const r = await setListing({ controlPlaneUrl, header, slug, listed: false });
  console.log(`✓ ${r.slug} unpublished`);
}

async function cmdScope(): Promise<void> {
  const sub = argv[1];
  const scope = argv[2];
  const usage =
    'usage: substrat scope pull <scopeId> [--full] [--out <dir>] [--tenant <id-or-slug>]\n' +
    '       substrat scope restore <scopeId> --file <backup.sqlite|.dump.json> [--tenant <id-or-slug>]\n' +
    '       substrat scope provision <scopeId> [--tenant <id-or-slug>]\n' +
    '       substrat scope adopt-serving <scopeId> [--tenant <id-or-slug>]\n' +
    '       substrat scope adopt-serving --vertical <slug>';
  const known = sub === 'pull' || sub === 'restore' || sub === 'provision' || sub === 'adopt-serving';
  // adopt-serving --vertical takes no positional scopeId; every other form requires one.
  const wantsScope = !(sub === 'adopt-serving' && flag('vertical'));
  if (!known || (wantsScope && (!scope || scope.startsWith('--')))) {
    console.error(usage);
    process.exit(1);
  }
  const { controlPlaneUrl, header, as } = resolveAuth({ cp: flag('cp'), token: flag('token'), tenant: flag('tenant') });
  console.log(`authenticating with ${as}`);
  if (sub === 'adopt-serving' && flag('vertical')) {
    await adoptVerticalServing({ controlPlaneUrl, header, slug: flag('vertical')! });
    return;
  }
  // Past the vertical-wide branch, every form needs a scopeId (the guard above enforced it).
  if (!scope) {
    console.error(usage);
    process.exit(1);
  }
  const tenantId = await resolveTenantId(
    controlPlaneUrl,
    header,
    flag('tenant') ?? process.env.SUBSTRAT_TENANT ?? loadConfig().defaultTenant,
  );
  if (sub === 'adopt-serving') {
    await adoptScopeServing({ controlPlaneUrl, header, tenantId, scopeId: scope });
    return;
  }
  if (sub === 'provision') {
    await provisionScope({ controlPlaneUrl, header, tenantId, scopeId: scope });
    return;
  }
  if (sub === 'restore') {
    const file = flag('file');
    if (!file) {
      console.error(usage);
      process.exit(1);
    }
    await restoreScope({ controlPlaneUrl, header, tenantId, scopeId: scope, file });
    return;
  }
  await pullScope({
    controlPlaneUrl,
    header,
    tenantId,
    scopeId: scope,
    full: argv.includes('--full'),
    outDir: flag('out') ?? '.substrat',
  });
}

/**
 * Surface hostname bindings (K-26 multi-surface — the CLI half of the dashboard's
 * Domains tab). Tenant-narrowed server-side: a builder session or push token reaches
 * only its own workspace's rows; staff pass --tenant to act for one.
 */
async function cmdHostnames(): Promise<void> {
  const sub = argv[1];
  const usage =
    'usage: substrat hostnames <slug> [--tenant <id-or-slug>]\n' +
    '       substrat hostnames bind <slug> --surface <s> [--domain <d>] [--scope <id>] [--tenant <t>]\n' +
    '       substrat hostnames verify <hostname> [--tenant <t>]\n' +
    '       substrat hostnames unbind <hostname> [--tenant <t>]';
  const { controlPlaneUrl, header, as } = resolveAuth({ cp: flag('cp'), token: flag('token'), tenant: flag('tenant') });

  if (sub === 'unbind') {
    const hostname = argv[2];
    if (!hostname || hostname.startsWith('--')) {
      console.error(usage);
      process.exit(1);
    }
    console.log(`authenticating with ${as}`);
    await unbindHostname(controlPlaneUrl, header, hostname);
    console.log(`✓ ${hostname.toLowerCase()} unbound — requests to it stop resolving`);
    return;
  }

  if (sub === 'verify') {
    const hostname = argv[2];
    if (!hostname || hostname.startsWith('--')) {
      console.error(usage);
      process.exit(1);
    }
    console.log(`authenticating with ${as}`);
    const row = await verifyHostname(controlPlaneUrl, header, hostname);
    if (row.status === 'active') {
      console.log(`✓ https://${row.hostname} is live`);
    } else {
      console.log(`  ${row.hostname} is ${row.status}${row.statusNote ? ` — ${row.statusNote}` : ''}`);
      const records = formatDnsRecords(row.validationRecords ?? []);
      if (records) console.log(records);
    }
    return;
  }

  const slug = sub === 'bind' ? argv[2] : sub;
  if (!slug || slug.startsWith('--')) {
    console.error(usage);
    process.exit(1);
  }
  console.log(`authenticating with ${as}`);
  const tenantId = await resolveTenantId(
    controlPlaneUrl,
    header,
    flag('tenant') ?? process.env.SUBSTRAT_TENANT ?? loadConfig().defaultTenant,
  );

  if (sub === 'bind') {
    const surface = flag('surface');
    if (!surface) {
      console.error(usage);
      process.exit(1);
    }
    const domain = flag('domain');
    const bound = await bindSurfaceHostname({
      controlPlaneUrl, header, tenantId, slug, surface,
      ...(domain ? { domain } : {}),
      ...(flag('scope') ? { scope: flag('scope')! } : {}),
    });
    if (bound.status === 'active') {
      console.log(`✓ https://${bound.hostname} serves surface '${surface}'`);
    } else {
      console.log(`✓ ${bound.hostname} recorded (${bound.status}) for surface '${surface}'`);
      console.log('  it goes live once DNS validation and certificate issuance complete');
      const records = formatDnsRecords(bound.validationRecords ?? []);
      if (records) console.log(records);
    }
    return;
  }

  const rows = await listVerticalHostnames(controlPlaneUrl, header, tenantId, slug);
  console.log(formatHostnames(rows));
  if (rows.some((r) => r.canonical)) console.log('\n* = canonical for its (scope, surface)');
  // The reverse of the `versions` cross-check (#399): installs bound here but zero versions
  // pushed under this slug is a lineage fork. Best-effort — never breaks the listing.
  if (rows.length > 0) {
    const base = controlPlaneUrl.replace(/\/$/, '');
    const versions = await fetch(`${base}/verticals/${encodeURIComponent(slug)}/versions`, { headers: header })
      .then((r) => (r.ok ? (r.json() as Promise<unknown[]>) : []))
      .catch(() => []);
    if (Array.isArray(versions) && versions.length === 0) {
      console.log(
        `\n⚠ '${slug}' has hostnames but no pushed versions — a lineage fork: pushes landed under a different\n` +
          `  slug (\`substrat push\` derives it from package.json \`name\` unless \`substrat.slug\` pins it).`,
      );
    }
  }
}

/**
 * Per-PR preview instances (preview-and-snapshots.md §2/§9). `create` pushes the working
 * tree — so the bound version is exactly the PR's code — then forks prod and serves the
 * pair on a `--<tag>` URL. Private verticals only (their pushes self-admit); the server
 * refuses a listed vertical. `create` resolves its workspace like `push` (project pin) so
 * a preview lands in the same workspace; `delete`/`ls` fall back to the login default.
 */
async function cmdPreview(): Promise<void> {
  const sub = argv[1];
  const usage =
    'usage: substrat preview create [dir] --tag <tag> [--source-scope <id>] [--ttl 72h] [--surface <s>] [--refresh]\n' +
    '       substrat preview delete --tag <tag> [--slug <slug>]\n' +
    '       substrat preview ls [dir] [--slug <slug>]';
  const isDelete = sub === 'delete' || sub === 'rm' || sub === 'down';
  const isList = sub === 'ls' || sub === 'list';
  if (sub !== 'create' && !isDelete && !isList) {
    console.error(usage);
    process.exit(1);
  }

  if (sub === 'create') {
    const dir = argv[2] && !argv[2].startsWith('--') ? argv[2] : '.';
    const tag = flag('tag');
    if (!tag) {
      console.error(usage);
      process.exit(1);
    }
    const meta = readVerticalMeta(dir);
    const slug = flag('slug') ?? meta.slug;
    if (!slug) {
      console.error('no --slug given and none in package.json');
      process.exit(1);
    }
    // Workspace resolves exactly as `push` (project pin, never the login default) so the
    // preview push lands in the same workspace the vertical is owned by.
    let tenant = flag('tenant') ?? process.env.SUBSTRAT_TENANT ?? meta.tenant;
    let auth = resolveAuth({ cp: flag('cp'), token: flag('token'), tenant, useDefaultTenant: false });
    if (auth.kind === 'session' && !tenant) {
      tenant = await pickWorkspace(auth, dir);
      auth = resolveAuth({ cp: flag('cp'), token: flag('token'), tenant, useDefaultTenant: false });
    }
    const { controlPlaneUrl, header, as } = auth;
    console.log(`authenticating with ${as}`);
    const versionSlugs = tenant ? [`${tenant}/${slug}`, slug] : [slug];
    const version = flag('version') ?? (await nextVersion(controlPlaneUrl, header, versionSlugs, meta.versionSeed));
    console.log(`pushing ${slug}@${version} for preview '${tag}' …`);
    const pushed = await push({
      dir, slug, version, name: meta.name, tenant,
      envSpec: meta.envSpec,
      ownerGrants: meta.ownerGrants,
      entitlements: meta.entitlements,
      provides: meta.provides,
      requires: meta.requires,
      surfaces: meta.surfaces,
      controlPlaneUrl, authHeader: header,
    });
    const created = await createPreview({
      controlPlaneUrl, header,
      slug: pushed.verticalSlug ?? slug,
      tag,
      versionId: pushed.id,
      ...(flag('source-scope') ? { sourceScopeId: flag('source-scope')! } : {}),
      ...(parseTtlHours(flag('ttl')) ? { ttlHours: parseTtlHours(flag('ttl')) } : {}),
      ...(flag('surface') ? { surface: flag('surface')! } : {}),
      refresh: argv.includes('--refresh'),
    });
    console.log(`✓ preview '${tag}' ${created.reused ? 'updated' : 'created'} → ${created.url}`);
    console.log(`  scope ${created.scopeId} runs version ${created.versionId} against a fork of prod`);
    return;
  }

  if (isDelete) {
    const tag = flag('tag');
    if (!tag) {
      console.error(usage);
      process.exit(1);
    }
    const slug = flag('slug') ?? readVerticalMeta('.').slug;
    if (!slug) {
      console.error('no --slug given and none in package.json');
      process.exit(1);
    }
    const { controlPlaneUrl, header, as } = resolveAuth({ cp: flag('cp'), token: flag('token'), tenant: flag('tenant') });
    console.log(`authenticating with ${as}`);
    const r = await deletePreview({ controlPlaneUrl, header, slug, tag });
    console.log(r.deleted ? `✓ preview '${tag}' reaped (scope ${r.deleted})` : `preview '${tag}' was already gone`);
    return;
  }

  // ls
  const dir = argv[2] && !argv[2].startsWith('--') ? argv[2] : '.';
  const slug = flag('slug') ?? readVerticalMeta(dir).slug;
  if (!slug) {
    console.error('no --slug given and none in package.json');
    process.exit(1);
  }
  const { controlPlaneUrl, header } = resolveAuth({ cp: flag('cp'), token: flag('token'), tenant: flag('tenant') });
  console.log(formatPreviews(await listPreviews({ controlPlaneUrl, header, slug })));
}

async function cmdWhoami(): Promise<void> {
  const { controlPlaneUrl, header } = resolveAuth({ cp: flag('cp'), token: flag('token'), tenant: flag('tenant') });
  const { user, tenants } = await fetchWhoami(controlPlaneUrl, header);
  if (!user) {
    console.log('not signed in.');
    return;
  }
  console.log(`signed in as ${user.email ?? user.id}`);
  if (tenants.length === 0) console.log('  no workspaces yet.');
  for (const t of tenants) console.log(`  ${t.name}  [${t.slug}]`);
}

async function main(): Promise<void> {
  const command = argv[0];
  switch (command) {
    case 'login':
      return cmdLogin();
    case 'versions':
      return cmdVersions();
    case 'push':
      return cmdPush();
    case 'promote':
      return cmdPromote();
    case 'publish':
      return cmdPublish();
    case 'unpublish':
      return cmdUnpublish();
    case 'whoami':
    case 'workspaces':
      return cmdWhoami();
    case 'scope':
      return cmdScope();
    case 'hostnames':
      return cmdHostnames();
    case 'preview':
      return cmdPreview();
    case 'version':
    case '--version':
    case '-v':
      console.log(`substrat ${cliVersion()}`);
      return;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(USAGE);
      return;
    default:
      console.error(`unknown command '${command}'\n`);
      process.stdout.write(USAGE);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
