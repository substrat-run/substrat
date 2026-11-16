#!/usr/bin/env node
/**
 * One platform environment, set up end to end from ONE Cloudflare token that can create tokens.
 *
 *   node scripts/env-provision.mjs --env test --dry-run   # inspect, change nothing
 *   node scripts/env-provision.mjs --env test             # converge the account on the declaration
 *   node scripts/env-provision.mjs --env test --deploy    # … and build + deploy every worker
 *
 * The bootstrap token is read from CLOUDFLARE_BOOTSTRAP_TOKEN, else from
 * `secrets/bootstrap.env` (gitignored, `CLOUDFLARE_BOOTSTRAP_TOKEN=…`). It needs one permission:
 * Account API Tokens: Edit (or, for a user-owned token, User API Tokens: Edit). It is never
 * written anywhere and is removed from this process's environment as it is read, so no child
 * process inherits it — it only mints the two tokens below, and everything after runs on those.
 *
 * Safe to run any number of times. Every step reads the current state first and prints
 * ✓ (already right) or → (changed it now); `--dry-run` prints → as "would". The steps:
 *
 *   0. Features. Every Cloudflare product the env's bindings need (Workers for Platforms,
 *      Containers, R2, D1, Analytics Engine, Workers AI, Email Routing, ACM on the wildcard's zone,
 *      Cloudflare for SaaS on the SaaS zone, the Workers Paid plan) is probed through its own API
 *      on a 15-minute read-only token minted for the check and deleted after it. One missing stops
 *      the run before anything is created; none can be switched on from the API, so the output
 *      names where in the dashboard. `--check-features` stops after this step; a dry run skips it,
 *      since minting the probe token is a change.
 *   1. Tokens. `substrat-<env>-deploy` (wrangler deploys, D1 migrations, provisioning, CI) and
 *      `substrat-<env>-control-plane` (the running control plane's CF_API_TOKEN). Found by NAME;
 *      a token whose policies drifted is updated in place; a value is rolled only when the env
 *      file does not hold one that still verifies — Cloudflare never returns a token value, so
 *      the file is the only copy, and a value it lacks cannot be recovered any other way. When no
 *      token has the name but the file holds one that verifies (made by hand), it is kept as is.
 *      Prod's deploy token is never rolled without `--roll-prod-deploy-token`: the shared
 *      CLOUDFLARE_API_TOKEN Actions secret may hold its current value, and a roll would leave
 *      release.yml and docs.yml without Cloudflare until a person replaced that secret.
 *   2. Resources. Read from each app's `wrangler.jsonc` for this env — the D1 databases, R2
 *      buckets and dispatch namespaces it binds, the wildcard zone route's proxied DNS record
 *      and ACM certificate. Declared once, there; this file adds no second list to drift.
 *   3. Placeholder scripts. The platform workers bind each other in a cycle (the control plane
 *      binds the builder and the router, which bind it back), and Cloudflare refuses a binding
 *      to a script that does not exist — so a brand-new env cannot deploy any of them first. A
 *      missing worker gets a 503 placeholder, which the real deploy replaces.
 *   4. D1 migrations, applied to THIS env's databases. These are shipped migrations a review
 *      already approved; applying them to a fresh test database is bring-up, not a schema change.
 *   5. Secrets. The env file gets the account's ids and the minted tokens; a GENERATABLE key is
 *      generated only when NO worker holds it yet. A key blank in the file but live on a worker
 *      is left alone and reported: rotating a box key silently would orphan every credential it
 *      sealed (`--rotate KEY` does it on purpose). Then the file is pushed with
 *      `secrets.mjs push`, which re-puts PLATFORM_SECRET/ROUTER_SECRET on the vertical fleet too.
 *      A REQUIRED secret neither in the file nor live (the OIDC clients, the GitHub App: values
 *      only a person can obtain) stops the run here with the list.
 *   6. Deploy (`--deploy` only), in the order CI's deploy-test job uses.
 *   7. Smoke: each custom domain and the router's wildcard answer below 500 over TLS.
 *   8. GitHub: the CI variables through `secrets.mjs github` (its allow-list), CLOUDFLARE_ACCOUNT_ID,
 *      the test deploy token as the CLOUDFLARE_API_TOKEN_TEST secret, and TEST_ENV_READY=true once
 *      smoke passed and every variable CI's deploy needs is set. Prod's shared CLOUDFLARE_API_TOKEN
 *      secret is left alone: release.yml deploys with it, and replacing it is a person's call.
 *
 * Not managed, and said so in the output rather than skipped quietly: inbound mail routing
 * (Email Routing on the MAIL_IN_DOMAIN subdomain has no API this script trusts), the store and
 * wire keys (`pnpm store-keys`, `pnpm wire-keys` — keys with a rotation runbook of their own),
 * and the Artifacts namespace, which the builder's first repository creates.
 *
 * Flags: --env test|prod (required) · --check-features · --dry-run · --deploy · --skip-build · --skip-github ·
 *        --rotate KEY[,KEY] · --confirm-prod (required with --env prod) · --roll-prod-deploy-token
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from '../tools/jsonc.mjs';
import { GENERATABLE, MANIFEST, generateValue, parseEnvText } from './secrets.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.cloudflare.com/client/v4';

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (n) => argv.includes(`--${n}`);
const ENV = flag('env');
const DRY = has('dry-run');
const ROTATE = new Set((flag('rotate') ?? '').split(',').filter(Boolean));

const summary = { changed: [], manual: [] };
const ok = (m) => console.log(`  ✓ ${m}`);
/** Every → line is a change (or, in a dry run, one that would be made); the summary counts them. */
const act = (m) => {
  summary.changed.push(m);
  console.log(`  ${DRY ? '→ would' : '→'} ${m}`);
};
const warn = (m) => console.log(`  ! ${m}`);
const note = (m) => console.log(`  · ${m}`);
const section = (m) => console.log(`\n${m}`);
function fail(m) {
  console.error(`\n✗ ${m}`);
  process.exit(1);
}

if (ENV !== 'test' && ENV !== 'prod') fail('--env test|prod is required');
if (ENV === 'prod' && !has('confirm-prod')) {
  fail('--env prod rolls production credentials it cannot find in the file; pass --confirm-prod to mean it');
}
for (const k of ROTATE) if (!GENERATABLE.includes(k)) fail(`--rotate ${k}: not generatable (${GENERATABLE.join(', ')})`);

// ── declarations ─────────────────────────────────────────────────────────────

