/**
 * A new operation has an acceptance test (#2365, S8 of the review checklist) — ADVISORY.
 *
 * An operation is reachable the moment it is registered: over HTTP, from the MCP surface, from a
 * schedule. A scenario that never calls it leaves its permission check, its not-found and its
 * happy path to whoever calls it first. This lists, for every package that registers modules
 * (the same set `lint:migration-fence` reads, without the template), each operation its own
 * modules bind that no test file in the package names. "Names" is the operation's name as a
 * string anywhere in a test file (`'todo/create-list'`), which is how a scenario invokes one.
 *
 * **What it does not judge.** Whether the test that names it is any good: a happy path alone
 * passes here, and the checklist leaves that to the reader. A suite generated from the
 * declarations (`entityCheckConformanceSuite`) reaches an operation without naming it, so an
 * operation covered only that way is listed; that is deliberate, since the generated pair checks
 * the permission and not the operation.
 *
 * Advisory, as the checklist item is: the exit is 0 whatever it finds. With `--base <ref>` each
 * operation whose name does not appear anywhere in its package on the base branch — a NEW one —
 * is a `::warning` annotation on the pull request; the rest is one summary line, so an old gap
 * does not shout on every PR. Exit 2 only when it cannot run.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { baseFromArgv, registrations, testFiles } from './package-registrations.mts';

/**
 * The operations no test text names as a whole quoted string. An operation name has no space or
 * quote in it, so the strings read are those runs alone, and an apostrophe in a test's prose
 * cannot pair with the wrong quote.
 */
export function untested(operations: readonly string[], tests: readonly string[]): string[] {
  const named = new Set(tests.flatMap((text) => [...text.matchAll(/['"`]([^'"`\s]+)['"`]/g)].map((m) => m[1])));
  return operations.filter((op) => !named.has(op));
}

/** Which of `ops` the base names anywhere in the package: one `git grep` for all of them. */
function namedOnBase(base: string, label: string, ops: readonly string[]): Set<string> {
  if (ops.length === 0) return new Set();
  try {
    const args = ['grep', '-h', '-o', '-F', ...ops.flatMap((op) => ['-e', op]), base, '--', label];
    return new Set(execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 }).split('\n'));
  } catch (err) {
    // Exit 1 is "no match"; anything else is a git that could not answer.
    if ((err as { status?: number }).status === 1) return new Set();
    throw err;
  }
}

async function main(): Promise<void> {
  const base = baseFromArgv('operation-tests', process.argv.slice(2), 'without it no operation could be told new from old');
  const packages = await registrations('operation-tests', { template: false });
  let total = 0;
  const gaps: { label: string; op: string; isNew: boolean }[] = [];
  for (const { label, own } of packages) {
    const operations = own.flatMap((m) => Object.keys((m.operations as { handlers?: Record<string, unknown> } | undefined)?.handlers ?? {}));
    total += operations.length;
    const missing = untested(operations, testFiles(join(process.cwd(), label)).map((f) => readFileSync(f, 'utf8')));
    const old = base === undefined ? new Set<string>() : namedOnBase(base, label, missing);
    for (const op of missing) gaps.push({ label, op, isNew: base !== undefined && !old.has(op) });
  }

  for (const { label, op, isNew } of gaps) {
    if (isNew) console.log(`::warning title=Operation without a test (S8)::${label}: '${op}' is new and no test in the package names it`);
    else if (base === undefined) console.log(`  ${label}: ${op}`);
  }
  const fresh = gaps.filter((g) => g.isNew).length;
  console.log(
    `operation-tests (advisory): ${gaps.length} of ${total} operation(s) are named by no test in their package` +
      (base === undefined ? '' : `; ${fresh} of them new since the merge-base (${base.slice(0, 9)})`) +
      (base === undefined || gaps.length === 0 ? '.' : '. Run without --base to list them all.'),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
