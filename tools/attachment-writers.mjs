/**
 * Every writer of an attachment row meets the orphan sweep's tombstone (#2314).
 *
 * The sweep deletes an object only after its scope tombstoned the id in
 * `_substrat_attachment_condemned`, and that is safe only because nothing can write an
 * `_substrat_attachments` row for a tombstoned id afterwards: the attachment insert calls
 * `refuseCondemnedAttachment` in its own transaction, and a dump load calls
 * `refuseCondemnedInDump` before its first drop. A new writer that skipped the check would let
 * a row commit whose bytes a pass is deleting, and every suite would stay green, because none of
 * them drives the new writer against a pass. So this reads the source:
 *
 * 1. an `INSERT` / `REPLACE` into `_substrat_attachments` must have `refuseCondemnedAttachment(`
 *    in the `WINDOW` characters before it, in the same file;
 * 2. a file that replays dump rows (`dumpRowsInsert(`) must call `refuseCondemnedInDump(`.
 *
 * Shipped source only: tests write rows to set up what they assert, and `dumpRowsInsert`'s own
 * definition is not a load. Its fixtures are `attachment-writers.test.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** How far before an insert its check may sit: the statement's own transaction body. */
export const WINDOW = 1200;

const INSERT = /\b(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+["`]?_substrat_attachments\b(?!_)/gi;
const DEFINES_DUMP_ROWS = 'packages/kernel/src/spine-restore.ts';

/** Is this a shipped source file the rule reads? */
export function inScope(path) {
  if (!/\.(?:m?ts|m?js)$/.test(path)) return false;
  if (/(?:^|\/)(?:test|tests|__tests__|dist|node_modules)\//.test(path)) return false;
  if (/\.(?:test|spec)\.[mc]?[jt]s$/.test(path)) return false;
  if (path.startsWith('tools/')) return false;
  return true;
}

/** The offences in `files` ([{ path, text }]), as `path:line: why` strings. */
export function findBypasses(files) {
  const out = [];
  for (const { path, text } of files) {
    if (!inScope(path)) continue;
    for (const match of text.matchAll(INSERT)) {
      const before = text.slice(Math.max(0, match.index - WINDOW), match.index);
      if (!before.includes('refuseCondemnedAttachment(')) {
        const line = text.slice(0, match.index).split('\n').length;
        out.push(`${path}:${line}: an attachment row is written without refuseCondemnedAttachment() before it`);
      }
    }
    if (path !== DEFINES_DUMP_ROWS && text.includes('dumpRowsInsert(') && !text.includes('refuseCondemnedInDump(')) {
      const line = text.slice(0, text.indexOf('dumpRowsInsert(')).split('\n').length;
      out.push(`${path}:${line}: a dump load replays rows without refuseCondemnedInDump() before its drops`);
    }
  }
  return out;
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((p) => p && inScope(p));
  const files = paths.map((path) => ({ path, text: readFileSync(new URL(`../${path}`, import.meta.url), 'utf8') }));
  const offences = findBypasses(files);
  if (offences.length > 0) {
    console.error(
      'lint:attachment-writers — a writer of attachment rows that skips the orphan sweep\'s tombstone (#2314):\n' +
        offences.map((o) => `  ${o}`).join('\n'),
    );
    process.exit(1);
  }
  console.log(`lint:attachment-writers — ${files.length} files read, every attachment writer checks the tombstone`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