/** The platform workers, in CI's deploy-test order (ci.yml): each one's bindings exist before it. */
const WORKERS = [
  { app: 'builder', pkg: '@substrat-run/builder', docker: true },
  { app: 'control-plane', pkg: '@substrat-run/control-plane' },
  { app: 'vertical-egress', pkg: '@substrat-run/vertical-egress' },
  { app: 'router', pkg: '@substrat-run/router' },
  { app: 'dashboard', pkg: '@substrat-run/dashboard' },
  { app: 'social-relay', pkg: '@substrat-run/social-relay' },
];
/** A Pages project, deployed as a branch of the prod project: never placeholdered, never provisioned. */
const DOCS = { pkg: '@substrat-run/docs' };

/** The control plane's PLATFORM_BASE_DOMAINS zone is the Cloudflare-for-SaaS zone (CF_SAAS_ZONE_ID). */
const SAAS_ZONE_APP = 'control-plane';

/** What a placeholder script answers after its own name, which the smoke step recognises it by. */
const PLACEHOLDER_BODY = ': not deployed yet';

/**
 * The two tokens the bootstrap token mints, by permission-group NAME (resolved against the
 * account's own list, so a renamed group fails loudly here rather than minting a weaker token).
 * `zones: 'all'` covers every zone in the account; `zones: 'saas'` only the SaaS zone.
 */
const TOKENS = [
  {
    key: 'CF_DEPLOY_TOKEN',
    name: `substrat-${ENV}-deploy`,
    why: 'wrangler deploy, D1 migrations and provisioning — this script and CI',
    account: [
      'Workers Scripts Write',
      'Workers R2 Storage Write',
      'D1 Write',
      'Workers KV Storage Write',
      'Cloudflare Pages Write',
      'Containers Write',
      // The control plane's prod deploy binds the Tier-2 stream, and its preflight reads it.
      'Pipelines Write',
      'Account Settings Read',
      'Workers Tail Read',
    ],
    zone: ['Workers Routes Write', 'DNS Write', 'SSL and Certificates Write', 'Zone Read'],
    zones: 'all',
    // Prod's shared deploy secret is set by a person (see GITHUB_DEPLOY_SECRET), possibly to this
    // token's value: rolling it is gated on a flag naming that consequence.
    shared:
      ENV === 'prod'
        ? { flag: 'roll-prod-deploy-token', secret: 'CLOUDFLARE_API_TOKEN', readers: 'release.yml and docs.yml' }
        : null,
  },
  {
    key: 'CF_API_TOKEN',
    name: `substrat-${ENV}-control-plane`,
    // secrets/platform.prod.env.example names these: push (Workers Scripts), per-tenant stores
    // (D1, R2), custom hostnames (SSL on the SaaS zone), and the observability reads.
    why: 'the running control plane: vertical pushes, tenant stores, custom hostnames, telemetry',
    account: [
      'Workers Scripts Write',
      'D1 Write',
      'Workers R2 Storage Write',
      'Account Analytics Read',
      'Workers Observability Write',
    ],
    zone: ['SSL and Certificates Write'],
    zones: 'saas',
  },
];

/** wrangler binding kind → the account feature it cannot deploy without. */
const FEATURE_BINDINGS = [
  ['dispatch_namespaces', 'wfp'],
  ['containers', 'containers'],
  ['r2_buckets', 'r2'],
  ['d1_databases', 'd1'],
  ['analytics_engine_datasets', 'analytics-engine'],
  ['ai', 'workers-ai'],
  ['send_email', 'email'],
  ['artifacts', 'artifacts'],
];

/**
 * How each feature is told apart from "not enabled": by calling the API the feature itself
 * serves, with the read permission that API needs. A list endpoint that answers means the
 * product is on for the account; a plan name would only be a proxy for that. `enable` says where
 * a person turns it on — none of these can be switched on from the API.
 */
