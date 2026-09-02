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
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { loadConfig, saveConfig, resolveAuth } from './config.js';
import { browserLogin } from './login.js';
import { push, readVerticalMeta, nextVersion, previewVersion, pinTenant, assertLayerRules } from './push.js';
import { printVersions } from './versions.js';
import { promote, type PromoteResult } from './promote.js';
import { setListing, requestPublish } from './listing.js';
import { fetchWhoami } from './whoami.js';
import { cliVersion, warnIfDistStale } from './version.js';
import { pullScope, restoreScope, resolveTenantId, adoptScopeServing, adoptVerticalServing, provisionScope, rebindScopeVertical, bindScopeVersion, scopeStatus } from './scope.js';
import { printInstalls } from './installs.js';
import { createPreview, deletePreview, listPreviews, formatPreviews, parseTtlHours } from './preview.js';
import { writeCiWorkflow, detectDefaultBranch, nextStepsMessage } from './init.js';
import { writeModelView } from './model.js';
import {
  listVerticalHostnames,
  bindSurfaceHostname,
  bindScopeHostname,
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

/**
 * The nth positional argument after the command word, skipping flags AND their values.
 *
 * Commands whose optional `[dir]` sits at a fixed index can read `argv[n]` directly, but
 * `init --ci github [dir]` cannot: the directory follows a flag that takes a value, so a
 * fixed index lands on `--ci` and silently falls back to `.` — which means writing the
 * generated file into whatever repo you happened to be standing in. `boolean` names the
 * flags that take no value, so their successor is still a positional.
 */
function positional(n: number, booleanFlags: readonly string[] = []): string | undefined {
  const found: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith('--')) {
      if (!booleanFlags.includes(tok.slice(2))) i++; // skip this flag's value
      continue;
    }
    found.push(tok);
  }
  return found[n];
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
  substrat push     [dir] [--promote prod]     push a vertical (slug/name/version default
                                               from package.json; version auto-bumps);
                                               --promote prod points the serving channel at
                                               it in the same run (merge-to-main deploys
                                               with --promote prod). A push that would CREATE
                                               a new lineage next to a same-named one
                                               (another owner) is refused — pass
                                               --allow-fork to do it deliberately.
                                               A UI (app/) that nothing in the manifest
                                               would serve is refused too — declare
                                               runtimeNeeds.assets, or --allow-unserved-ui.
                                               The layer rules (boundary-lint R1–R8) run on
                                               the source before the build and a violation
                                               refuses the push; --skip-lint deploys
                                               ungated code deliberately
  substrat promote  <slug> --version <versionId>
                    [--ack-permissions] [--ack-migrations]  (prod is the only channel)
  substrat publish  <slug>                    request listing on the public marketplace (staff reviews)
  substrat unpublish <slug>                   remove from the public marketplace (staff)
  substrat versions <slug>                    list a vertical's versions + channels
  substrat installs <slug>                    list this workspace's installs of a vertical
                                              (directory status + served hostname; #424)
  substrat scope status <scopeId>             one scope's directory truth: status, bound
                                              version, serving script, role health
  substrat scope pull <scopeId> [--full] [--out <dir>]
                                              pull a scope's data to a local SQLite file
                                              (pseudonymized by default; --full is
                                              break-glass, audited server-side;
                                              'global' scopes only)
  substrat scope restore <scopeId> --file <backup>
                                              load a backup into an existing hosted scope,
                                              REPLACING its data (a pull's .sqlite, a local
                                              adapter-sqlite scope file, or a .dump.json)
  substrat scope adopt-serving <scopeId>      migrate a legacy scope onto its vertical's
                                              stable serving script so promotes stop
                                              stranding its data (idempotent). Use
                                              --vertical <slug> to backfill every scope.
  substrat scope bind <scopeId> --version <id> [--snapshot]
                                              pin ONE scope to a version of the same
                                              vertical — the per-scope rollout primitive
                                              (canary a tenant, pin a tenant behind the
                                              fleet). --snapshot archives the pre-migration
                                              data first when the bind crosses a migration
                                              boundary (the rollback point)
  substrat scope domain <scopeId> --domain <fqdn> [--surface app] [--canonical]
                                              bind a custom domain to ANY owned scope — a
                                              prod app, a preview, or a long-lived test
                                              env (crm-test.ahero.se). Walks DNS/cert
                                              issuance; --canonical makes it the surface's
                                              primary URL (default: an additive alias)
  substrat scope rebind <scopeId> --to <vertical>
                                              move a scope onto a DIFFERENT vertical
                                              lineage's serving script, data carried
                                              (staff; --ack-migrations to cross a
                                              differing migration surface;
                                              --abandon-data for a source script that
                                              predates /internal/export — directory-only
                                              flip, then re-provision the scope)
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
                    [--source-scope <id>] [--empty] [--ttl 72h|none] [--surface app] [--refresh]
                                              prod on its own --<tag> URL (private
                                              verticals only). --empty provisions a clean-room
                                              scope instead of forking prod (a vertical's first
                                              environment, before any prod scope exists).
                                              Re-running the same --tag rebinds the new push
                                              onto the same scope and renews its TTL; --refresh
                                              re-forks from prod. --ttl is the GC backstop
                                              (default 72h; 'none' pins the preview until deleted)
  substrat preview delete --tag <tag> [--slug <s>]  reap a preview (idempotent)
  substrat preview ls [--slug <s>]            list a vertical's active previews
  substrat model view [dir|model.json]        render the entity model as a self-contained
                    [--out <file>]            HTML page — entities, keys, parent edges,
                                              erasable fields flagged — and print its path;
                                              open it in a browser. Reads the checked-in
                                              model.json, so it needs no login and no push.
                                              Writes a temp file unless --out places it
  substrat init --ci github [dir]             write .github/workflows/substrat-deploy.yml —
                    [--branch <b>] [--path <packageDir>] [--release trunk|changesets]
                    [--out <path>] [--force]
                                              the same workflow the dashboard's one-click CI
                                              setup commits: merge deploys prod, a PR gets a
                                              preview + its URL commented, closing it reaps.
                                              --release changesets when the repo owns its
                                              version (only a version move releases)

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
PRIVATE vertical's push lands ADMITTED and prod (the one serving channel) is self-serve,
so '--promote prod' is a complete deploy. Once a vertical is LISTED on the marketplace its
pushes land PENDING and prod promotion + admission are a staff decision again. A promotion
that changes the permission or migration surface is refused until the change is
acknowledged (--ack-permissions / --ack-migrations) — read the diff it names first. For a
non-prod environment, run the version against a copy of the data with 'substrat preview
create' — dev/staging channels were retired (#509).

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
  // The layer rules first (#955) — before authentication and before the registry round-trip
  // that picks the next version. `push()` runs them too (the gate belongs to the push, not to
  // one command's argument handling); running them here as well is what keeps a violating
  // tree from spending a network call first, where a failed one would stand in place of the
  // diagnostic. The receipt is what keeps the two calls from being two scans — see
  // assertLayerRules.
  const linted = assertLayerRules(dir, argv.includes('--skip-lint'));

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
    // A UI the push would never serve is refused (#881); this says the app/ in the tree
    // is deliberately not part of this deploy.
    allowUnservedUi: argv.includes('--allow-unserved-ui'),
    // The layer rules run on every push (#955); this deploys code they never saw, and
    // says so in the push's own output. `linted` is the pre-flight above, so `push()`
    // does not scan the same tree twice.
    skipLint: argv.includes('--skip-lint'),
    linted,
    envSpec: meta.envSpec,
    ownerGrants: meta.ownerGrants,
    entitlements: meta.entitlements,
    provides: meta.provides,
    requires: meta.requires,
    provisions: meta.provisions,
    sendsEmail: meta.sendsEmail,
    usesModels: meta.usesModels,
    surfaces: meta.surfaces,
    outbound: meta.outbound,
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
    reportStoreBackfill(ch);
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

/**
 * `substrat installs <slug>` — the workspace's installs of one vertical, from the
 * directory (#424 CLI parity). Tenant-narrowed server-side for a builder session;
 * staff pass --tenant to act for one workspace.
 */
async function cmdInstalls(): Promise<void> {
  const slug = argv[1];
  if (!slug || slug.startsWith('--')) {
    console.error('usage: substrat installs <slug> [--tenant <id-or-slug>]');
    process.exit(1);
  }
  const { controlPlaneUrl, header } = resolveAuth({ cp: flag('cp'), token: flag('token'), tenant: flag('tenant') });
  const tenantId = await resolveTenantId(
    controlPlaneUrl,
    header,
    flag('tenant') ?? process.env.SUBSTRAT_TENANT ?? loadConfig().defaultTenant,
  );
  await printInstalls(controlPlaneUrl, header, tenantId, slug);
}

async function cmdPromote(): Promise<void> {
  const slug = argv[1];
  // `prod` is the only channel (#509 retired dev/staging), so --channel is optional and
  // defaults to it; a non-prod value still passes through and the control plane refuses it.
  const channel = flag('channel') ?? 'prod';
  const version = flag('version');
  if (!slug || slug.startsWith('--') || !version) {
    console.error('usage: substrat promote <slug> --version <versionId> [--ack-permissions] [--ack-migrations]');
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
  reportStoreBackfill(ch);
}

/**
 * Report what a promote minted for tenants that predate the declaration (#825). Silent
 * unless something happened: a version that declares no new store says nothing, a version
 * that declares one names each tenant it was minted for, and a backfill the platform could
 * not complete is a loud warning with the per-scope retry — never a silent gap that
 * surfaces later as a runtime throw in production.
 */
function reportStoreBackfill(result: PromoteResult): void {
  const backfill = result.storeBackfill;
  if (!backfill) return;
  for (const s of backfill.minted) {
    console.log(`  + minted ${s.binding} (${s.kind}) for tenant ${s.tenantId}`);
  }
  if (backfill.otherTenants) {
    console.log(`  + declared store(s) minted for ${backfill.otherTenants} other installed tenant(s)`);
  }
  if (backfill.error) {
    console.error(
      `\n⚠ declared store(s) could NOT be minted for every installed tenant: ${backfill.error}\n` +
        '  Those tenants will fail at first use. Retry with `substrat promote` again, or per\n' +
        '  scope with `substrat scope provision <scopeId>`; `substrat scope status` shows the gap.',
    );
  }
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
    '       substrat scope status <scopeId> [--tenant <id-or-slug>]\n' +
    '       substrat scope provision <scopeId> [--tenant <id-or-slug>]\n' +
    '       substrat scope adopt-serving <scopeId> [--tenant <id-or-slug>]\n' +
    '       substrat scope adopt-serving --vertical <slug>\n' +
    '       substrat scope bind <scopeId> --version <versionId> [--snapshot] [--tenant <id-or-slug>]\n' +
    '       substrat scope domain <scopeId> --domain <fqdn> [--surface app] [--canonical] [--tenant <id-or-slug>]\n' +
    '       substrat scope rebind <scopeId> --to <vertical> [--ack-migrations] [--abandon-data] [--tenant <id-or-slug>]';
  const known =
    sub === 'pull' || sub === 'restore' || sub === 'status' || sub === 'provision' ||
    sub === 'adopt-serving' || sub === 'bind' || sub === 'domain' || sub === 'rebind';
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
  if (sub === 'status') {
    await scopeStatus({ controlPlaneUrl, header, tenantId, scopeId: scope });
    return;
  }
  if (sub === 'adopt-serving') {
    await adoptScopeServing({ controlPlaneUrl, header, tenantId, scopeId: scope });
    return;
  }
  if (sub === 'bind') {
    const version = flag('version');
    if (!version) {
      console.error(usage);
      process.exit(1);
    }
    await bindScopeVersion({
      controlPlaneUrl, header, tenantId, scopeId: scope,
      versionId: version, snapshot: argv.includes('--snapshot'),
    });
    return;
  }
  if (sub === 'domain') {
    const domain = flag('domain');
    if (!domain) {
      console.error(usage);
      process.exit(1);
    }
    const surface = flag('surface') ?? 'app';
    const bound = await bindScopeHostname({
      controlPlaneUrl, header, tenantId, scopeId: scope, surface, domain,
      canonical: argv.includes('--canonical'),
    });
    if (bound.status === 'active') {
      console.log(`✓ https://${bound.hostname} serves scope ${scope} (surface '${surface}')`);
    } else {
      console.log(`✓ ${bound.hostname} recorded (${bound.status}) on scope ${scope}, surface '${surface}'`);
      console.log('  it goes live once DNS validation and certificate issuance complete');
      const records = formatDnsRecords(bound.validationRecords ?? []);
      if (records) console.log(records);
    }
    return;
  }
  if (sub === 'rebind') {
    const to = flag('to');
    if (!to) {
      console.error(usage);
      process.exit(1);
    }
    await rebindScopeVertical({
      controlPlaneUrl, header, tenantId, scopeId: scope,
      vertical: to, ackMigrations: argv.includes('--ack-migrations'),
      abandonData: argv.includes('--abandon-data'),
    });
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
    // Only "zero or not" matters here, so one entry of the paged list answers it.
    const versions = await fetch(`${base}/verticals/${encodeURIComponent(slug)}/versions?limit=1`, { headers: header })
      .then((r) => (r.ok ? (r.json() as Promise<{ entries: unknown[] }>) : { entries: [] }))
      .then((page) => page.entries ?? [])
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
    'usage: substrat preview create [dir] --tag <tag> [--source-scope <id>] [--empty] [--ttl 72h|none] [--surface <s>] [--refresh]\n' +
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
    // Same gate, same reason as `cmdPush` (#955): a preview runs the same code on the same
    // runtime, and the refusal should arrive before the registry round-trip below.
    const linted = assertLayerRules(dir, argv.includes('--skip-lint'));
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
    // Preview pushes default to a FREE prerelease label (`<base>-<tag>.<n>`), not a real
    // registry coordinate — an explicit --version still wins (issue #509 ask (e)).
    const version =
      flag('version') ?? (await previewVersion(controlPlaneUrl, header, versionSlugs, meta.versionSeed, tag));
    console.log(`pushing ${slug}@${version} for preview '${tag}' …`);
    const pushed = await push({
      dir, slug, version, name: meta.name, tenant,
      // A preview runs the same code on the same runtime, so it is gated the same (#955),
      // by the pre-flight above — whose receipt keeps this from re-scanning the tree.
      skipLint: argv.includes('--skip-lint'),
      linted,
      envSpec: meta.envSpec,
      ownerGrants: meta.ownerGrants,
      entitlements: meta.entitlements,
      provides: meta.provides,
      requires: meta.requires,
      provisions: meta.provisions,
      sendsEmail: meta.sendsEmail,
      usesModels: meta.usesModels,
      surfaces: meta.surfaces,
      outbound: meta.outbound,
      controlPlaneUrl, authHeader: header,
    });
    const empty = argv.includes('--empty');
    const created = await createPreview({
      controlPlaneUrl, header,
      slug: pushed.verticalSlug ?? slug,
      tag,
      versionId: pushed.id,
      ...(empty ? { empty: true } : {}),
      ...(flag('source-scope') ? { sourceScopeId: flag('source-scope')! } : {}),
      // `--ttl none` → null (pinned); omitted → undefined (72h default). Both differ from a number.
      ...((ttlHours) => (ttlHours !== undefined ? { ttlHours } : {}))(parseTtlHours(flag('ttl'))),
      ...(flag('surface') ? { surface: flag('surface')! } : {}),
      refresh: argv.includes('--refresh'),
    });
    console.log(`✓ preview '${tag}' ${created.reused ? 'updated' : 'created'} → ${created.url}`);
    console.log(
      `  scope ${created.scopeId} runs version ${created.versionId} against ${empty ? 'an empty clean-room scope' : 'a fork of prod'}`,
    );
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

/**
 * `substrat init --ci github` — generate the repo's deploy workflow.
 *
 * Deliberately OFFLINE: it never authenticates and never calls the control plane, so it
 * works in a fresh repo before the vertical exists and before a token is minted. The one
 * value it cannot derive — the control-plane URL — falls back to the stored config, then to
 * the public default.
 */
async function cmdInit(): Promise<void> {
  const ci = flag('ci');
  if (ci !== 'github') {
    console.error(
      'usage: substrat init --ci github [dir] [--slug <slug>] [--branch <branch>]\n' +
        '                                [--path <packageDir>] [--release trunk|changesets]\n' +
        '                                [--out <path>] [--force]\n' +
        (ci ? `\n'--ci ${ci}' is not supported — GitHub Actions is the only generator today.` : ''),
    );
    process.exit(1);
  }
  // `[dir]` is the repo root; the vertical's package.json is read from it for the slug.
  // It trails `--ci github`, so it must be found by skipping flag values — not by index.
  const dir = positional(0, ['force']) ?? '.';
  // `--path` is the vertical's directory INSIDE the repo (monorepo): the workflow builds
  // there, and the slug defaults from THAT package.json, not the repo root's.
  const packageDir = flag('path');
  const slug = flag('slug') ?? readVerticalMeta(packageDir ? join(dir, packageDir) : dir).slug;
  if (!slug) {
    console.error('no --slug given and none in package.json — add `"substrat": { "slug": "…" }` or pass --slug');
    process.exit(1);
  }
  const releaseFlag = flag('release') ?? 'trunk';
  if (releaseFlag !== 'trunk' && releaseFlag !== 'changesets') {
    console.error(`--release must be 'trunk' or 'changesets' (got '${releaseFlag}')`);
    process.exit(1);
  }
  const branch = flag('branch') ?? detectDefaultBranch(dir);
  const cpUrl = (flag('cp') ?? loadConfig().controlPlaneUrl ?? 'https://console.substrat.net/api').replace(/\/$/, '');

  const { file, overwritten } = writeCiWorkflow({
    dir, slug, branch, cpUrl,
    release: releaseFlag,
    force: argv.includes('--force'),
    ...(flag('out') ? { path: flag('out')! } : {}),
    ...(packageDir ? { packageDir } : {}),
  });
  console.log(`✓ ${overwritten ? 'replaced' : 'wrote'} ${file}`);
  console.log(`  ${slug}${packageDir ? ` (${packageDir})` : ''} · deploys on push to '${branch}' · control plane ${cpUrl}`);
  process.stdout.write(nextStepsMessage(slug, releaseFlag));
}

/**
 * `substrat model view [dir|model.json] [--out <file>]` — the entity model, to look at.
 *
 * No control plane and no auth: it reads the checked-in `model.json` off the disk, so it
 * works at the design gate, before anything has been pushed. The path is printed on its
 * own last line — that is the click target, and `| tail -1` for a script.
 */
async function cmdModel(): Promise<void> {
  const sub = argv[1];
  if (sub !== 'view') {
    console.error(
      'usage: substrat model view [dir|model.json] [--out <file>]' +
        (sub && !sub.startsWith('--') ? `\n\n'model ${sub}' is not a subcommand — 'view' is the only one.` : ''),
    );
    process.exit(1);
  }
  // positional(0) is 'view' itself; the target trails it and may follow `--out <file>`.
  const target = positional(1) ?? '.';
  const { file, entities } = await writeModelView(target, { ...(flag('out') ? { out: flag('out')! } : {}) });
  console.log(`✓ ${entities} ${entities === 1 ? 'entity' : 'entities'} rendered — open it in a browser:`);
  console.log(file);
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
  // #386: in the monorepo the bin is a symlink into dist/ — say up front when that
  // build is older than src, so a stale-build failure is never chased as a real one.
  warnIfDistStale();
  const command = argv[0];
  switch (command) {
    case 'login':
      return cmdLogin();
    case 'versions':
      return cmdVersions();
    case 'installs':
      return cmdInstalls();
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
    case 'init':
      return cmdInit();
    case 'model':
      return cmdModel();
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
  // The `error:` prefix is load-bearing: a push's build step runs wrangler, whose own
  // chatter (`--dry-run: exiting now.`) precedes this line — an unprefixed message after
  // it reads as more narration, not as the reason the command failed.
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
