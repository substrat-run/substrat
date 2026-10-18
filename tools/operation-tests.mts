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
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registrations } from './migration-registrations.mts';

const TEST_FILE = /\.(?:test|spec)\.[mc]?[jt]sx?$/;

/** Every test file under `dir`: a `*.test.*` / `*.spec.*` anywhere, or any source under `test/`. */
export function testFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string, underTest: boolean): void => {
    for (const name of readdirSync(at)) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full, underTest || name === 'test' || name === 'tests' || name === '__tests__');
      else if (TEST_FILE.test(name) || (underTest && /\.[mc]?[jt]sx?$/.test(name))) out.push(full);
    }
  };
  walk(dir, false);
  return out;
}

/** The operations no test text names. */
export function untested(operations: readonly string[], tests: readonly string[]): string[] {
  return operations.filter((op) => !tests.some((text) => text.includes(`'${op}'`) || text.includes(`"${op}"`) || text.includes(`\`${op}\``)));
}

const git = (args: string[]): string => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Did the base branch name this operation anywhere in the package? */
function onBase(base: string, label: string, op: string): boolean {
  try {
    git(['grep', '-q', '-F', op, base, '--', label]);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const baseAt = argv.indexOf('--base');
  const base = baseAt === -1 ? undefined : argv[baseAt + 1];
  if (baseAt !== -1 && (!base || base.startsWith('--'))) {
    console.error('operation-tests: --base needs a ref');
    process.exit(2);
  }
  if (base !== undefined) {
    try {
      git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
    } catch {
      console.error(`operation-tests: the base ${base} is not in this checkout; fetch it first.`);
      process.exit(2);
    }
  }

  const packages = await registrations('operation-tests', { template: false });
  const engineModules = new Set(packages.filter((p) => p.label.startsWith('engines/')).flatMap((p) => p.modules.map((m) => m.manifest.id)));
  let total = 0;
  const gaps: { label: string; op: string; isNew: boolean }[] = [];
  for (const { label, modules } of packages) {
    const own = label.startsWith('engines/') ? modules : modules.filter((m) => !engineModules.has(m.manifest.id));
    const operations = own.flatMap((m) => Object.keys((m.operations as { handlers?: Record<string, unknown> } | undefined)?.handlers ?? {}));
    total += operations.length;
    const tests = testFiles(join(process.cwd(), label)).map((f) => readFileSync(f, 'utf8'));
    for (const op of untested(operations, tests)) gaps.push({ label, op, isNew: base !== undefined && !onBase(base, label, op) });
  }

  for (const { label, op, isNew } of gaps) {
    if (isNew) console.log(`::warning title=Operation without a test (S8)::${label}: '${op}' is new and no test in the package names it`);
    else if (base === undefined) console.log(`  ${label}: ${op}`);
  }
  const fresh = gaps.filter((g) => g.isNew).length;
  console.log(
    `operation-tests (advisory): ${gaps.length} of ${total} operation(s) are named by no test in their package` +
      (base === undefined ? '' : `; ${fresh} of them new since ${base}`) +
      (base === undefined || gaps.length === 0 ? '.' : '. Run without --base to list them all.'),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