const FEATURES = {
  'workers-paid': {
    name: 'Workers Paid plan',
    perm: ['Billing Read', 'account'],
    enable: 'Workers & Pages → Plans → Workers Paid',
    probe: async (t, { account }) => {
      const subs = (await cf(t, 'GET', `/accounts/${account}/subscriptions`)).result ?? [];
      const names = subs.map((s) => `${s.rate_plan?.id ?? ''} ${s.rate_plan?.public_name ?? ''} ${s.product?.name ?? ''}`);
      const paid = names.find((n) => /workers/i.test(n) && /paid|platforms|enterprise/i.test(n));
      return paid ? paid.trim().replace(/\s+/g, ' ') : false;
    },
  },
  wfp: {
    name: 'Workers for Platforms',
    perm: ['Workers Scripts Read', 'account'],
    enable: 'Workers & Pages → Workers for Platforms (on top of Workers Paid)',
    probe: (t, { account }) => cf(t, 'GET', `/accounts/${account}/workers/dispatch/namespaces`),
  },
  containers: {
    name: 'Containers',
    perm: ['Containers Read', 'account'],
    enable: 'Workers & Pages → Containers (needs Workers Paid)',
    probe: (t, { account }) => cf(t, 'GET', `/accounts/${account}/containers/applications`),
  },
  r2: {
    name: 'R2',
    perm: ['Workers R2 Storage Read', 'account'],
    enable: 'R2 Object Storage → Purchase / enable R2',
    probe: (t, { account }) => cf(t, 'GET', `/accounts/${account}/r2/buckets?per_page=1`),
  },
  d1: {
    name: 'D1',
    perm: ['D1 Read', 'account'],
    enable: 'Storage & Databases → D1',
    probe: (t, { account }) => cf(t, 'GET', `/accounts/${account}/d1/database?per_page=1`),
  },
  'analytics-engine': {
    name: 'Workers Analytics Engine',
    perm: ['Account Analytics Read', 'account'],
    enable: 'Workers & Pages → Analytics Engine → Enable',
    probe: async (t, { account }) => {
      const r = await fetch(`${API}/accounts/${account}/analytics_engine/sql`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${t}` },
        body: 'SHOW TABLES',
      });
      if (!r.ok) throw new CfError('POST', '/analytics_engine/sql', r.status, [{ message: (await r.text()).slice(0, 200) }]);
    },
  },
  'workers-ai': {
    name: 'Workers AI',
    perm: ['Workers AI Read', 'account'],
    enable: 'AI → Workers AI',
    probe: (t, { account }) => cf(t, 'GET', `/accounts/${account}/ai/models/search?per_page=1`),
  },
  pipelines: {
    name: 'Pipelines',
    perm: ['Pipelines Read', 'account'],
    enable: 'Storage & Databases → Pipelines',
    probe: (t, { account }) => cf(t, 'GET', `/accounts/${account}/pipelines/v1/streams`),
  },
  email: {
    name: 'Email Routing (send_email binding)',
    perm: ['Email Routing Rules Read', 'zone'],
    enable: 'a zone → Email → Email Routing → Enable',
    probe: async (t, { zones }) => {
      for (const z of zones) {
        const r = await cfFind(t, `/zones/${z.id}/email/routing`).catch(() => null);
        if (r?.enabled) return `enabled on ${z.name}`;
      }
      return false;
    },
  },
  artifacts: {
    name: 'Artifacts',
    enable: 'created by the builder\'s first repository',
    probe: null, // no public read the probe token can call; reported, not judged
  },
};

/**
 * The Actions secret CI deploys this env with, which this script sets. Prod has none it sets:
 * prod deploys with the shared `CLOUDFLARE_API_TOKEN` that release.yml and docs.yml read, and
 * replacing it is a decision for a person, made once the minted token has deployed prod.
 */
const GITHUB_DEPLOY_SECRET = ENV === 'test' ? 'CLOUDFLARE_API_TOKEN_TEST' : null;

// ── env file ─────────────────────────────────────────────────────────────────
const FILE = join(ROOT, `secrets/platform.${ENV}.env`);
const FILE_REL = `secrets/platform.${ENV}.env`;

function readValues() {
  return existsSync(FILE) ? parseEnvText(readFileSync(FILE, 'utf8')) : {};
}
let values = readValues();

/** Write one key, replacing its line or appending. Never prints the value. */
function setValue(key, value) {
  if (values[key] === value) return false;
  values[key] = value;
  if (DRY) return true;
  let text = readFileSync(FILE, 'utf8');
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, () => `${key}=${value}`) : `${text.replace(/\n?$/, '\n')}${key}=${value}\n`;
  writeFileSync(FILE, text);
  return true;
}

/**
 * The bootstrap token, taken OUT of this process's environment as it is read: every child
 * (`pnpm build`, wrangler, `secrets.mjs`, `gh`, `docker`) inherits `process.env`, and none of
 * them may hold a token that can mint any other.
 */
function bootstrapToken() {
  const env = process.env.CLOUDFLARE_BOOTSTRAP_TOKEN;
  delete process.env.CLOUDFLARE_BOOTSTRAP_TOKEN;
  if (env) return env;
  const path = join(ROOT, 'secrets/bootstrap.env');
  if (existsSync(path)) {
    const t = parseEnvText(readFileSync(path, 'utf8')).CLOUDFLARE_BOOTSTRAP_TOKEN;
    if (t) return t;
  }
  fail(
    'no bootstrap token: set CLOUDFLARE_BOOTSTRAP_TOKEN, or put CLOUDFLARE_BOOTSTRAP_TOKEN=… in\n' +
      '  secrets/bootstrap.env (gitignored). It needs Account API Tokens: Edit and nothing else.',
  );
}

// ── Cloudflare API ───────────────────────────────────────────────────────────
class CfError extends Error {
  constructor(method, path, status, errors) {
    super(`${method} ${path} → ${status} ${JSON.stringify(errors ?? [])}`);
    this.status = status;
    this.errors = errors ?? [];
  }
}

async function cf(token, method, path, body) {
  const form = body instanceof FormData;
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
    body: form ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.success === false) throw new CfError(method, path, res.status, json?.errors);
  return json;
}

/** GET that answers null for a resource that does not exist. */
async function cfFind(token, path) {
  try {
    return (await cf(token, 'GET', path)).result;
  } catch (e) {
    if (e instanceof CfError && e.status === 404) return null;
    throw e;
  }
}

/** Every page of a list endpoint. */
async function cfAll(token, path) {
  const out = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let page = 1; ; page++) {
    const json = await cf(token, 'GET', `${path}${sep}per_page=50&page=${page}`);
    const batch = json.result ?? [];
    out.push(...batch);
    const pages = json.result_info?.total_pages;
    if (batch.length === 0 || (typeof pages === 'number' ? page >= pages : batch.length < 50)) break;
  }
  return out;
}

// ── wrangler configs → the env's resources ───────────────────────────────────
function configOf(app) {
  const top = parseJsonc(readFileSync(join(ROOT, 'apps', app, 'wrangler.jsonc'), 'utf8'));
  // A named env inherits no bindings, only the name (`<name>-<env>`), so its block is the whole truth.
  const block = ENV === 'prod' ? top : (top.env?.[ENV] ?? fail(`apps/${app}/wrangler.jsonc has no env.${ENV}`));
  return { top, block, script: block.name ?? (ENV === 'prod' ? top.name : `${top.name}-${ENV}`) };
}

function resourcesOf() {
  const d1 = new Map(); // database_name → id placeholder key
  const r2 = new Set();
  const namespaces = new Set();
  const artifacts = new Set();
  const customDomains = new Set();
  const wildcards = []; // { host, zone, prodHost }
  const scripts = [];
  const needs = new Set(); // binding kinds this env uses, read by the features check
  let saasZone;
  let mailDomain;
  for (const { app } of WORKERS) {
    const { top, block, script } = configOf(app);
    scripts.push({ app, script });
    for (const db of block.d1_databases ?? []) {
      const key = /^\$\{(\w+)\}$/.exec(db.database_id ?? '')?.[1];
      d1.set(db.database_name, key);
    }
    for (const b of block.r2_buckets ?? []) r2.add(b.bucket_name);
    for (const n of block.dispatch_namespaces ?? []) namespaces.add(n.namespace);
    for (const a of block.artifacts ?? []) artifacts.add(a.namespace);
    for (const [binding, feature] of FEATURE_BINDINGS) if (block[binding]?.length ?? block[binding]) needs.add(feature);
    // The Tier-2 stream is a deploy-only overlay on the top-level (prod) block: wrangler.deploy.json.
    const overlay = join(ROOT, 'apps', app, 'wrangler.deploy.json');
    if (ENV === 'prod' && existsSync(overlay) && JSON.parse(readFileSync(overlay, 'utf8')).pipelines) needs.add('pipelines');
    for (const r of block.routes ?? []) {
      if (r.custom_domain) customDomains.add(r.pattern);
      else if (r.zone_name && r.pattern.startsWith('*.')) {
        const host = r.pattern.replace(/\/.*$/, '');
        // The prod block's wildcard on the same zone: the record and certificate a working
        // environment already has are the shape to copy.
        const prodHost = (top.routes ?? [])
          .filter((p) => p.zone_name === r.zone_name && p.pattern.startsWith('*.'))
          .map((p) => p.pattern.replace(/\/.*$/, ''))[0];
        wildcards.push({ host, zone: r.zone_name, prodHost });
      }
    }
    if (app === SAAS_ZONE_APP) {
      saasZone = block.vars?.PLATFORM_BASE_DOMAINS?.split(',')[0]?.trim();
      mailDomain = block.vars?.MAIL_IN_DOMAIN;
    }
  }
  return { d1, r2, namespaces, artifacts, customDomains, wildcards, scripts, saasZone, mailDomain, needs };
}

// ── steps ────────────────────────────────────────────────────────────────────

/** Which tokens endpoint the bootstrap token lives under: account-owned or user-owned. */
async function tokenBase(token, account) {
  try {
    await cf(token, 'GET', `/accounts/${account}/tokens/verify`);
    return `/accounts/${account}/tokens`;
  } catch {
    try {
      await cf(token, 'GET', '/user/tokens/verify');
      return '/user/tokens';
    } catch (e) {
      fail(`the bootstrap token does not verify as an account or a user token: ${e.message}`);
    }
  }
}

/** JSON with every object's keys sorted, at every depth — a resource map nests (all zones of an account). */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function canonicalPolicies(policies) {
  return policies
    .map((p) => stable({ effect: p.effect, groups: p.permission_groups.map((g) => g.id).sort(), resources: p.resources }))
    .sort()
    .join('\n');
}

/** Wait out the propagation delay a freshly minted or rolled token has before it authenticates. */
async function untilVerifies(base, value, id) {
  for (let i = 0; i < 20; i++) {
    try {
      const r = (await cf(value, 'GET', `${base}/verify`)).result;
      if (r.id === id && r.status === 'active') return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

async function ensureToken(ctx, spec) {
  const { bootstrap, base, account, groups, tokens } = ctx;
  const resolve = (name, scope) => {
    const g = groups.find((x) => x.name.toLowerCase() === name.toLowerCase() && x.scopes.includes(scope));
    if (g) return { id: g.id };
    const word = name.split(' ')[0].toLowerCase();
    const near = groups.filter((x) => x.name.toLowerCase().includes(word)).map((x) => x.name);
    fail(`permission group '${name}' (${scope}) does not exist.\n  near: ${[...new Set(near)].join(', ') || '—'}`);
  };
  const zoneResource =
    spec.zones === 'all'
      ? { [`com.cloudflare.api.account.${account}`]: { 'com.cloudflare.api.account.zone.*': '*' } }
      : { [`com.cloudflare.api.account.zone.${ctx.saasZoneId}`]: '*' };
  const policies = [
    {
      effect: 'allow',
      permission_groups: spec.account.map((n) => resolve(n, 'com.cloudflare.api.account')),
      resources: { [`com.cloudflare.api.account.${account}`]: '*' },
    },
    {
      effect: 'allow',
      permission_groups: spec.zone.map((n) => resolve(n, 'com.cloudflare.api.account.zone')),
      resources: zoneResource,
    },
  ];

  const found = tokens.filter((t) => t.name === spec.name);
  if (found.length > 1) fail(`${found.length} tokens are named ${spec.name} — delete the extras, then re-run`);
  let token = found[0];
  let fresh;
  const held = values[spec.key];
  /** The token `held` authenticates as, when it is an active one under this endpoint. */
  const heldId = async () => {
    if (!held) return null;
    try {
      const r = (await cf(held, 'GET', `${base}/verify`)).result;
      return r.status === 'active' ? r.id : null;
    } catch {
      return null;
    }
  };
  if (!token) {
    // A working token the file already holds under another name (one made by hand before this
    // script existed) is the env's live credential: minting a second would replace it in the
    // file, and push would hand the running workers a token with a different policy set.
    const adopted = await heldId();
    if (adopted) {
      const name = tokens.find((t) => t.id === adopted)?.name ?? adopted;
      warn(`${spec.key} in ${FILE_REL} is token '${name}', not ${spec.name} — kept as it is; rename it to ${spec.name} to have its policies managed here`);
      return held;
    }
    act(`create token ${spec.name}  (${spec.why})`);
    if (DRY) return null;
    const r = (await cf(bootstrap, 'POST', base, { name: spec.name, policies })).result;
    token = r;
    fresh = r.value;
  } else {
    if (canonicalPolicies(token.policies ?? []) !== canonicalPolicies(policies) || token.status !== 'active') {
      act(`update token ${spec.name}: its policies or status differ from the declaration`);
      if (!DRY) await cf(bootstrap, 'PUT', `${base}/${token.id}`, { name: spec.name, policies, status: 'active' });
    } else ok(`token ${spec.name} — policies match`);
    if ((await heldId()) === token.id) ok(`${spec.key} in ${FILE_REL} is ${spec.name}'s value`);
    else {
      act(`roll ${spec.name}'s value — ${FILE_REL} ${held ? 'holds a value that is not this token' : 'holds no value for it'}`);
      const shared = spec.shared;
      if (shared && !has(shared.flag)) {
        // Rolling invalidates the current value at once, and the shared Actions secret may hold
        // it: the roll would break every deploy that reads it, before anyone is told to act.
        const why =
          `rolling ${spec.name} invalidates its current value, which the ${shared.secret} Actions secret ` +
          `(${shared.readers}) may hold. Put that value in ${FILE_REL} as ${spec.key} and re-run, or ` +
          `re-run with --${shared.flag} and set ${shared.secret} to the new value straight after`;
        if (DRY) {
          warn(`a real run stops here: ${why}`);
          return null;
        }
        fail(`${spec.name} not rolled: ${why}`);
      }
      // Nothing usable to carry on with: the held value does not authenticate as this token.
      if (DRY) return null;
      fresh = (await cf(bootstrap, 'PUT', `${base}/${token.id}/value`, {})).result;
      if (shared) {
        summary.manual.push(
          `${shared.secret} (Actions secret): ${spec.name} was rolled, so if it held the old value ` +
            `${shared.readers} cannot deploy until it is set to ${spec.key} from ${FILE_REL} — now`,
        );
      }
    }
  }
  if (fresh) {
    // Written before anything else can fail: the file is the only copy Cloudflare will ever give.
    setValue(spec.key, fresh);
    if (!(await untilVerifies(base, fresh, token.id))) fail(`${spec.name} was minted but never verified — re-run`);
    ok(`${spec.key} written to ${FILE_REL} and verified`);
  }
  return values[spec.key];
}

/**
 * A short-lived, read-only token the features check runs on, so it can run before anything real
 * is minted and in a dry run. Deleted when the check ends; its expiry is the backstop for a run
 * that dies first. A leftover from such a run is deleted on the way in.
 */
async function withProbeToken(ctx, needs, fn) {
  const { bootstrap, base, account, groups, tokens } = ctx;
  const name = `substrat-${ENV}-probe`;
  for (const t of tokens.filter((t) => t.name === name)) await cf(bootstrap, 'DELETE', `${base}/${t.id}`);
  const scopeOf = { account: 'com.cloudflare.api.account', zone: 'com.cloudflare.api.account.zone' };
  const unreadable = new Set();
  const pick = (scope, names) =>
    names
      .map((n) => {
        const g = groups.find((x) => x.name.toLowerCase() === n.toLowerCase() && x.scopes.includes(scopeOf[scope]));
        if (!g) unreadable.add(n);
        return g && { id: g.id };
      })
      .filter(Boolean);
  const perms = [...needs].map((f) => FEATURES[f].perm).filter(Boolean);
  const accountGroups = pick('account', perms.filter(([, s]) => s === 'account').map(([n]) => n));
  const zoneGroups = pick('zone', ['Zone Read', 'SSL and Certificates Read', ...perms.filter(([, s]) => s === 'zone').map(([n]) => n)]);
  const policies = [
    { effect: 'allow', permission_groups: accountGroups, resources: { [`com.cloudflare.api.account.${account}`]: '*' } },
    {
      effect: 'allow',
      permission_groups: zoneGroups,
      resources: { [`com.cloudflare.api.account.${account}`]: { 'com.cloudflare.api.account.zone.*': '*' } },
    },
  ].filter((p) => p.permission_groups.length);
  const expires_on = new Date(Date.now() + 15 * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const probe = (await cf(bootstrap, 'POST', base, { name, policies, expires_on })).result;
  try {
    if (!(await untilVerifies(base, probe.value, probe.id))) fail('the read-only probe token never verified — re-run');
    return await fn(probe.value, unreadable);
  } finally {
    await cf(bootstrap, 'DELETE', `${base}/${probe.id}`).catch((e) => warn(`could not delete ${name}: ${e.message}`));
  }
}

/** Is every Cloudflare product this env binds switched on? Read-only; fails before anything is created. */
async function checkFeatures(ctx, res) {
  section('Cloudflare features this env needs');
  const needs = new Set(['workers-paid', ...res.needs]);
  if (res.namespaces.size) needs.add('wfp');
  const missing = [];
  await withProbeToken(ctx, needs, async (token, unreadable) => {
    const zones = await cfAll(token, `/zones?account.id=${ctx.account}`);
    const pctx = { account: ctx.account, zones };
    for (const id of needs) {
      const f = FEATURES[id];
      if (!f.probe) {
        note(`${f.name}: not checkable from the API (${f.enable})`);
        continue;
      }
      if (f.perm && unreadable.has(f.perm[0])) {
        warn(`${f.name}: unknown — no permission group '${f.perm[0]}' to read it with`);
        continue;
      }
      try {
        const r = await f.probe(token, pctx);
        if (r === false) {
          console.log(`  ✗ ${f.name} — not enabled. Enable: ${f.enable}`);
          missing.push(f.name);
        } else ok(`${f.name}${typeof r === 'string' ? ` (${r})` : ''}`);
      } catch (e) {
        const msg = e.errors?.map((x) => x.message).join('; ') || e.message;
        console.log(`  ✗ ${f.name} — ${e.status ?? ''} ${msg}\n      Enable: ${f.enable}`);
        missing.push(f.name);
      }
    }

    // Zone-level products: every zone a host lands on is active; the wildcard's zone has
    // Advanced Certificate Manager (an advanced pack is the only cert for a two-level wildcard);
    // the SaaS zone has Cloudflare for SaaS (custom hostnames).
    const hostZones = new Map();
    for (const h of [...res.customDomains, ...res.wildcards.map((w) => w.host.slice(2))]) {
      const z = zones.filter((z) => h === z.name || h.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
      if (!z) {
        console.log(`  ✗ ${h} — no zone in the account serves it`);
        missing.push(`zone for ${h}`);
      } else hostZones.set(z.name, z);
    }
    for (const z of hostZones.values()) {
      if (z.status === 'active') ok(`zone ${z.name} active (${z.plan?.name ?? 'plan ?'})`);
      else {
        console.log(`  ✗ zone ${z.name} is ${z.status}`);
        missing.push(`zone ${z.name}`);
      }
    }
    for (const w of res.wildcards) {
      const z = zones.find((z) => z.name === w.zone);
      if (!z) continue;
      try {
        const q = (await cf(token, 'GET', `/zones/${z.id}/ssl/certificate_packs/quota`)).result;
        if ((q?.advanced?.allocated ?? 0) > 0) ok(`Advanced Certificate Manager on ${z.name} (${q.advanced.used}/${q.advanced.allocated} packs used)`);
        else {
          console.log(`  ✗ Advanced Certificate Manager on ${z.name} — needed for ${w.host}. Enable: ${z.name} → SSL/TLS → Edge Certificates → Advanced Certificate Manager`);
          missing.push(`ACM on ${z.name}`);
        }
      } catch (e) {
        warn(`Advanced Certificate Manager on ${z.name}: unknown (${e.message})`);
      }
    }
    const saas = zones.find((z) => z.name === res.saasZone);
    if (saas) {
      try {
        await cf(token, 'GET', `/zones/${saas.id}/custom_hostnames?per_page=1`);
        const fb = await cfFind(token, `/zones/${saas.id}/custom_hostnames/fallback_origin`).catch(() => null);
        ok(`Cloudflare for SaaS on ${saas.name}${fb?.origin ? ` (fallback origin ${fb.origin}, ${fb.status})` : ' — no fallback origin set'}`);
      } catch (e) {
        console.log(`  ✗ Cloudflare for SaaS on ${saas.name} — ${e.message}\n      Enable: ${saas.name} → SSL/TLS → Custom Hostnames`);
        missing.push(`Cloudflare for SaaS on ${saas.name}`);
      }
    }
  });
  if (missing.length) fail(`${missing.length} feature(s) not enabled: ${missing.join(', ')} — nothing was created`);
}

async function main() {
  console.log(`env provision · env=${ENV}${DRY ? ' · DRY RUN (no changes)' : ''}`);
  const bootstrap = bootstrapToken();

  const prodValues = existsSync(join(ROOT, 'secrets/platform.prod.env'))
    ? parseEnvText(readFileSync(join(ROOT, 'secrets/platform.prod.env'), 'utf8'))
    : {};
  const account = values.CF_ACCOUNT_ID ?? prodValues.CF_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) fail(`CF_ACCOUNT_ID is blank in ${FILE_REL} — set it, then re-run`);
  const res = resourcesOf();

  // ── 0. the bootstrap token, and whether the account can hold this env at all ──
  section('Bootstrap token');
  const base = await tokenBase(bootstrap, account);
  ok(`verifies (${base.startsWith('/user') ? 'user-owned' : 'account-owned'})`);
  const groups = await cfAll(bootstrap, `${base}/permission_groups`);
  const tokens = await cfAll(bootstrap, base);
  const ctx = { bootstrap, base, account, groups, tokens };
  // The check mints (and deletes) a short-lived read-only token, so a dry run, which changes
  // nothing, leaves it out unless asked for by name.
  if (has('check-features')) return checkFeatures(ctx, res);
  if (DRY) {
    section('Cloudflare features this env needs');
    note('not checked in a dry run — `--check-features` checks them (it mints a 15-minute read-only token)');
  } else await checkFeatures(ctx, res);

  // ── the env file ──
  section(`Env file ${FILE_REL}`);
  if (existsSync(FILE)) ok('exists');
  else {
    act(`create it from secrets/platform.prod.env.example`);
    if (!DRY) {
      copyFileSync(join(ROOT, 'secrets/platform.prod.env.example'), FILE);
      writeFileSync(FILE, `# ${ENV.toUpperCase()} — created by scripts/env-provision.mjs.\n${readFileSync(FILE, 'utf8')}`);
      values = readValues();
    }
  }
  setValue('CF_ACCOUNT_ID', account);

  // ── 1. tokens ──
  section('Tokens');
  const deploy = await ensureToken(ctx, TOKENS[0]);
  if (!deploy) {
    note('no deploy token yet, so nothing below can be inspected — run without --dry-run');
    return;
  }

  // ── 2. resources ──
  section('Zones');
  const zones = await cfAll(deploy, `/zones?account.id=${account}`);
  const zoneOf = (host) =>
    zones.filter((z) => host === z.name || host.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0];
  const saas = zones.find((z) => z.name === res.saasZone);
  if (!saas) fail(`zone ${res.saasZone} (the control plane's PLATFORM_BASE_DOMAINS) is not in the account`);
  ctx.saasZoneId = saas.id;
  ok(`${saas.name} (the SaaS zone)`);
  if (setValue('CF_SAAS_ZONE_ID', saas.id)) act('CF_SAAS_ZONE_ID written');
  for (const host of res.customDomains) {
    const z = zoneOf(host);
    z ? ok(`${host} — zone ${z.name}; the deploy creates the custom domain`) : fail(`${host}: no zone in the account serves it`);
  }

  section('Control-plane runtime token');
  await ensureToken(ctx, TOKENS[1]);

  section('D1');
  for (const [name, key] of res.d1) {
    const list = await cfAll(deploy, `/accounts/${account}/d1/database?name=${encodeURIComponent(name)}`);
    let db = list.find((d) => d.name === name);
    if (db) ok(name);
    else {
      act(`create D1 ${name}`);
      if (DRY) continue;
      db = (await cf(deploy, 'POST', `/accounts/${account}/d1/database`, { name })).result;
    }
    if (key && setValue(key, db.uuid)) act(`${key} written`);
  }

  section('R2');
  for (const name of res.r2) {
    if (await cfFind(deploy, `/accounts/${account}/r2/buckets/${name}`)) ok(name);
    else {
      act(`create bucket ${name}`);
      if (!DRY) await cf(deploy, 'POST', `/accounts/${account}/r2/buckets`, { name });
    }
  }

  section('Dispatch namespaces');
  for (const name of res.namespaces) {
    if (await cfFind(deploy, `/accounts/${account}/workers/dispatch/namespaces/${name}`)) ok(name);
    else {
      act(`create dispatch namespace ${name}`);
      if (!DRY) await cf(deploy, 'POST', `/accounts/${account}/workers/dispatch/namespaces`, { name });
    }
  }
  for (const name of res.artifacts) note(`Artifacts ${name}: created by the builder's first repository (not managed)`);

  section('Wildcard routes (proxied DNS + ACM certificate)');
  for (const w of res.wildcards) {
    const zone = zones.find((z) => z.name === w.zone);
    if (!zone) fail(`route ${w.host}: zone ${w.zone} is not in the account`);
    const records = await cfAll(deploy, `/zones/${zone.id}/dns_records?name=${encodeURIComponent(w.host)}`);
    if (records.length) {
      const r = records[0];
      r.proxied ? ok(`DNS ${w.host} (${r.type}, proxied)`) : warn(`DNS ${w.host} exists but is NOT proxied — the route never runs`);
    } else {
      const model =
        w.prodHost && w.prodHost !== w.host
          ? (await cfAll(deploy, `/zones/${zone.id}/dns_records?name=${encodeURIComponent(w.prodHost)}`))[0]
          : undefined;
      const record = { type: model?.type ?? 'AAAA', name: w.host, content: model?.content ?? '100::', proxied: true };
      act(`create DNS ${record.type} ${w.host} → ${record.content} (proxied${model ? `, as ${w.prodHost}` : ''})`);
      if (!DRY) await cf(deploy, 'POST', `/zones/${zone.id}/dns_records`, { ...record, ttl: 1 });
    }
    const packs = await cfAll(deploy, `/zones/${zone.id}/ssl/certificate_packs?status=all`);
    const covering = packs.find((p) => (p.hosts ?? []).includes(w.host));
    if (covering) {
      covering.status === 'active'
        ? ok(`certificate for ${w.host} (active)`)
        : warn(`certificate for ${w.host} is ${covering.status} — validation can take minutes`);
    } else {
      const model = packs.find((p) => w.prodHost && (p.hosts ?? []).includes(w.prodHost));
      const order = {
        type: 'advanced',
        hosts: [w.host.slice(2), w.host],
        validation_method: model?.validation_method ?? 'txt',
        validity_days: model?.validity_days ?? 90,
        certificate_authority: model?.certificate_authority ?? 'google',
        cloudflare_branding: false,
      };
      act(`order an advanced certificate for ${order.hosts.join(', ')} (${order.certificate_authority})`);
      if (!DRY) await cf(deploy, 'POST', `/zones/${zone.id}/ssl/certificate_packs/order`, order);
    }
  }

  // ── 3. placeholders ──
  section('Worker scripts');
  const live = new Set((await cfAll(deploy, `/accounts/${account}/workers/scripts`)).map((s) => s.id));
  for (const { app, script } of res.scripts) {
    if (live.has(script)) {
      ok(`${script}`);
      continue;
    }
    act(`upload a 503 placeholder as ${script} (apps/${app}) so the workers that bind it can deploy`);
    if (DRY) continue;
    const form = new FormData();
    form.append('metadata', JSON.stringify({ main_module: 'placeholder.mjs', compatibility_date: '2025-01-01' }));
    const code = `export default { fetch: () => new Response('${script}${PLACEHOLDER_BODY}', { status: 503 }) };\n`;
    form.append('placeholder.mjs', new Blob([code], { type: 'application/javascript+module' }), 'placeholder.mjs');
    await cf(deploy, 'PUT', `/accounts/${account}/workers/scripts/${script}`, form);
    live.add(script);
  }

  // Every child process acts as the deploy token, on this account, never as a login.
  const childEnv = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: deploy,
    CLOUDFLARE_ACCOUNT_ID: account,
    ...(await configIds(deploy, account, prodValues)),
  };

  // ── 4. D1 migrations ──
  section('D1 migrations');
  if (DRY) note('not inspected in a dry run (needs the generated config)');
  else {
    execFileSync('node', ['tools/wrangler-config.mjs', '--app', 'control-plane'], { cwd: ROOT, env: childEnv, stdio: 'pipe' });
    for (const [name] of res.d1) {
      const args = ['exec', 'wrangler', 'd1', 'migrations', 'apply', name, '--remote', '-c', 'wrangler.generated.jsonc'];
      if (ENV !== 'prod') args.push('--env', ENV);
      const out = spawnSync('pnpm', args, { cwd: join(ROOT, 'apps/control-plane'), env: childEnv, encoding: 'utf8', input: 'y\n' });
      if (out.status !== 0) fail(`migrations on ${name} failed:\n${out.stdout}${out.stderr}`);
      if (/No migrations to apply/.test(out.stdout)) ok(`${name} — up to date`);
      else act(`applied pending migrations to ${name}`);
    }
  }

  // ── 5. secrets ──
  section('Secrets');
  const liveSecrets = new Map();
  for (const { app, script } of res.scripts) {
    const list = await cfFind(deploy, `/accounts/${account}/workers/scripts/${script}/secrets`);
    liveSecrets.set(app, new Set((list ?? []).map((s) => s.name)));
  }
  const holders = (canonical) =>
    Object.entries(MANIFEST).flatMap(([app, cfg]) =>
      Object.entries(cfg.secrets)
        .filter(([, c]) => c === canonical)
        .map(([name]) => ({ app, name, live: liveSecrets.get(app)?.has(name) ?? false })),
    );
  for (const key of GENERATABLE) {
    const where = holders(key);
    if (values[key] && !ROTATE.has(key)) continue;
    const liveOn = where.filter((h) => h.live);
    if (liveOn.length && !ROTATE.has(key)) {
      note(`${key}: live on ${liveOn.map((h) => h.app).join(', ')}, not in the file — kept (--rotate ${key} replaces it)`);
      continue;
    }
    act(`${ROTATE.has(key) ? 'rotate' : 'generate'} ${key}`);
    setValue(key, generateValue(key));
  }
  const gaps = [];
  for (const [app, cfg] of Object.entries(MANIFEST)) {
    for (const name of cfg.required ?? []) {
      const canonical = cfg.secrets[name];
      if (!values[canonical] && !liveSecrets.get(app)?.has(name)) gaps.push(`${app}: ${name}  ← ${canonical}`);
    }
  }
  if (gaps.length) {
    console.error(`\n  ✗ ${gaps.length} required secret(s) are neither in ${FILE_REL} nor live:`);
    for (const g of gaps) console.error(`      ${g}`);
    fail(
      `fill them in ${FILE_REL} and re-run — everything above is done and will read ✓.\n` +
        `  The OIDC clients are registered at the issuer with redirect URIs on this env's hosts:\n` +
        [...res.customDomains].map((h) => `    https://${h}/api/auth/callback`).join('\n'),
    );
  }
  ok('every required secret is in the file or already live');
  // `--allow-incomplete`: the gap check above is stricter than push's own, because it counts what
  // is live. The fleet re-put needs both verification secrets in hand; when the file lacks them,
  // they are the live values this run did not touch, and the fleet already verifies against them.
  // Judged on what push will READ: in a dry run the values generated above exist only in memory,
  // and the file on disk is what push re-parses. Push's fleet re-put needs these four in it.
  const pushReads = DRY ? readValues() : values;
  const pushArgs = ['scripts/secrets.mjs', 'push', '--env', ENV, '--allow-incomplete'];
  if (['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'PLATFORM_SECRET', 'ROUTER_SECRET'].some((k) => !pushReads[k])) {
    pushArgs.push('--skip-verticals');
  }
  if (DRY) pushArgs.push('--dry-run');
  if (DRY && !existsSync(FILE)) note(`push not previewed: ${FILE_REL} does not exist yet`);
  else {
    console.log(`  $ node ${pushArgs.join(' ')}`);
    const push = spawnSync('node', pushArgs, { cwd: ROOT, env: childEnv, stdio: 'inherit' });
    if (push.status !== 0) fail('secrets.mjs push failed');
  }

  // ── 6. deploy ──
  section('Deploy');
  if (!has('deploy')) note('skipped (pass --deploy, or let CI deploy-test do it on the next merge)');
  else if (DRY) act(`build, then deploy ${[...WORKERS.map((w) => w.app), 'docs'].join(' → ')}`);
  else {
    if (!has('skip-build')) run('pnpm', ['build'], childEnv);
    const suffix = ENV === 'prod' ? '' : `:${ENV}`;
    const docker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
    for (const w of [...WORKERS, DOCS]) {
      if (w.docker && !docker) {
        warn(`${w.pkg}: skipped — its container image needs a running Docker (CI deploys it)`);
        summary.manual.push(`deploy ${w.pkg} (needs Docker)`);
        continue;
      }
      act(`deploy ${w.pkg}`);
      run('pnpm', ['--filter', w.pkg, `cf:deploy${suffix}`], childEnv);
    }
  }

  // ── 7. smoke ──
  section('Smoke (TLS + an answer below 500)');
  const probes = [...res.customDomains].map((h) => `https://${h}/`);
  for (const w of res.wildcards) probes.push(`https://env-provision-probe${w.host.slice(1)}/`);
  let smokeFailed = false;
  for (const url of probes) {
    try {
      const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      if (r.status < 500) ok(`${url} → ${r.status}`);
      else if (r.status === 503 && !has('deploy') && (await r.text()).endsWith(PLACEHOLDER_BODY)) {
        // A placeholder answers 503 until something deploys over it, whichever run uploaded it.
        warn(`${url} → ${r.status} (a placeholder until deployed: --deploy, or CI)`);
      } else {
        warn(`${url} → ${r.status}`);
        smokeFailed = true;
      }
    } catch (e) {
      warn(`${url} → ${e.cause?.code ?? e.message}`);
      smokeFailed = true;
    }
  }

  // ── 8. GitHub ──
  section('GitHub');
  if (has('skip-github')) note('skipped (--skip-github)');
  else await github(deploy, account, smokeFailed);

  // ── report ──
  section('Not managed by this script');
  if (res.mailDomain) note(`inbound mail: Email Routing on ${res.mailDomain} (docs: apps/docs/connectors/mail-in.md)`);
  note('store and wire keys: `pnpm store-keys doctor`, `pnpm wire-keys doctor` (secrets/store-keys.md, wire-keys.md)');
  for (const m of summary.manual) note(m);
  console.log(
    summary.changed.length
      ? `\n${DRY ? 'would change' : 'changed'} ${summary.changed.length} thing(s) — the → lines above.`
      : '\nnothing to change — the account matches the declaration.',
  );
  if (smokeFailed) fail('smoke failed — see above');
}

/** The ids the committed wrangler configs leave as placeholders, for tools/wrangler-config.mjs. */
async function configIds(deploy, account, prodValues) {
  const out = {};
  for (const { app } of WORKERS) {
    const { top } = configOf(app);
    // Prod's ids too: the generated config resolves every block, not just the one deployed.
    for (const block of [top, ...Object.values(top.env ?? {})]) {
      for (const db of block.d1_databases ?? []) {
        const key = /^\$\{(\w+)\}$/.exec(db.database_id ?? '')?.[1];
        if (!key || out[key]) continue;
        const v = process.env[key] ?? values[key] ?? prodValues[key];
        if (v) out[key] = v;
        else {
          const list = await cfAll(deploy, `/accounts/${account}/d1/database?name=${encodeURIComponent(db.database_name)}`);
          const found = list.find((d) => d.name === db.database_name);
          if (found) out[key] = found.uuid;
        }
      }
    }
  }
  // The Tier-2 stream is a top-level-only binding (wrangler.deploy.json): a test deploy never
  // carries it, but the generated config still has to resolve it. A test env with no lake gets
  // an inert id, because the binding it fills is in the block that test does not deploy.
  const stream = process.env.CF_PIPELINE_OUTBOX_STREAM_ID ?? values.CF_PIPELINE_OUTBOX_STREAM_ID ?? prodValues.CF_PIPELINE_OUTBOX_STREAM_ID;
  if (stream) out.CF_PIPELINE_OUTBOX_STREAM_ID = stream;
  else if (ENV !== 'prod') out.CF_PIPELINE_OUTBOX_STREAM_ID = '0'.repeat(32);
  else fail('CF_PIPELINE_OUTBOX_STREAM_ID is blank — `pnpm lake:check` prints it');
  return out;
}

function run(cmd, args, env) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, env, stdio: 'inherit' });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} exited ${r.status}`);
}

/** The repository CI deploys from: `origin`, as owner/name. */
function repoSlug() {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const m = /github\.com[:/]([^/]+\/[^/.]+)(\.git)?$/.exec(url);
  if (!m) fail(`origin (${url}) is not a GitHub repository`);
  return m[1];
}

function gh(args, input) {
  return spawnSync('gh', [...args, '-R', repoSlug()], { cwd: ROOT, encoding: 'utf8', input });
}

/**
 * The variables CI's deploy-test job cannot run without: `tools/wrangler-config.mjs` refuses a
 * config whose ids it cannot resolve, and the prod ones are resolved in a test deploy too.
 */
const CI_DEPLOY_VARIABLES = ['CLOUDFLARE_ACCOUNT_ID', 'CF_D1_AUTH_DB_ID', 'CF_D1_AUTH_DB_ID_TEST', 'CF_PIPELINE_OUTBOX_STREAM_ID'];

async function github(deploy, account, smokeFailed) {
  // The D1 and stream ids go through `secrets.mjs github`, the one publisher of CI variables,
  // whose allow-list (GITHUB_VARIABLES) is what keeps an unlisted key out of CI configuration.
  const args = ['scripts/secrets.mjs', 'github', '--env', ENV, ...(DRY ? ['--dry-run'] : [])];
  console.log(`  $ node ${args.join(' ')}`);
  // Its `gh` calls name no repository, so GH_REPO pins them to the one `gh()` below writes to:
  // otherwise gh resolves its own default, and the deploy configuration could split across two.
  const env = { ...process.env, GH_REPO: repoSlug() };
  if (spawnSync('node', args, { cwd: ROOT, env, stdio: 'inherit' }).status !== 0) {
    fail('secrets.mjs github failed');
  }
  const setVariable = (vars, name, value) => {
    if (vars.get(name) === value) return ok(`variable ${name}`);
    act(`${vars.has(name) ? 'update' : 'set'} variable ${name}`);
    if (!DRY && gh(['variable', 'set', name, '--body', value]).status !== 0) fail(`gh variable set ${name} failed`);
    vars.set(name, value);
  };
  const vars = liveVariables();
  setVariable(vars, 'CLOUDFLARE_ACCOUNT_ID', account);
  if (GITHUB_DEPLOY_SECRET) {
    // A secret cannot be read back, so it is set every run: the same value converges, and a run
    // that died after rolling the token is repaired by the next one rather than left stale.
    act(`set secret ${GITHUB_DEPLOY_SECRET} to ${TOKENS[0].name}'s value`);
    if (!DRY && gh(['secret', 'set', GITHUB_DEPLOY_SECRET], deploy).status !== 0) {
      fail(`gh secret set ${GITHUB_DEPLOY_SECRET} failed`);
    }
  } else {
    summary.manual.push(
      `CLOUDFLARE_API_TOKEN (Actions secret): not replaced. release.yml and docs.yml deploy prod with it; ` +
        `set it to ${TOKENS[0].key} from ${FILE_REL} once a deploy with that token has passed`,
    );
  }
  if (ENV !== 'test') return;
  // Flipped last, and only when CI can actually deploy: it is what turns the deploy job on.
  const missing = CI_DEPLOY_VARIABLES.filter((k) => !vars.get(k) && !(DRY && values[k]));
  if (smokeFailed) note('TEST_ENV_READY not set: smoke failed');
  else if (missing.length) {
    warn(`TEST_ENV_READY not set: CI cannot deploy without ${missing.join(', ')} (\`pnpm secrets github --env prod\`, \`pnpm lake:check\`)`);
  } else setVariable(vars, 'TEST_ENV_READY', 'true');
}

function liveVariables() {
  const list = gh(['variable', 'list', '--json', 'name,value']);
  if (list.status !== 0) fail('`gh variable list` failed — is the GitHub CLI installed and logged in?');
  return new Map(JSON.parse(list.stdout).map((v) => [v.name, v.value]));
}

await main();
