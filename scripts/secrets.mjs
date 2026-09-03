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
 *   node scripts/secrets.mjs push --env prod       # upload to the deployed workers, THEN re-put
 *                                                  # the pair on every vertical (both rotation steps)
 *   node scripts/secrets.mjs push --env test       # same, for the CI test workers (<name>-test)
 *   node scripts/secrets.mjs verticals --env prod  # just step 2: PLATFORM_SECRET/ROUTER_SECRET on every
 *                                                  # dispatch-namespace vertical script
 *   node scripts/secrets.mjs dev                    # write each worker's .dev.vars for `wrangler dev`
 *
 * --file <path>   override the env file (defaults: secrets/platform.<env>.env, and
 *                 secrets/platform.dev.env for `dev`)
 * --only <worker> restrict to one worker: control-plane | builder | dashboard | router
 * --dry-run       print what WOULD be set (secret NAMES only — never values)
 * --allow-incomplete  let `push` proceed with a REQUIRED key blank (it refuses by default;
 *                 `check` exits non-zero on the same condition, so it gates a deploy).
 *                 Both apply to deployed envs only — `--env dev` reports and moves on.
 * --skip-verticals  push the platform workers only, leaving the fleet on the OLD
 *                 PLATFORM_SECRET/ROUTER_SECRET. Correct only when you know those two
 *                 values did not change; see cmdVerticals for what step 2 is for.
 *
 * `push` runs step 2 itself (#979). It used to stop after the three workers and leave a
 * printed reminder, which is how the 2026-08-01 rotation took the hosted fleet down: a
 * rotation is not finished when the platform workers have the new values, it is finished
 * when the verticals verifying against them do.
 *
 * `generate` fills any blank generatable field, so rotating the three shared tokens is
 * `generate --keys SERVICE_TOKEN,PLATFORM_SECRET,ROUTER_SECRET --force` followed by
 * `push` — and unlike a fresh-random-with-no-file rotate, the values survive in the file,
 * which matters because Cloudflare never gives a secret back.
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
 *
 * `required` lists the secrets a worker cannot do its job without. Everything else is
 * genuinely optional, and that distinction is the point: before it existed, a blank key
 * and an unused key printed the same dot, so a missing one only surfaced as a runtime
 * 500 from whatever feature needed it (CP_SECRET_BOX_KEY, added with #574 and never
 * filled in, took down connection storage exactly this way). `check` now exits non-zero
 * and `push` refuses when a required key is blank.
 */
const MANIFEST = {
  'control-plane': {
    dir: 'apps/control-plane',
    required: [
      'OIDC_ISSUER',
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
      'SESSION_SECRET',
      'SERVICE_TOKEN',
      'PLATFORM_SECRET',
      'ROUTER_SECRET',
      'PUSH_TOKEN_SECRET',
      // Without it the host falls back to `unconfiguredSecretBox` and every connection
      // upsert rejects — the plane cannot store a provider credential at all.
      'SECRET_BOX_KEY',
      'CF_API_TOKEN',
      'CF_ACCOUNT_ID',
    ],
    secrets: {
      OIDC_ISSUER: 'OIDC_ISSUER',
      OIDC_CLIENT_ID: 'CP_OIDC_CLIENT_ID',
      OIDC_CLIENT_SECRET: 'CP_OIDC_CLIENT_SECRET',
      SESSION_SECRET: 'CP_SESSION_SECRET',
      SERVICE_TOKEN: 'SERVICE_TOKEN',
      PLATFORM_SECRET: 'PLATFORM_SECRET',
      ROUTER_SECRET: 'ROUTER_SECRET',
      PUSH_TOKEN_SECRET: 'CP_PUSH_TOKEN_SECRET',
      // Seals connection credentials in the directory (#574) — the CP's own box,
      // deliberately NOT the dashboard's key (different stores, independent rotation).
      SECRET_BOX_KEY: 'CP_SECRET_BOX_KEY',
      SECRET_BOX_KEY_ID: 'CP_SECRET_BOX_KEY_ID',
      CF_API_TOKEN: 'CF_API_TOKEN',
      CF_ACCOUNT_ID: 'CF_ACCOUNT_ID',
      CF_SAAS_ZONE_ID: 'CF_SAAS_ZONE_ID',
      // Behavioural config — override wrangler.jsonc `vars` only if set in the file.
      // (PLATFORM_BASE_DOMAINS is deliberately NOT here: it is a checked-in `vars`
      // entry (#423), and a secret cannot share a name with a var.)
      CF_SAAS_ROUTING_TARGET: 'CF_SAAS_ROUTING_TARGET',
      CF_SAAS_SSL_METHOD: 'CF_SAAS_SSL_METHOD',
      // #990: the four retention windows and the sender address. Read by the worker,
      // documented only in a wrangler.jsonc comment until now — so `check` reported
      // full coverage on a deployment that had never chosen a retention policy, and
      // the only way to see what a plane was actually configured with was to read the
      // worker's source. Every one of them is opt-in and unset by default (each reap
      // is irreversible), which is exactly why the map has to NAME them: an
      // unnamed-and-unset var and a deliberately-unset one print the same nothing.
      SCOPE_RETENTION_DAYS: 'CP_SCOPE_RETENTION_DAYS',
      TENANT_RETENTION_DAYS: 'CP_TENANT_RETENTION_DAYS',
      SCOPE_BACKUP_RETENTION_DAYS: 'CP_SCOPE_BACKUP_RETENTION_DAYS',
      ACCESS_LOG_RETENTION_DAYS: 'CP_ACCESS_LOG_RETENTION_DAYS',
      // The From address on mail the plane sends on a vertical's behalf (the
      // `emailSender` relay). Its own key, not the dashboard's DASH_EMAIL_FROM:
      // different senders, and a shared key would make one worker's choice the other's.
      EMAIL_FROM: 'CP_EMAIL_FROM',
      // The support desk's verification secret — what the console's identity claim is
      // signed with (`/api/support/identity`). ONE canonical key for both platform
      // apps, because they embed the SAME desk and a desk verifies against exactly one
      // secret: two keys here would let the console and the dashboard drift onto
      // different halves of a rotation, and only one of them would work.
      // Optional: unset ⇒ neither app carries a support bubble.
      SUPPORT_WIDGET_SECRET: 'SUPPORT_WIDGET_SECRET',
    },
  },
  builder: {
    dir: 'apps/builder',
    // The shell only. The model-provider keys below are deliberately NOT required: the
    // studio resolves whichever providers are configured, so a plane running one provider
    // is a supported deployment, not a half-configured one.
    required: ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'SESSION_SECRET', 'CP_SERVICE_TOKEN'],
    secrets: {
      // Staff-only studio (#625): OIDC + session only — the shell holds NO
      // model-provider keys; those arrive with #626 (ContainerWorkspace).
      OIDC_ISSUER: 'OIDC_ISSUER',
      OIDC_CLIENT_ID: 'BUILDER_OIDC_CLIENT_ID',
      OIDC_CLIENT_SECRET: 'BUILDER_OIDC_CLIENT_SECRET',
      SESSION_SECRET: 'BUILDER_SESSION_SECRET',
      // The control plane's SERVICE_TOKEN, under the studio's name for it —
      // membership lookups (/internal/builder/identity-tenants), dashboard-style.
      CP_SERVICE_TOKEN: 'SERVICE_TOKEN',
      // Model-provider keys (#626): the DO resolves models from these — the
      // container/image NEVER carries them (§5.3, §10). D-53: each provider is
      // a disclosed subprocessor of the customer's code.
      ANTHROPIC_API_KEY: 'BUILDER_ANTHROPIC_API_KEY',
      DASHSCOPE_API_KEY: 'BUILDER_DASHSCOPE_API_KEY',
      DASHSCOPE_BASE_URL: 'BUILDER_DASHSCOPE_BASE_URL',
      CLOUDFLARE_AI_BASE_URL: 'BUILDER_CLOUDFLARE_AI_BASE_URL',
      CLOUDFLARE_AI_API_TOKEN: 'BUILDER_CLOUDFLARE_AI_API_TOKEN',
    },
  },
  dashboard: {
    dir: 'apps/dashboard',
    required: [
      'OIDC_ISSUER',
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
      'SESSION_SECRET',
      'CP_SERVICE_TOKEN',
      // Seals the dashboard's own GitHub App connections — its directory, not the CP's.
      'SECRET_BOX_KEY',
      'GITHUB_APP_ID',
      'GITHUB_APP_SLUG',
      'GITHUB_APP_PRIVATE_KEY',
    ],
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
      // The same desk secret the console holds — see the control plane's note above.
      SUPPORT_WIDGET_SECRET: 'SUPPORT_WIDGET_SECRET',
      // The Fortnox Developer Portal client pair (#1220) — platform secrets behind the
      // dashboard's Fortnox Connect button + connect links. Optional: unset, the
      // consent flow answers "not configured" and the paste-credential path remains.
      FORTNOX_CLIENT_ID: 'FORTNOX_CLIENT_ID',
      FORTNOX_CLIENT_SECRET: 'FORTNOX_CLIENT_SECRET',
    },
  },
  router: {
    dir: 'apps/router',
    required: ['PLATFORM_SECRET', 'ROUTER_SECRET'],
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
  'BUILDER_SESSION_SECRET',
  'CP_PUSH_TOKEN_SECRET',
  'SECRET_BOX_KEY', // base64 of 32 bytes (AES-256); the rest are hex
  'CP_SECRET_BOX_KEY', // base64 of 32 bytes — the control plane's connection box (#574)
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

// `required` gates DEPLOYED environments only. `secrets/platform.dev.env` is throwaway
// and legitimately partial (its README says so) — a local machine with no CF token is a
// working dev setup, not a broken deploy, so dev reports the gaps without failing.
const enforcingRequired = env !== 'dev';
const workers = Object.entries(MANIFEST).filter(([name]) => !only || name === only);
if (only && workers.length === 0) fail(`unknown --only worker '${only}' (control-plane | builder | dashboard | router)`);

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
  const missingRequired = []; // ...of those, the ones the worker cannot run without
  const required = new Set(cfg.required ?? []);
  for (const [secretName, canonical] of Object.entries(cfg.secrets)) {
    const v = values[canonical];
    if (v === undefined || v === '') {
      missing.push(canonical);
      if (required.has(secretName)) missingRequired.push({ secretName, canonical });
    } else set[secretName] = v;
  }
  return { set, missing, missingRequired, required };
}

