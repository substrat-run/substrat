/**
 * No credential is written into the repository as a literal (#2365, S7 of the review checklist).
 *
 * This repo is public, and a token committed to it is published the moment it is pushed and
 * stays readable in the history after it is removed. Review is the only thing that has looked
 * for one so far. This reads every file git tracks (plus, locally, every untracked file git
 * does not ignore, so a key is caught before it is committed) for the SHAPES a credential
 * has when its issuer gives it a recognisable form: a PEM private key, a JWK's private
 * exponent, a provider token with its documented prefix, a connection URL carrying a password.
 *
 * **What this is, and is not.** A tripwire for the credentials that announce themselves. A
 * secret with no fixed shape (a random HMAC key, a Cloudflare API token, a password) gets past
 * it, and so does one assembled from parts; a secret reaching a log line, an error or a
 * response is a different question and stays the reviewer's. The checklist marks that half
 * `judgement`.
 *
 * **It never prints a match.** Output is `file:line` and the shape's name, nothing of the value,
 * because the output is a CI log and a log is public text too.
 *
 * **Known, intended literals** are listed in `ACCEPTED` below: a file, a shape, the sha256 of each
 * accepted match (the matched text, so the value itself is never committed or printed a second
 * time), and why. Any other value of that shape in that file is refused, so a key swapped for
 * another of the same shape is reviewed rather than waved through, and so is a second one added
 * beside it; the entry covers that file only, so the same shape in any other file is refused. A
 * pinned digest no longer in the file, and an entry for a file not read, are refused as stale.
 * A refused match prints its digest, never its text: that is what an entry would pin.
 *
 * Exit 0: clean. 1: a literal found, or an entry out of step. Fixtures: `secret-literals.test.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineOf } from './attachment-writers.mjs';
import { repoRoot } from './repo-path.mjs';

/** The shapes, each with the name that is printed instead of the value. */
export const SHAPES = [
  // A body, not only the armour: a placeholder (`MIIE...`) or a template (`${base64}`) is no key.
  // A real one opens with a full 64-character base64 line, raw or `\n`-escaped.
  { name: 'PEM private key', re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----(?:\s|\\n)*[A-Za-z0-9+/=]{60,}/g },
  { name: 'JWK private exponent', re: /["']?\bd["']?\s*:\s*["'][A-Za-z0-9_-]{40,}["']/g },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'OpenAI API key', re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{40,}/g },
  { name: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'Stripe live key', re: /\b[rs]k_live_[A-Za-z0-9]{20,}/g },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'connection URL with a password', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:/@'"`]+:[^\s@/'"`$<{]{3,}@/g },
];

/**
 * Literals the repo holds on purpose. `file → { shape, digests, reason }`, each digest the sha256
 * of one accepted match. Adding an entry or a digest is a reviewed act: say why the value is not
 * a secret.
 */
export const ACCEPTED = {
  'packages/dev-issuer/src/keys.ts': {
    shape: 'JWK private exponent',
    digests: ['94842336b540949844f01325272c8b214955e975931d0a836846cc787af650f8'],
    reason: "the dev issuer's signing key, checked in on purpose so a local login needs no setup; it signs for no deployed issuer (CLAUDE.md, packages/dev-issuer)",
  },
  'packages/contracts/test/errors.test.ts': {
    shape: 'connection URL with a password',
    digests: ['f69a32207c70044fac192847546f3085cbf43a94451a002f710703e1939e064b'],
    reason: 'a made-up connection string the test throws to prove an internal error message is never returned',
  },
};

/** Files never read: lockfiles hold integrity hashes and nothing anyone wrote. */
const SKIP = [/(?:^|\/)pnpm-lock\.yaml$/, /(?:^|\/)node_modules\//, /\.(?:png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|zip|gz|wasm|sqlite|db)$/i];

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Each match in one file, as `{ line, shape, digest }` — never the matched text. */
export function scan(text) {
  const out = [];
  for (const { name, re } of SHAPES) {
    for (const m of text.matchAll(re)) out.push({ line: lineOf(text, m.index), shape: name, digest: sha256(m[0]) });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Offences across `files` (`{ path, text }[]`), judged against `accepted`. */
export function findLiterals(files, accepted = ACCEPTED) {
  const offences = [];
  for (const { path, text } of files) {
    const hits = scan(text);
    const entry = accepted[path];
    if (entry) {
      for (const h of hits) {
        if (h.shape !== entry.shape) offences.push(`${path}:${h.line}: ${h.shape}`);
        else if (!entry.digests.includes(h.digest)) {
          offences.push(`${path}:${h.line}: ${h.shape} — not an accepted value (sha256 ${h.digest}); review it, and pin the digest in tools/secret-literals.mjs only if it is no secret`);
        }
      }
      for (const d of entry.digests) {
        if (!hits.some((h) => h.digest === d)) offences.push(`${path}: the accepted ${entry.shape} sha256 ${d} is no longer in the file — remove it from the entry`);
      }
      continue;
    }
    for (const h of hits) offences.push(`${path}:${h.line}: ${h.shape}`);
  }
  for (const path of Object.keys(accepted)) {
    if (!files.some((f) => f.path === path)) offences.push(`${path}: accepted in tools/secret-literals.mjs but not read (moved or deleted) — remove the entry`);
  }
  return offences;
}

function main() {
  const root = repoRoot(import.meta.url);
  const list = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((p) => p && !SKIP.some((re) => re.test(p)));
  const files = [];
  for (const path of [...new Set(list)]) {
    let text;
    try {
      if (!statSync(join(root, path)).isFile()) continue;
      text = readFileSync(join(root, path), 'utf8');
    } catch {
      continue; // deleted in the working tree, or not a file
    }
    if (text.includes('\0')) continue; // binary
    files.push({ path, text });
  }
  const offences = findLiterals(files);
  if (offences.length > 0) {
    console.error(`secret-literals: ${offences.length} credential-shaped literal(s) or stale entries (values are never printed):\n`);
    for (const o of offences) console.error(`  ${o}`);
    console.error(
      '\nA credential belongs in a secret store, read from the environment at run time. If it was\n' +
        'pushed, rotate it: removing it does not take it out of the history. A literal that is not\n' +
        'a secret (a test fixture, a dev-only key) is an entry in ACCEPTED with its reason.',
    );
    process.exit(1);
  }
  console.log(`secret-literals: ${files.length} file(s) read; no credential-shaped literal outside ACCEPTED.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
