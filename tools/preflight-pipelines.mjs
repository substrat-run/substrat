#!/usr/bin/env node
/**
 * Refuse to deploy while a pipelines binding names a stream the account does not have.
 *
 * `wrangler deploy` reports this as an API failure on `/workers/scripts/<name>/versions`
 * with `code: 10166` and a stream id nobody recognises, after it has already built the
 * assets and printed the whole binding table — so the error reads like a platform fault
 * rather than a stale value in a repository variable. On 2026-09-18 that failed a
 * release to main, and the cause was three days old: the Tier-2 lake had been recreated,
 * which mints a NEW stream id, and `scripts/lake-provision.mjs`'s epilogue (its steps
 * 1–3) had not been run.
 *
 * Nothing keeps the id in step, and nothing can:
 *
 *   - **Wrangler's pipelines binding takes an id, not a name** (`"stream": "<id>"`; the
 *     `pipeline` spelling is the same thing, deprecated). A name would survive a
 *     recreate, an id cannot, so the id has to be carried — for us in the repository
 *     variable `CF_PIPELINE_OUTBOX_STREAM_ID`, spliced in by `tools/wrangler-config.mjs`.
 *   - The committed config carries a `${…}` placeholder, so a reviewer reading a diff
 *     sees nothing change when the account does.
 *
 * This does NOT fix the id — that is `secrets/platform.prod.env` plus
 * `node scripts/secrets.mjs github`, because CI reads the variable and never the file.
 * It turns an opaque deploy failure into a message naming the variable.
 *
 * Usage:  node tools/preflight-pipelines.mjs --config wrangler.generated.jsonc [--env <name>] [packageDir]
 *
 * Read against the GENERATED config, like preflight-migrations: the committed one holds
 * placeholders, and `${CF_PIPELINE_OUTBOX_STREAM_ID}` matches no stream by construction.
 *
 * ## What it refuses on, and what it only warns about
 *
 * It refuses on ONE answer: the account was asked about this id and said it does not
 * have it. Everything else — no account id to pin, no usable credential, a beta command
 * that changed its output — is reported and **exits 0**.
 *
 * That split is deliberate, and it is the difference between a check people keep and a
 * check people delete. This adds no safety property: a wrong id fails the deploy either
 * way, thirty seconds later, with a worse message. All it buys is the message. Buying
 * that at the price of a new way for a prod deploy to fail — a CI token missing Pipelines
 * Read, say — would be a bad trade, and the first spurious red would get it removed.
 *
 * The account is PINNED rather than left to wrangler, for the same reason. A
 * `wrangler login` reaches several accounts; if one resolved where the stream
 * legitimately does not exist, the answer would be "not found" and this would refuse a
 * perfectly good deploy. So the id comes from `CLOUDFLARE_ACCOUNT_ID` (what CI sets) or
 * `CF_ACCOUNT_ID` in the secrets file (what a local deploy reads), and when neither is
 * present the check declines to answer instead of guessing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { parseJsonc } from './jsonc.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
// Flags and their values removed by index, not by a chain of comparisons — the same shape
// preflight-migrations settled on after `--config` silently became its positional argument.
const FLAGS_WITH_VALUES = ['--env', '--config'];
const consumed = new Set();
for (const f of FLAGS_WITH_VALUES) {
  const i = argv.indexOf(f);
  if (i !== -1) {
    consumed.add(i);
    consumed.add(i + 1);
  }
}
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 ? argv[i + 1] : undefined;
};
const envName = flag('env');
const configOverride = flag('config');
const pkgDir = resolvePath(argv.filter((_, i) => !consumed.has(i))[0] ?? process.cwd());

const say = (msg) => console.log(`preflight-pipelines: ${msg}`);
/** Reported, never fatal — see the header. `exit 0` is the whole point of this path. */
function cannotAnswer(why, hint) {
  console.warn(`preflight-pipelines: not checked — ${why}`);
  if (hint) console.warn(`  ${hint}`);
  process.exit(0);
}

// ── The config ───────────────────────────────────────────────────────────────────────

const configPath = configOverride
  ? join(pkgDir, configOverride)
  : ['wrangler.jsonc', 'wrangler.json'].map((f) => join(pkgDir, f)).find(existsSync);
