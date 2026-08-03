#!/usr/bin/env node
/**
 * One env file → every platform worker's secrets, dev and prod.
 *
 * The platform is three Cloudflare Workers that share a handful of secrets under
 * DIFFERENT binding names (the control plane's SERVICE_TOKEN is the dashboard's
 * CP_SERVICE_TOKEN, etc.), plus per-worker and external ones (OIDC, CF_API_TOKEN,
 * the GitHub App, SECRET_BOX_KEY). Setting them by hand is the "wrong value / wrong
 * name / wrong worker" class of error. This declares the whole map ONCE and drives it
 * from a single flat env file you can keep in a password manager.
 *
 *   node scripts/secrets.mjs check                 # show the map + what the file covers (no values)
 *   node scripts/secrets.mjs status --env prod     # cross-check the file vs what's LIVE in Cloudflare
 *   node scripts/secrets.mjs push --env prod       # upload to the deployed workers (wrangler secret bulk)
 *   node scripts/secrets.mjs push --env test       # same, for the CI test workers (<name>-test)
 *   node scripts/secrets.mjs verticals --env prod  # re-put PLATFORM_SECRET/ROUTER_SECRET on every
 *                                                  # dispatch-namespace vertical script (rotation step 2)
 *   node scripts/secrets.mjs dev                    # write each worker's .dev.vars for `wrangler dev`
 *
 * --file <path>   override the env file (defaults: secrets/platform.<env>.env, and
 *                 secrets/platform.dev.env for `dev`)
 * --only <worker> restrict to one worker: control-plane | dashboard | router
 * --dry-run       print what WOULD be set (secret NAMES only — never values)
 *
 * Sibling tool: tools/set-platform-secrets.sh rotates just the three GENERATABLE shared
 * secrets (SERVICE_TOKEN / PLATFORM_SECRET / ROUTER_SECRET) with fresh random values and
 * no file. Use that to rotate; use this to set everything from a saved file. `generate`
 * below fills any blank generatable field so a fresh file is push-ready.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * worker → { <secret name on that worker>: <canonical key in the env file> }.
 *
 * Canonical keys are SHARED where the value must match across workers (SERVICE_TOKEN,
 * PLATFORM_SECRET, ROUTER_SECRET, OIDC_ISSUER) and PREFIXED where each worker holds its
 * own (CP_* / DASH_*) — the console and app are separate OIDC clients, and each worker
 * signs its own cookies. `optional` keys are behavioural config that normally lives in
 * wrangler.jsonc `vars`; set them here only to override. `generatable` keys are the
 * random shared tokens `generate` can fill.
 */