function cmdCheck() {
  const values = parseEnvFile(filePath);
  console.log(`env file: ${filePath}\n`);
  const gaps = [];
  for (const [name, cfg] of workers) {
    const { set, missingRequired, required } = resolveForWorker(cfg, values);
    console.log(`● ${name}  (${cfg.dir})`);
    for (const [secretName, canonical] of Object.entries(cfg.secrets)) {
      const present = set[secretName] !== undefined;
      const req = required.has(secretName);
      const mark = present ? '✓' : req ? '✗' : '·';
      const via = secretName === canonical ? '' : `  ← ${canonical}`;
      const note = present ? '' : req ? '   (REQUIRED — unset)' : '   (unset)';
      console.log(`    ${mark} ${secretName}${via}${note}`);
    }
    for (const m of missingRequired) gaps.push({ worker: name, ...m });
    console.log();
  }
  console.log('✓ = will be set   · = blank, optional (skipped)   ✗ = blank but REQUIRED.');
  console.log('Values are never printed.');
  if (gaps.length) {
    const out = enforcingRequired ? console.error : console.log;
    out(`\n${enforcingRequired ? '✗' : '·'} ${gaps.length} required secret(s) missing from ${filePath}:`);
    for (const g of gaps) out(`    ${g.worker}: ${g.secretName}  ← ${g.canonical}`);
    out(`\n  fill them (generatable ones: node scripts/secrets.mjs generate --env ${env} --keys <KEY>)`);
    if (enforcingRequired) process.exit(1);
    console.log('  (env dev — reported, not enforced)');
  }
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
    const { set, required } = resolveForWorker(cfg, values);
    const live = liveSecretNames(cfg.dir, envFlag);
    console.log(`● ${name}${live === null ? '  (could not list — wrangler login?)' : ''}`);
    for (const secretName of Object.keys(cfg.secrets)) {
      const inFile = set[secretName] !== undefined;
      const inCf = live === null ? null : live.has(secretName);
      const l = inCf === null ? '?' : inCf ? 'L' : '·';
      const f = inFile ? 'F' : '·';
      // A required secret that is live nowhere is the one line worth shouting about:
      // the worker is deployed and running without it.
      const note =
        inCf === false && required.has(secretName) && !inFile
          ? '  ✗ REQUIRED, not live and not in the file — this worker is running without it'
          : inCf && !inFile
            ? "  live, not in file (write-only — can't be exported)"
            : !inCf && inFile
              ? '  in file, NOT live → push will set it'
              : '';
      console.log(`    [${l}${f}] ${secretName}${note}`);
    }
    console.log();
  }
}