if (configOverride && !existsSync(configPath)) {
  // Not a silent skip, on preflight-migrations' rule: the caller ASKED for this file, and a
  // deploy that checked nothing because the generated config was missing is the failure the
  // check exists to catch.
  console.error(`preflight-pipelines: --config ${configOverride} does not exist in ${pkgDir}.`);
  console.error('  Run tools/wrangler-config.mjs first — it is what produces it.');
  process.exit(2);
}
if (!configPath) {
  say('no wrangler config here — nothing to check.');
  process.exit(0);
}

const config = parseJsonc(readFileSync(configPath, 'utf8'));
// A named environment redefines bindings — wrangler does not inherit `pipelines` into
// `env.<name>`, which its own config schema says in as many words — so gate on that
// environment's bindings when one is given.
const scope = envName ? config.env?.[envName] : config;
if (envName && !config.env?.[envName]) {
  say(`no [env.${envName}] in ${configPath} — nothing to check.`);
  process.exit(0);
}

// `stream` is the current spelling and `pipeline` the deprecated one for the same value.
// Both are read, so a config still on the old key is checked rather than silently skipped.
// Deduplicated by id: two bindings may legitimately point at one stream, and asking twice
// would only double the lookups and report the same miss twice. Every binding on an id is
// kept, though — two bindings can name one stream through different placeholders, and the
// refusal has to name them all or fixing the one it reported leaves the next deploy red.
const byId = new Map();
for (const p of scope?.pipelines ?? []) {
  const id = p.stream ?? p.pipeline;
  if (typeof id !== 'string' || id === '') continue;
  const binding = p.binding ?? '(unnamed binding)';
  const seen = byId.get(id);
  if (!seen) byId.set(id, [binding]);
  else if (!seen.includes(binding)) seen.push(binding);
}
const ids = [...byId].map(([id, bindings]) => ({ id, bindings }));

if (ids.length === 0) {
  say('no pipelines bindings — nothing to check.');
  process.exit(0);
}

if (ids.some((p) => p.id.includes('${'))) {
  // An unresolved placeholder means this ran against the committed config rather than the
  // generated one. wrangler-config refuses to WRITE one of these, so reaching here means
  // the wrong file was passed — worth saying, because the check would otherwise report a
  // literal `${…}` as a missing stream and send someone hunting in the wrong account.
  cannotAnswer(
    'the config still holds an unresolved placeholder',
    'Pass the generated config (--config wrangler.generated.jsonc), not the committed template.',
  );
}

// ── The account ──────────────────────────────────────────────────────────────────────

/** Same flat-env parse as scripts/secrets.mjs — KEY=VALUE, `#` comments, optional quotes. */
function envFileValue(path, key) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined; // Absent is fine: CI has no env file, it has process.env.
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

// Always the prod file, whatever `--env` says: `--env` names the WRANGLER environment (the
// bindings to read), while the ids themselves come from one account file on both deploy
// paths — `cf:deploy:test` resolves them through wrangler-config's own `prod` default too.
// process.env first, which is the CI path and the one that must win.
const SECRETS = join(ROOT, 'secrets/platform.prod.env');
/**
 * `??` is wrong here and `||` is right: GitHub Actions sets an env var from an undefined
 * `vars.X` to the EMPTY STRING, not to nothing. With `??` that empty string would win over
 * the file and be passed to wrangler as the account to pin to, which fails as something
 * other than "not found" — so the check would report itself unable to answer on exactly
 * the misconfiguration it should be loudest about.
 */
const fromEnv = (key) => {
  const v = process.env[key];
  return v === undefined || v === '' ? undefined : v;
};
const account = fromEnv('CLOUDFLARE_ACCOUNT_ID') ?? envFileValue(SECRETS, 'CF_ACCOUNT_ID');
if (!account) {
  cannotAnswer(
    'no account id to pin the lookup to',
    'Set CLOUDFLARE_ACCOUNT_ID, or CF_ACCOUNT_ID in secrets/platform.prod.env. Guessing is\n' +
      '  worse than skipping: a login reaches several accounts, and the wrong one answers\n' +
      '  "not found" for a stream that is perfectly fine.',
  );
}

// ── The lookup ───────────────────────────────────────────────────────────────────────

/**
 * Ask the account about one stream id: `'ok'`, `'missing'`, or a string explaining why the
 * question could not be answered.
 *
 * `streams get` rather than `streams list`: a get is the question being asked, and it
 * answers by exit code (0 / 1 with `Stream "<id>" not found.` on stderr). A list would
 * mean parsing wrangler's table, which is the thing scripts/lake-provision.mjs went to the
 * REST API to avoid.
 *
 * `missing` is claimed ONLY on that message. An exit 1 that says anything else — a
 * credential without Pipelines Read, a beta command that moved — is not evidence the
 * stream is absent, and reading it as such is how this check would start failing good
 * deploys.
 */