const MANIFEST = {
  'control-plane': {
    dir: 'apps/control-plane',
    secrets: {
      OIDC_ISSUER: 'OIDC_ISSUER',
      OIDC_CLIENT_ID: 'CP_OIDC_CLIENT_ID',
      OIDC_CLIENT_SECRET: 'CP_OIDC_CLIENT_SECRET',
      SESSION_SECRET: 'CP_SESSION_SECRET',
      SERVICE_TOKEN: 'SERVICE_TOKEN',
      PLATFORM_SECRET: 'PLATFORM_SECRET',
      ROUTER_SECRET: 'ROUTER_SECRET',
      PUSH_TOKEN_SECRET: 'CP_PUSH_TOKEN_SECRET',
      CF_API_TOKEN: 'CF_API_TOKEN',
      CF_ACCOUNT_ID: 'CF_ACCOUNT_ID',
      CF_SAAS_ZONE_ID: 'CF_SAAS_ZONE_ID',
      // Behavioural config — override wrangler.jsonc `vars` only if set in the file.
      // (PLATFORM_BASE_DOMAINS is deliberately NOT here: it is a checked-in `vars`
      // entry (#423), and a secret cannot share a name with a var.)
      CF_SAAS_ROUTING_TARGET: 'CF_SAAS_ROUTING_TARGET',
      CF_SAAS_SSL_METHOD: 'CF_SAAS_SSL_METHOD',
    },
  },
  dashboard: {
    dir: 'apps/dashboard',
    secrets: {
      OIDC_ISSUER: 'OIDC_ISSUER',
      OIDC_CLIENT_ID: 'DASH_OIDC_CLIENT_ID',
      OIDC_CLIENT_SECRET: 'DASH_OIDC_CLIENT_SECRET',
      SESSION_SECRET: 'DASH_SESSION_SECRET',
      // The control plane's SERVICE_TOKEN, under the dashboard's name for it.
      CP_SERVICE_TOKEN: 'SERVICE_TOKEN',
      SECRET_BOX_KEY: 'SECRET_BOX_KEY',
      SECRET_BOX_KEY_ID: 'SECRET_BOX_KEY_ID',
      GITHUB_APP_ID: 'GITHUB_APP_ID',
      GITHUB_APP_SLUG: 'GITHUB_APP_SLUG',
      GITHUB_APP_PRIVATE_KEY: 'GITHUB_APP_PRIVATE_KEY',
      // Must equal the App settings' webhook secret (per-PR previews, github-webhook.ts).
      GITHUB_APP_WEBHOOK_SECRET: 'GITHUB_APP_WEBHOOK_SECRET',
      EMAIL_FROM: 'DASH_EMAIL_FROM',
      CP_ACTOR: 'DASH_CP_ACTOR',
    },
  },
  router: {
    dir: 'apps/router',
    secrets: {
      PLATFORM_SECRET: 'PLATFORM_SECRET',
      ROUTER_SECRET: 'ROUTER_SECRET',
    },
  },
};

/** Canonical keys `generate` fills when blank — the random shared/session tokens. */
const GENERATABLE = [
  'SERVICE_TOKEN',
  'PLATFORM_SECRET',
  'ROUTER_SECRET',
  'CP_SESSION_SECRET',
  'DASH_SESSION_SECRET',
  'CP_PUSH_TOKEN_SECRET',
  'SECRET_BOX_KEY', // base64 of 32 bytes (AES-256); the rest are hex
];

// ── arg parsing ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);
const env = flag('env') ?? 'prod';
const only = flag('only');
const dryRun = has('dry-run');

const workers = Object.entries(MANIFEST).filter(([name]) => !only || name === only);
if (only && workers.length === 0) fail(`unknown --only worker '${only}' (control-plane | dashboard | router)`);

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** Parse a flat env file: KEY=VALUE, `#` comments, optional double-quotes, `\n` escapes. */
function parseEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    fail(`env file not found: ${path}\n  copy the template: cp ${path}.example ${path}`);
  }
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1).replace(/\\n/g, '\n');
    }
    if (val !== '') out[key] = val;
  }
  return out;
}

const defaultFile = cmd === 'dev' ? 'secrets/platform.dev.env' : `secrets/platform.${env}.env`;
const filePath = join(ROOT, flag('file') ?? defaultFile);

// ── commands ───────────────────────────────────────────────────────────────────
function resolveForWorker(cfg, values) {
  const set = {}; // { secretName: value }
  const missing = []; // canonical keys with no value in the file
  for (const [secretName, canonical] of Object.entries(cfg.secrets)) {
    const v = values[canonical];
    if (v === undefined || v === '') missing.push(canonical);
    else set[secretName] = v;
  }
  return { set, missing };
}

function cmdCheck() {
  const values = parseEnvFile(filePath);
  console.log(`env file: ${filePath}\n`);
  for (const [name, cfg] of workers) {
    const { set, missing } = resolveForWorker(cfg, values);
    console.log(`● ${name}  (${cfg.dir})`);
    for (const [secretName, canonical] of Object.entries(cfg.secrets)) {
      const present = set[secretName] !== undefined;
      const mark = present ? '✓' : '·';
      const via = secretName === canonical ? '' : `  ← ${canonical}`;
      console.log(`    ${mark} ${secretName}${via}${present ? '' : '   (unset)'}`);
    }
    void missing;
    console.log();
  }
  console.log('✓ = will be set   · = blank in the file (skipped). Values are never printed.');
}

