#!/usr/bin/env node
/**
 * Resolve the account-specific ids out of a worker's wrangler config, so the committed
 * one names none of them.
 *
 * A public repo that anybody may fork carries every binding its deploys need, and two
 * kinds of value sit in those bindings. A NAME — `substrat-verticals`,
 * `substrat-scope-backups` — is portable: a fork keeping it creates its own resource under
 * that name and everything works. An opaque ID is not. `database_id` and a pipelines
 * `stream` point at exactly one account, so a fork inherits a config addressing OUR
 * resources, which fails confusingly at best and is a mess at worst. Those are what this
 * substitutes, and deliberately nothing else: replacing the names too would make every
 * config unreadable to buy nothing.
 *
 *   node tools/wrangler-config.mjs --app control-plane            # → wrangler.generated.jsonc
 *   node tools/wrangler-config.mjs --app control-plane --check    # resolve, emit nothing
 *
 * Values resolve from `process.env` FIRST, then `secrets/platform.<env>.env`. That order
 * is what lets one tool serve both paths: CI holds them as GitHub Actions secrets, a
 * local deploy reads the same env file `secrets.mjs` treats as the account's source of
 * truth, and neither has to know about the other.
 *
 * A DEPLOY-ONLY OVERLAY (`wrangler.deploy.json`, spliced at the `@deploy-only-bindings`
 * marker) carries bindings that must not appear in the committed config at all. Today
 * that is the Tier-2 pipelines stream: the committed file is also what the workers vitest
 * pool parses, and the catalog pins that pool's wrangler to 4.44, which predates the
 * `pipelines[].stream` shape and rejects the entire config on sight. Splicing keeps the
 * binding reviewable — it is committed, in its own named file — without handing it to a
 * parser that cannot read it.
 *
 * It never emits a config with an unresolved placeholder in it. A `${…}` reaching
 * `wrangler deploy` is not an error wrangler can explain — `database_id` would simply be
 * a string that matches no database — so the refusal has to happen here.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (n) => argv.includes(`--${n}`);

const app = flag('app');
const env = flag('env') ?? 'prod';
const check = has('check');

function fail(msg) {
  console.error(`✗ wrangler-config: ${msg}`);
  process.exit(1);
}

if (!app) fail('--app <name> is required (the directory under apps/)');

/** Same flat-env parse as scripts/secrets.mjs — KEY=VALUE, `#` comments, optional quotes. */
function envFileValues(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return {}; // Absent is fine: CI has no env file, it has process.env.
  }
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let v = line.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    if (v !== '') out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

const source = join(ROOT, 'apps', app, 'wrangler.jsonc');
const target = join(ROOT, 'apps', app, 'wrangler.generated.jsonc');

let template;
try {
  template = readFileSync(source, 'utf8');
} catch {
  fail(`no config at apps/${app}/wrangler.jsonc`);
}

// Splice the deploy-only overlay in at its marker, BEFORE placeholders resolve, so the
// overlay's own `${…}` are substituted on the same pass as the template's.
const MARKER = '// @deploy-only-bindings';
const overlayPath = join(ROOT, 'apps', app, 'wrangler.deploy.json');
if (template.includes(MARKER)) {
  let overlay;
  try {
    overlay = JSON.parse(readFileSync(overlayPath, 'utf8'));
  } catch (err) {
    fail(
      `apps/${app}/wrangler.jsonc carries the ${MARKER} marker but apps/${app}/wrangler.deploy.json ` +
        `could not be read as JSON (${err instanceof Error ? err.message : String(err)}).\n` +
        '  The marker is what makes those bindings reach a deploy; a missing overlay would deploy\n' +
        '  a config silently short of them, which is worse than refusing.',
    );
  }
  // Plain JSON, not JSONC, deliberately: splicing text into a comment-bearing template
  // needs no second parser if the piece being spliced has no comments to preserve. The
  // explanation lives in wrangler.jsonc at the marker, where a reader is already looking.
  const body = JSON.stringify(overlay, null, '\t').replace(/^\{\n?/, '').replace(/\n?\}$/, '');
  template = template.replace(MARKER, `${body.replace(/^\t/gm, '\t')},`);
}

const fromFile = envFileValues(join(ROOT, `secrets/platform.${env}.env`));
const resolve = (key) => process.env[key] ?? fromFile[key];

const wanted = [...new Set([...template.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((m) => m[1]))];
const missing = wanted.filter((k) => !resolve(k));
if (missing.length) {
  fail(
    `apps/${app}/wrangler.jsonc needs ${missing.length} value(s) nothing supplies:\n` +
      missing.map((k) => `    ${k}`).join('\n') +
      `\n  Put them in secrets/platform.${env}.env (see secrets/README.md), or set them in the\n` +
      '  environment. They are account ids rather than credentials, but they live beside the\n' +
      '  secrets because that file is what a deployment restores an account from.',
  );
}

if (check) {
  console.log(
    `wrangler-config: apps/${app}/wrangler.jsonc — ${wanted.length} placeholder(s) all resolve (${env})`,
  );
  process.exit(0);
}

const resolved = template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => resolve(k));
// Belt and braces: the substitution above cannot leave one behind given the check, but a
// config that silently deploys `${…}` as a database id is worth two lines to make impossible.
if (resolved.includes('${')) fail('an unresolved placeholder survived substitution — refusing to write');

writeFileSync(
  target,
  `// GENERATED by tools/wrangler-config.mjs from wrangler.jsonc — do not edit by hand.\n` +
    `// The account ids come from process.env, else secrets/platform.${env}.env. This file is\n` +
    `// gitignored BECAUSE it holds them; the committed wrangler.jsonc names none, so a fork\n` +
    `// inherits placeholders rather than another account's resources.\n` +
    resolved,
);
console.log(`wrangler-config: apps/${app}/wrangler.generated.jsonc (${wanted.length} id(s), ${env})`);