/**
 * Whether this `push` also runs the vertical re-put (#979).
 *
 * Only a DEPLOYED env has a dispatch namespace, so `dev` never does. `--only` is a
 * deliberately partial push at one worker, which is not a rotation. `--skip-verticals`
 * is the escape for the case where PLATFORM_SECRET/ROUTER_SECRET did not change and the
 * fleet walk is just slow.
 */
const pushRunsVerticals =
  (env === 'prod' || env === 'test') && !only && !has('skip-verticals');

/** What `cmdVerticals` cannot run without — checked BEFORE the push, not after. */
const VERTICALS_KEYS = ['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'PLATFORM_SECRET', 'ROUTER_SECRET'];

async function cmdPush() {
  const values = parseEnvFile(filePath);
  const envFlag = env === 'prod' ? [] : ['--env', env];
  console.log(`Pushing secrets from ${filePath}  (env: ${env})${dryRun ? '  [dry-run]' : ''}\n`);
  // Refuse BEFORE setting anything: a half-configured worker is the failure mode this
  // whole distinction exists to prevent. `--allow-incomplete` is the deliberate override
  // (a scratch env that genuinely runs without some feature).
  const gaps = workers.flatMap(([name, cfg]) =>
    resolveForWorker(cfg, values).missingRequired.map((m) => ({ worker: name, ...m })),
  );
  if (gaps.length && enforcingRequired && !has('allow-incomplete')) {
    console.error(`✗ ${gaps.length} required secret(s) blank in ${filePath} — nothing pushed:`);
    for (const g of gaps) console.error(`    ${g.worker}: ${g.secretName}  ← ${g.canonical}`);
    fail('fill them, or pass --allow-incomplete to push anyway');
  }
  // Same discipline for step 2, and for a sharper reason: refusing here costs a retry,
  // whereas discovering it after the workers are pushed leaves the platform on the new
  // values and the whole fleet on the old ones — the 2026-08-01 outage exactly.
  // (`--allow-incomplete` can get past the gate above with these blank.)
  if (pushRunsVerticals) {
    const missing = VERTICALS_KEYS.filter((k) => !values[k]);
    if (missing.length) {
      console.error(`✗ ${missing.join(', ')} blank in ${filePath} — nothing pushed.`);
      console.error('  push finishes the rotation by re-putting PLATFORM_SECRET/ROUTER_SECRET on');
      console.error('  every deployed vertical, and cannot do that without them.');
      fail('fill them, or pass --skip-verticals to push the platform workers only');
    }
  }
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
  // Step 2, in the same command. A rotation that stops here has updated the three
  // platform workers and left every deployed vertical verifying against the old pair.
  if (pushRunsVerticals && dryRun) {
    // A dry run stays local. Step 2's listing is a live Cloudflare GET, so doing it here
    // would make `--dry-run` exit non-zero on a bad token while writing nothing —
    // `verticals --env <env> --dry-run` is the command that shows the fleet.
    console.log('\n[dry-run] would then re-put PLATFORM_SECRET, ROUTER_SECRET on every');
    console.log(`          vertical — see \`node scripts/secrets.mjs verticals --env ${env} --dry-run\``);
  } else if (pushRunsVerticals) {
    console.log('\n── rotation step 2: the fleet ─────────────────────────────────────');
    await cmdVerticals();
  } else if (env === 'prod' || env === 'test') {
    console.log(
      `\n! vertical re-put SKIPPED (${only ? `--only ${only}` : '--skip-verticals'}). If PLATFORM_SECRET or`,
    );
    console.log('  ROUTER_SECRET changed, run `node scripts/secrets.mjs verticals --env ' + env + '`');
    console.log('  now — until it runs, every hosted app rejects the router and the control plane.');
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
    // Every *_SECRET_BOX_KEY wants base64 of 32 raw bytes; the worker refuses anything
    // that does not decode to exactly 32 ("must decode to 32 bytes"). Keying this off the
    // exact name minted CP_SECRET_BOX_KEY as 64 hex chars, which decodes to 48 and is
    // rejected. The rest are opaque hex tokens, where the encoding carries no meaning.
    const value = key.endsWith('SECRET_BOX_KEY') ? randBase64(32) : randHex(32);
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
/**
 * Every script in the dispatch namespace, following Cloudflare's pages.
 *
 * It used to ask for `?per_page=100` once and take whatever came back. A namespace
 * holds one script per deployed vertical VERSION, not per vertical, so 100 is a
 * ceiling the fleet grows through — and the failure is silent in the worst way: the
 * walk reports success having skipped every script past the first page, which is the
 * same fleet-down state as not running step 2 at all, minus the clue.
 */
async function listScripts(api, headers, namespace) {
  const ids = [];
  for (let page = 1; ; page++) {
    const res = await (await fetch(`${api}/scripts?per_page=100&page=${page}`, { headers })).json();
    if (!res.success) fail(`could not list ${namespace} scripts (page ${page}): ${JSON.stringify(res.errors)}`);
    const batch = res.result ?? [];
    ids.push(...batch.map((r) => r.id));
    // Stop on the first short/empty page, and independently on the reported total — a
    // full last page with no `result_info` would otherwise loop forever.
    const total = res.result_info?.total_count;
    if (batch.length === 0 || batch.length < 100) break;
    if (typeof total === 'number' && ids.length >= total) break;
  }
  return ids;
}

async function cmdVerticals() {
  if (env !== 'prod' && env !== 'test') fail(`--env must be prod or test for verticals (got '${env}')`);
  const values = parseEnvFile(filePath);
  const namespace = env === 'prod' ? 'substrat-verticals' : 'substrat-verticals-test';
  for (const key of VERTICALS_KEYS) {
    if (!values[key]) fail(`${key} is blank in ${filePath}`);
  }
  const api = `https://api.cloudflare.com/client/v4/accounts/${values.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${namespace}`;
  const headers = { Authorization: `Bearer ${values.CF_API_TOKEN}`, 'Content-Type': 'application/json' };
  const scripts = await listScripts(api, headers, namespace);
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
    await cmdPush();
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
    // Lines 3–30 of this file: the intro, the command list and the flags. Kept as a
    // slice rather than a duplicated string so the help cannot drift from the header.
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 30).join('\n').replace(/^ \*?/gm, ''));
    if (cmd) fail(`unknown command '${cmd}'`);
}