function lookup(id) {
  try {
    execFileSync('npx', ['wrangler', 'pipelines', 'streams', 'get', id], {
      cwd: pkgDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: account },
    });
    return 'ok';
  } catch (err) {
    const text = String(err.stdout ?? '') + String(err.stderr ?? '');
    if (/stream\s+"?[^"\s]+"?\s+not found/i.test(text)) return 'missing';
    return summarise(text);
  }
}

/**
 * The useful lines of a wrangler failure.
 *
 * Wrangler ends every error with the same three things — a telemetry notice, "if you think
 * this is a bug", and where it wrote its log — so the LAST lines are reliably the least
 * informative. Colour codes have to go too: this text is re-printed inside our own message,
 * where a stray escape sequence would swallow the rest of the line.
 */
function summarise(text) {
  const NOISE = /telemetry|open an issue|Logs were written|workers-sdk\/issues|^\s*$|^-+$|^\s*⛅|^\s*🪵|open beta command/i;
  const lines = text
    // eslint-disable-next-line no-control-regex -- stripping ANSI is the point
    .replace(/\u001B\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !NOISE.test(l));
  // Prefer what wrangler marked as the error; fall back to the first real lines.
  const marked = lines.filter((l) => /(ERROR|✘|error)/.test(l));
  const pick = (marked.length ? marked : lines).slice(0, 3);
  return pick.join('\n    ') || 'wrangler exited non-zero';
}

const missing = [];
for (const { bindings, id } of ids) {
  const verdict = lookup(id);
  if (verdict === 'ok') continue;
  if (verdict === 'missing') {
    missing.push({ bindings, id });
    continue;
  }
  cannotAnswer(`could not ask the account about ${bindings.join(', ')}`, verdict);
}

if (missing.length === 0) {
  say(`${ids.length} pipelines binding(s) resolve in account ${account}.`);
  process.exit(0);
}

// ── The refusal ──────────────────────────────────────────────────────────────────────

/**
 * Every `${…}` placeholder that produced this id, resolved by matching values rather than
 * by parsing the template's shape. The generated config holds the id and not the name it
 * came from, and "set CF_PIPELINE_OUTBOX_STREAM_ID" is a far more useful sentence than
 * "the id is wrong" — so it is worth reading the two source files back to recover it. All
 * of them, not the first: an id two bindings share may come from two variables, and each is
 * a stale value that fails the next deploy once the other is fixed.
 */
function placeholdersFor(id) {
  let text = '';
  for (const f of ['wrangler.jsonc', 'wrangler.deploy.json']) {
    try {
      text += readFileSync(join(pkgDir, f), 'utf8');
    } catch {
      // A missing overlay is normal — only the apps that need one carry it.
    }
  }
  const names = new Set();
  for (const [, name] of text.matchAll(/\$\{([A-Z0-9_]+)\}/g)) {
    if ((fromEnv(name) ?? envFileValue(SECRETS, name)) === id) names.add(name);
  }
  return [...names];
}

console.error('\npreflight-pipelines: refusing to deploy — a pipelines binding names a stream\n');
console.error(`  account ${account} does not have:\n`);
for (const { bindings, id } of missing) {
  const names = placeholdersFor(id);
  console.error(`  ${bindings.join(', ')}`);
  console.error(`    stream ${id}`);
  console.error(
    `    from   ${names.length ? names.map((n) => `\${${n}}`).join(', ') : 'an id this tool could not trace to a placeholder'}`,
  );
}
console.error(`
  A stream id CHANGES whenever the lake is recreated, and the binding can only name an
  id — wrangler has no name form. So this is almost always a recreate whose epilogue was
  not finished, not a deleted stream.

  The live id:
    CLOUDFLARE_ACCOUNT_ID=${account} npx wrangler pipelines streams list

  Then, one at a time:
    1. set it in secrets/platform.prod.env
    2. node scripts/secrets.mjs github     # CI reads the VARIABLE, never the file
    3. deploy again

  Step 2 is the one that is easy to skip and the only one this failure is about: a deploy
  from a laptop reads the file and passes, while every release keeps failing on the stale
  variable.
`);
process.exit(1);
