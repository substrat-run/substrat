/**
 * Checks 3 and 4 of `tools/secrets-coverage.mjs`: the scope-store envelope's four keys (K-52),
 * held to `STORE_KEY_AUDIENCES`, and the wire envelope's four (RFC wire-signing, K-58), held to
 * `WIRE_KEY_ISSUERS`, both in `scripts/secrets.mjs`.
 *
 * Each private key is mapped on its signer worker and on no other (a second holder could sign as
 * that audience or issuer), both public-key lists on the uploader only, each worker's own `Env`
 * declares what it is mapped, and every name is in both env templates and in secrets/README.md.
 * Only these: the dev template is deliberately partial elsewhere, so a blanket "every key in every
 * template" rule would refuse it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STORE_KEY_AUDIENCES, STORE_KEY_UPLOADER, WIRE_KEY_ISSUERS, WIRE_KEY_UPLOADER } from '../scripts/secrets.mjs';
import { repoRoot } from './repo-path.mjs';

const ROOT = repoRoot(import.meta.url);

/** A repo-relative file's text, or undefined when it cannot be read. */
export function readRepoFile(rel) {
  try {
    return readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    return undefined;
  }
}

const TEMPLATES = ['secrets/platform.prod.env.example', 'secrets/platform.dev.env.example'];

/** Every way one family's names can fall out of step with its inventory. */
function keyFamilyProblems(manifest, members, uploader, read) {
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
  const templates = TEMPLATES.map((path) => ({ path, text: read(path) ?? '' }));
  const readme = read('secrets/README.md') ?? '';
  for (const [member, { privateKey, signer, publicKeys }] of Object.entries(members)) {
    expect(privateKey, signer);
    expect(publicKeys, uploader);
    for (const name of [privateKey, publicKeys]) {
      for (const t of templates) {
        if (!new RegExp(`^${name}=`, 'm').test(t.text)) out.push(`${t.path} has no ${name}= line (${member})`);
      }
      if (!readme.includes(`\`${name}\``)) out.push(`secrets/README.md does not name \`${name}\` (${member})`);
    }
  }
  return out;
}

/**
 * Every way the four STORE_* names can fall out of step with `STORE_KEY_AUDIENCES`. `read`
 * returns a repo-relative file's text, so a test can hand it a world without touching disk.
 */
export function storeKeyProblems(manifest, read = readRepoFile) {
  return keyFamilyProblems(manifest, STORE_KEY_AUDIENCES, STORE_KEY_UPLOADER, read);
}

/** The same for the four WIRE_* names and `WIRE_KEY_ISSUERS`. */
export function wireKeyProblems(manifest, read = readRepoFile) {
  return keyFamilyProblems(manifest, WIRE_KEY_ISSUERS, WIRE_KEY_UPLOADER, read);
}
