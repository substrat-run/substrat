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
import { push, readVerticalMeta, nextVersion } from './push.js';
import { printVersions } from './versions.js';
import { promote } from './promote.js';
import { fetchWhoami } from './whoami.js';

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
  substrat login    [--cp <url>]              sign in via the browser (per-human)
  substrat login    --token <serviceToken>    store a service credential (CI)
  substrat whoami                             show who you are + your workspaces
  substrat push     [dir]                      push a vertical (slug/name/version default
                                               from package.json; version auto-bumps)
  substrat promote  <slug> --channel dev|staging --version <versionId>
  substrat versions <slug>                    list a vertical's versions + channels

'substrat push' defaults everything from the vertical's package.json — run it from inside the
directory with no flags. Override any of: --slug, --name, --version. The slug/name come from a
"substrat": { "slug", "name" } block (else derived from the package name); --version omitted
means "the registry's latest, patch-bumped".

Options (any command):
  --cp <url>       control-plane API base, e.g. https://console.substrat.net/api
  --token <tok>    the control plane's SERVICE_TOKEN (service-actor credential, for CI)
  --tenant <t>     the workspace to act for (id or slug); a builder never types the
                   '<tenant>/' slug prefix — the control plane forms it. Defaults to the
                   one stored at login (SUBSTRAT_TENANT overrides).

A builder pushes a BARE --slug; the control plane forms '<tenantSlug>/<slug>' (§5). A push
lands a version PENDING; a builder self-serves dev/staging with 'promote', but prod
promotion + admission stay a staff decision (model B).

Auth resolves: explicit --token/SUBSTRAT_SERVICE_TOKEN → stored browser session →
stored service token. URL resolves flag → SUBSTRAT_CP_URL → ~/.substrat/config.json.
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

  // Default: browser loopback login → a per-human session token.
  const bearerToken = await browserLogin(cp);

  // Resolve the builder's workspace so `push`/`promote` just work (builder-plane.md §5).
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
    tenants.forEach((t, i) => console.log(`    ${i + 1}. ${t.slug}  (${t.name})`));
    const pick = await ask(`  default workspace [1-${tenants.length}, or a slug]: `);
    defaultTenant =
      tenants[Number(pick) - 1]?.slug ??
      tenants.find((t) => t.slug === pick || t.id === pick)?.slug ??
      tenants[0]!.slug;
    console.log(`  default workspace: ${defaultTenant} (override per command with --tenant)`);
  } else if (user) {
    console.log('  no workspace yet — create one at your dashboard, then `substrat push`.');
  }
  const path = saveConfig({ ...existing, controlPlaneUrl: cp, bearerToken, defaultTenant });
  console.log(`✓ signed in${user?.email ? ` as ${user.email}` : ''}. session saved to ${path}`);
}

async function cmdPush(): Promise<void> {
  // Directory defaults to '.' — run `substrat push` from inside the vertical.
  const dir = argv[1] && !argv[1].startsWith('--') ? argv[1] : '.';
  const { controlPlaneUrl, header, as } = resolveAuth({ cp: flag('cp'), token: flag('token'), tenant: flag('tenant') });

  // Slug + name default from the vertical's package.json (`substrat` block, else derived);
  // a flag still wins. So `cd demos/meridian && substrat push` needs no --slug/--name.
  const meta = readVerticalMeta(dir);
  const slug = flag('slug') ?? meta.slug;
  const name = flag('name') ?? meta.name;
  if (!slug) {
    console.error('no --slug given and none in package.json — add `"substrat": { "slug": "…" }` or pass --slug');
    process.exit(1);
  }
  console.log(`authenticating with ${as}`);
  // Version defaults to the registry's latest, patch-bumped — no hand-tracking. --version wins.
  const version = flag('version') ?? (await nextVersion(controlPlaneUrl, header, slug, meta.versionSeed));
  console.log(`pushing ${slug}@${version}${name && name !== slug ? ` (${name})` : ''} …`);
  const v = await push({ dir, slug, version, name, envSpec: meta.envSpec, controlPlaneUrl, authHeader: header });
  console.log(`✓ pushed. version ${v.id} (${version}) is ${v.admission}; deploymentRef=${v.deploymentRef}`);
  console.log('  admit it in the console to let a scope bind it.');
}

async function cmdVersions(): Promise<void> {
  const slug = argv[1];
  if (!slug || slug.startsWith('--')) {
    console.error('usage: substrat versions <slug>');
    process.exit(1);
  }
  const { controlPlaneUrl, header } = resolveAuth({ cp: flag('cp'), token: flag('token'), tenant: flag('tenant') });
  await printVersions(controlPlaneUrl, header, slug);
}

async function cmdPromote(): Promise<void> {
  const slug = argv[1];
  const channel = flag('channel');
  const version = flag('version');
  if (!slug || slug.startsWith('--') || !channel || !version) {
    console.error('usage: substrat promote <slug> --channel dev|staging --version <versionId>');
    process.exit(1);
  }
  const { controlPlaneUrl, header, as } = resolveAuth({ cp: flag('cp'), token: flag('token'), tenant: flag('tenant') });
  console.log(`authenticating with ${as}`);
  const ch = await promote({ controlPlaneUrl, header, slug, channel, versionId: version });
  console.log(`✓ ${slug} → ${ch.channel} now points at ${ch.versionId}`);
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
  for (const t of tenants) console.log(`  ${t.slug}  (${t.name})`);
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
    case 'whoami':
      return cmdWhoami();
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
