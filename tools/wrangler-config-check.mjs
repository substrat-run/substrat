#!/usr/bin/env node
/**
 * No committed wrangler config may name an account-specific ID.
 *
 * The repo is public and forkable. A NAME in a binding is portable — a fork keeping
 * `substrat-verticals` or `substrat-scope-backups` creates its own resource under that
 * name and works. An opaque ID is not: a `database_id` or a pipelines `stream` addresses
 * exactly one account, so a fork inherits a config pointing at somebody else's
 * resources. `tools/wrangler-config.mjs` substitutes those at deploy; this refuses when
 * one is written back in, which is the only thing that keeps that true.
 *
 * Placeholder-shaped, not value-shaped: an id is recognised by LOOKING like one (a UUID,
 * or the 32-hex Cloudflare uses for streams and namespaces) rather than by matching a
 * list of known values, because the failure this guards against is somebody pasting a
 * NEW id — which no list would contain.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPS = join(ROOT, 'apps');

/** A UUID, or a bare 32-hex id (Cloudflare stream / namespace / account ids). */
const ID_SHAPES = [
  { what: 'a UUID', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { what: 'a 32-hex id', re: /\b[0-9a-f]{32}\b/gi },
];

/**
 * A comment may legitimately quote one — the account id appears in prose explaining how
 * to create a resource, and forbidding that would push the explanation out of the file
 * that needs it. Only what wrangler READS is judged.
 *
 * A real JSONC scan, not `indexOf('//')`: that truncated a quoted value at the first
 * `//` — so an `https://…/<32-hex-id>` string was never judged, and a real id could
 * ride in on a URL — and it could not see a block comment at all, so an exempt
 * `/* … *\/` quoting one failed. Comments are blanked to spaces (newlines kept), so the
 * text that remains is exactly what wrangler parses and every finding keeps its line.
 */
function withoutComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"') {
      // A string, escapes and all — a `//` inside it is a value, not a comment.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

const findings = [];
for (const app of readdirSync(APPS, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  // The deploy-only overlay too: it is committed and spliced into the deploy config, so
  // an id pasted there is every bit as public as one in the main file.
  for (const name of ['wrangler.jsonc', 'wrangler.deploy.json']) {
    const file = join(APPS, app.name, name);
    if (!existsSync(file)) continue;
    withoutComments(readFileSync(file, 'utf8'))
      .split('\n')
      .forEach((line, i) => {
        for (const { what, re } of ID_SHAPES) {
          re.lastIndex = 0;
          for (const m of line.matchAll(re)) {
            findings.push({ file: `apps/${app.name}/${name}`, line: i + 1, what, value: m[0] });
          }
        }
      });
  }
}

if (findings.length) {
  console.error(`✗ wrangler-config: ${findings.length} account id(s) in a committed config:\n`);
  for (const f of findings) console.error(`    ${f.file}:${f.line}  ${f.what}  ${f.value}`);
  console.error(
    '\n  Replace each with a ${PLACEHOLDER} and put the value in secrets/platform.<env>.env —\n' +
      '  tools/wrangler-config.mjs substitutes them into wrangler.generated.jsonc at deploy.\n' +
      '  A name (substrat-verticals, substrat-scope-backups) is fine and should stay: a fork\n' +
      '  keeping it creates its own resource. An id points at this account and cannot travel.',
  );
  process.exit(1);
}
console.log('wrangler-config: no committed config names an account id');