/** Names of secrets currently set on a deployed worker (values are never returned by CF). */
function liveSecretNames(dir, envFlag) {
  const res = spawnSync('pnpm', ['exec', 'wrangler', 'secret', 'list', ...envFlag], {
    cwd: join(ROOT, dir),
    encoding: 'utf8',
  });
  if (res.status !== 0) return null; // not logged in / worker not deployed
  try {
    const json = res.stdout.slice(res.stdout.indexOf('['));
    return new Set(JSON.parse(json).map((x) => x.name));
  } catch {
    return null;
  }
}

function cmdStatus() {
  const values = parseEnvFile(filePath);
  const envFlag = env === 'prod' ? [] : ['--env', env];
  console.log(`file: ${filePath}   vs   LIVE Cloudflare secrets (env: ${env})\n`);
  console.log('  L = set in Cloudflare   F = present in the file   (CF never returns values)\n');
  for (const [name, cfg] of workers) {
    const { set } = resolveForWorker(cfg, values);
    const live = liveSecretNames(cfg.dir, envFlag);
    console.log(`● ${name}${live === null ? '  (could not list — wrangler login?)' : ''}`);
    for (const secretName of Object.keys(cfg.secrets)) {
      const inFile = set[secretName] !== undefined;
      const inCf = live === null ? null : live.has(secretName);
      const l = inCf === null ? '?' : inCf ? 'L' : '·';
      const f = inFile ? 'F' : '·';
      const note = inCf && !inFile ? '  live, not in file (write-only — can\'t be exported)' : !inCf && inFile ? '  in file, NOT live → push will set it' : '';
      console.log(`    [${l}${f}] ${secretName}${note}`);
    }
    console.log();
  }
}

