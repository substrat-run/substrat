#!/usr/bin/env node
/**
 * `scripts/secrets.mjs` refuses a deploy when a key it KNOWS about is blank — but it had
 * no way to refuse when a worker gained a new secret it never learned about at all.
 * That is exactly how `TENANT_TOKEN_SECRET` (#1602) took the control plane down: the
 * worker declared it, read it, and documented "this must be set … BEFORE the dashboard",
 * while `scripts/secrets.mjs` never listed it in `required` or `secrets` — so `check`,
 * `status` and `push` all stayed silent about the one thing an operator needed to do.
 *
 * This is the mechanical half of not letting that happen again, in two checks:
 *
 *  1. MANIFEST self-consistency: every name in a worker's `required` array is a key in
 *     that worker's `secrets` map. A `required` entry with no mapping is not enforced by
 *     anything — `resolveForWorker` only walks `secrets` — so it would silently stop
 *     gating the moment someone typo'd or half-finished an edit.
 *  2. Source-linked coverage: a worker's own `Env` interface is read for a `string`
 *     field whose doc comment says "must be set" — the phrase `worker.ts` uses for
 *     exactly this class of secret (TENANT_TOKEN_SECRET, PLATFORM_SECRET) — and that
 *     name is asserted present in the worker's `required` array. A worker gaining a new
 *     hard-required secret without a MANIFEST entry now fails here instead of in
 *     production.
 *
 *  3. The scope-store envelope's keys (K-52), held to `STORE_KEY_AUDIENCES`: each audience's
 *     private key is mapped on its signer worker and on no other (a second holder could sign
 *     for that audience), both public-key lists on the uploader only, each worker's own `Env`
 *     declares what it is mapped, and all four names are in both env templates and in
 *     secrets/README.md. Only these four: the dev template is deliberately partial
 *     elsewhere, so a blanket "every key in every template" rule would refuse it.
 *
 * (2) is deliberately narrow — it reads one phrase, not "every string field", because
 * most of a worker's `Env` fields are optional behavioural config that intentionally
 * lives in `wrangler.jsonc` `vars` and is never meant to reach `secrets.mjs` (see its
 * own header). A blanket "every field must be mapped" rule would refuse those by
 * construction. What it buys is real: a secret whose own doc comment declares operator
 * obligation is exactly the shape of the bug this file exists to catch.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MANIFEST, STORE_KEY_AUDIENCES, STORE_KEY_UPLOADER } from '../scripts/secrets.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 3. the scope-store keys ─────────────────────────────────────────────────────
/**
 * Every way the four STORE_* names can fall out of step with `STORE_KEY_AUDIENCES`. `read`
 * returns a repo-relative file's text, so a test can hand it a world without touching disk.
 */
export function storeKeyProblems({ manifest, audiences, uploader, read }) {
  const out = [];
  const holders = (canonical) => Object.entries(manifest).filter(([, cfg]) => Object.values(cfg.secrets).includes(canonical)).map(([w]) => w);
  const declares = (worker, name) => new RegExp(`^\\s*${name}\\?:\\s*string;`, 'm').test(read(`${manifest[worker]?.dir}/src/worker.ts`) ?? '');
  const expect = (name, worker) => {
    const held = holders(name);
    if (held.length !== 1 || held[0] !== worker) {
      out.push(`${name} is mapped on [${held.join(', ')}]; it belongs on ${worker} alone`);
    } else if (manifest[worker].secrets[name] !== name) {
      out.push(`${worker} maps ${name} under another name; the worker reads ${name}`);
    } else if (!declares(worker, name)) {
      out.push(`${worker} maps ${name}, but ${manifest[worker].dir}/src/worker.ts declares no \`${name}?: string\``);
    }
  };
  const templates = ['secrets/platform.prod.env.example', 'secrets/platform.dev.env.example'];
  const readme = read('secrets/README.md') ?? '';
  for (const [aud, { privateKey, signer, publicKeys }] of Object.entries(audiences)) {
    expect(privateKey, signer);
    expect(publicKeys, uploader);
    for (const name of [privateKey, publicKeys]) {
      for (const t of templates) {
        if (!new RegExp(`^${name}=`, 'm').test(read(t) ?? '')) out.push(`${t} has no ${name}= line (${aud})`);
      }
      if (!readme.includes(`\`${name}\``)) out.push(`secrets/README.md does not name \`${name}\` (${aud})`);
    }
  }
  return out;
}

// Guarded so tools/store-keys.test.mts can import storeKeyProblems without running the checks.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = [];

  // ── 1. MANIFEST self-consistency ────────────────────────────────────────────────
  for (const [worker, cfg] of Object.entries(MANIFEST)) {
    for (const name of cfg.required ?? []) {
      if (!(name in cfg.secrets)) {
        problems.push(`${worker}: '${name}' is in \`required\` but has no \`secrets\` mapping — check/push never enforce it`);
      }
    }
  }

  // ── 2. source-linked coverage: a field whose own doc comment says "must be set" ─
  const MUST_BE_SET = /must be set/i;
  const FIELD = /^\s*([A-Z][A-Z0-9_]*)\??:\s*string;\s*$/;

  function fieldsRequiringSetup(src) {
    const lines = src.split('\n');
    const found = [];
    let commentStart = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('/**')) commentStart = i;
      const m = FIELD.exec(line);
      if (m && commentStart >= 0 && MUST_BE_SET.test(lines.slice(commentStart, i).join('\n'))) {
        found.push(m[1]);
      }
      if (!line.trim().startsWith('*') && !line.trim().startsWith('/**')) commentStart = -1;
    }
    return found;
  }

  for (const [worker, cfg] of Object.entries(MANIFEST)) {
    const workerFile = join(ROOT, cfg.dir, 'src/worker.ts');
    let src;
    try {
      src = readFileSync(workerFile, 'utf8');
    } catch (err) {
      // Every MANIFEST member today has exactly one `src/worker.ts` — this branch has
      // never fired. It must still fail closed rather than skip: a silently-swallowed
      // read error means this worker is checked for NOTHING, which is a green light
      // that looked exactly like coverage. A worker genuinely without one would need
      // an explicit MANIFEST opt-out, not a caught exception standing in for one.
      problems.push(`${worker}: could not read ${workerFile} (${err.code ?? err.message}) — this worker was checked for nothing`);
      continue;
    }
    const required = new Set(cfg.required ?? []);
    for (const name of fieldsRequiringSetup(src)) {
      if (!required.has(name)) {
        problems.push(
          `${worker}: ${cfg.dir}/src/worker.ts declares \`${name}\` "must be set", but it is not in MANIFEST['${worker}'].required`,
        );
      }
    }
  }

  for (const p of storeKeyProblems({
    manifest: MANIFEST,
    audiences: STORE_KEY_AUDIENCES,
    uploader: STORE_KEY_UPLOADER,
    read: (rel) => {
      try {
        return readFileSync(join(ROOT, rel), 'utf8');
      } catch {
        return undefined;
      }
    },
  })) {
    problems.push(`store keys: ${p}`);
  }

  if (problems.length > 0) {
    console.error('secrets-coverage: scripts/secrets.mjs is missing a secret a worker declares required.\n');
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error('\nAdd the missing name to MANIFEST.<worker>.required and .secrets in scripts/secrets.mjs.');
    console.error('A store-keys line: STORE_KEY_AUDIENCES in scripts/secrets.mjs is the inventory; see secrets/store-keys.md.');
    process.exit(1);
  }
  console.log('secrets-coverage: ok');
}