function cmdPush() {
  const values = parseEnvFile(filePath);
  const envFlag = env === 'prod' ? [] : ['--env', env];
  console.log(`Pushing secrets from ${filePath}  (env: ${env})${dryRun ? '  [dry-run]' : ''}\n`);
  for (const [name, cfg] of workers) {
    const { set } = resolveForWorker(cfg, values);
    const names = Object.keys(set);
    if (names.length === 0) {
      console.log(`● ${name}: nothing to set (all keys blank) — skipped`);
      continue;
    }
    console.log(`● ${name}: ${names.join(', ')}`);
    if (dryRun) continue;
    const res = spawnSync('pnpm', ['exec', 'wrangler', 'secret', 'bulk', ...envFlag], {
      cwd: join(ROOT, cfg.dir),
      input: JSON.stringify(set),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    if (res.status !== 0) fail(`wrangler secret bulk failed for ${name} (exit ${res.status})`);
  }
  if (!dryRun) console.log('\n✓ done. Redeploy the affected workers so a NEW secret takes effect on the next deploy.');
}

function cmdDev() {
  const values = parseEnvFile(filePath);
  console.log(`Writing .dev.vars from ${filePath}${dryRun ? '  [dry-run]' : ''}\n`);
  for (const [name, cfg] of workers) {
    const { set } = resolveForWorker(cfg, values);
    const lines = Object.entries(set).map(([k, v]) =>
      v.includes('\n') ? `${k}="${v.replace(/\n/g, '\\n')}"` : `${k}=${v}`,
    );
    const dest = join(ROOT, cfg.dir, '.dev.vars');
    console.log(`● ${name}: ${Object.keys(set).length} vars → ${cfg.dir}/.dev.vars`);
    if (!dryRun) writeFileSync(dest, lines.join('\n') + (lines.length ? '\n' : ''));
  }
  if (!dryRun) console.log('\n✓ .dev.vars written (gitignored). `wrangler dev` / the dev servers load them automatically.');
}

function cmdGenerate() {
  const path = filePath;
  let text = readFileSync(path, 'utf8'); // must already exist
  const values = parseEnvFile(path);
  // `--keys A,B` restricts to a subset (e.g. just the shared cross-worker tokens);
  // `--force` overwrites even a key that already has a value (a deliberate rotation).
  const only = flag('keys')?.split(',').map((s) => s.trim());
  const force = has('force');
  const targets = only ? GENERATABLE.filter((k) => only.includes(k)) : GENERATABLE;
  if (only) {
    const unknown = only.filter((k) => !GENERATABLE.includes(k));
    if (unknown.length) fail(`not generatable: ${unknown.join(', ')} (generatable: ${GENERATABLE.join(', ')})`);
  }
  let filled = 0;
  for (const key of targets) {
    if (values[key] && !force) continue;
    const value = key === 'SECRET_BOX_KEY' ? randBase64(32) : randHex(32);
    // Replace a blank `KEY=` line if present, else append.
    const re = new RegExp(`^(${key}=).*$`, 'm');
    if (re.test(text)) text = text.replace(re, `$1${value}`);
    else text += `${text.endsWith('\n') ? '' : '\n'}${key}=${value}\n`;
    filled++;
  }
  writeFileSync(path, text);
  console.log(filled ? `✓ filled ${filled} blank generatable secret(s) in ${path}` : `nothing to fill in ${path}`);
}

/**
 * Re-put the two platform verification secrets on EVERY vertical script in the env's
 * dispatch namespace. Vertical scripts receive PLATFORM_SECRET/ROUTER_SECRET as baked-in
 * bindings at deploy time (wfp.ts injectSecrets) — so a `push` that rotates them updates
 * the three platform workers but leaves every already-deployed vertical verifying against
 * the OLD values: the router's node assertion is rejected (users locked out) and the
 * control plane's /internal/* calls 403 (Data tab, config delivery, provisioning). This
 * is rotation step 2; without it the fleet is down until each vertical redeploys.
 * (2026-08-01: the first prod rotation shipped without this and took every hosted app
 * offline until the secrets were re-put by hand.)
 */
async function cmdVerticals() {
  if (env !== 'prod' && env !== 'test') fail(`--env must be prod or test for verticals (got '${env}')`);
  const values = parseEnvFile(filePath);
  const namespace = env === 'prod' ? 'substrat-verticals' : 'substrat-verticals-test';
  for (const key of ['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'PLATFORM_SECRET', 'ROUTER_SECRET']) {
    if (!values[key]) fail(`${key} is blank in ${filePath}`);
  }
  const api = `https://api.cloudflare.com/client/v4/accounts/${values.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${namespace}`;
  const headers = { Authorization: `Bearer ${values.CF_API_TOKEN}`, 'Content-Type': 'application/json' };
  const listed = await (await fetch(`${api}/scripts?per_page=100`, { headers })).json();
  if (!listed.success) fail(`could not list ${namespace} scripts: ${JSON.stringify(listed.errors)}`);
  const scripts = listed.result.map((r) => r.id);
  console.log(`● ${namespace}: ${scripts.length} script(s) × PLATFORM_SECRET, ROUTER_SECRET${dryRun ? '  [dry-run]' : ''}`);
  if (dryRun) {
    for (const s of scripts) console.log(`    ${s}`);
    return;
  }
  let failures = 0;
  for (const script of scripts) {
    for (const name of ['PLATFORM_SECRET', 'ROUTER_SECRET']) {
      const res = await (
        await fetch(`${api}/scripts/${script}/secrets`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ name, text: values[name], type: 'secret_text' }),
        })
      ).json();
      if (!res.success) {
        failures++;
        console.error(`    ✗ ${script} ${name}: ${JSON.stringify(res.errors)}`);
      }
    }
  }
  if (failures) fail(`${failures} secret put(s) failed`);
  console.log('✓ done. Vertical scripts verify router/platform calls with the current secrets immediately.');
}

function randHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randBase64(bytes) {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64');
}

switch (cmd) {
  case 'check':
    cmdCheck();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'push':
    cmdPush();
    break;
  case 'verticals':
    await cmdVerticals();
    break;
  case 'dev':
    cmdDev();
    break;
  case 'generate':
    cmdGenerate();
    break;
  default:
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 22).join('\n').replace(/^ \*?/gm, ''));
    if (cmd) fail(`unknown command '${cmd}'`);
}
