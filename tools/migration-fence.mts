/**
 * Every migration in the repo, replayed against a scope that holds data, through the kernel's
 * own data-loss fence (#115).
 *
 * The fence refuses, at apply, an authored migration that loses rows or values a scope holds and
 * does not declare it (`packages/kernel/src/migration-fence.ts`). In a scope that refusal closes
 * the scope until a fixed version ships, which is the right answer for data and the wrong place
 * to learn it. This gate asks the same question in the pull request that adds the migration: it
 * replays each vertical's modules in the order its host registers them, and before every
 * migration it gives every table a row with every column holding a value, so every migration
 * meets a populated scope. An undeclared loss is red here, naming the declaration to add.
 *
 * The replay is the kernel's own `replayMigrations` (`packages/kernel/src/migration-replay.ts`),
 * the one `substrat push` runs through a vertical's pinned kernel before upload (#2321), and it
 * judges with `runMigrationStatements` — the function both adapters run — so there is one rule
 * and this is not a copy of it. Kernel-derived DDL runs too, unfenced, as the hosts run it,
 * because a later authored migration may name what it made.
 *
 * Read off the same registrations `lint:permissions` reads: every `demos/*` and `apps/*` that
 * declares `substrat.permissions`, every engine on its own (an engine composed by no vertical is
 * still shipped), and the scaffold template, materialized the way `lint:schedule-sweeper` does.
 *
 * What a synthetic row cannot stand in for, and so what this does not prove: foreign keys are
 * off (a made-up value satisfies no reference), and so are CHECK constraints, so a cascade's
 * loss is the run-time fence's to catch. Each declared move and discard is printed with its
 * reason, which is what a reviewer reads beside the SQL.
 *
 * Exit 0: every migration passes. 1: at least one is refused, or cannot be replayed (each
 * printed). 2: the gate cannot do its job (its self-test, or a registration it cannot load).
 *
 * Needs the build: it imports the kernel, adapter-sqlite and each engine from `dist`.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replayMigrations, type ReplayModule, type SqlMigration, type SqlValue } from '../packages/kernel/dist/index.js';
import { SCOPE_SPINE_DDL } from '../packages/adapter-sqlite/dist/index.js';
import { syncTemplate } from './template-sync.mjs';

type Registration = ReplayModule & { manifest: { id: string } };

const isRegistration = (m: unknown): m is Registration =>
  typeof m === 'object' && m !== null && typeof (m as Registration).manifest?.id === 'string';

/** The template's permissions entry: it has no committed package.json (see lint:schedule-sweeper). */
const TEMPLATE_PERMISSIONS_ENTRY = 'src/provision.ts';

interface Outcome {
  readonly failures: string[];
  readonly declared: string[];
}

/** Replay one vertical's modules, in order, against a populated in-memory scope. */
export function replay(label: string, modules: readonly Registration[]): Outcome {
  const db = new DatabaseSync(':memory:');
  const outcome = replayMigrations(
    {
      exec: (q) => db.exec(q),
      query: <T>(q: string, p: readonly SqlValue[] = []) => db.prepare(q).all(...(p as never[])) as T[],
      run: (q, p = []) => ({ changes: Number(db.prepare(q).run(...(p as never[])).changes) }),
    },
    modules,
    { spineDdl: SCOPE_SPINE_DDL },
  );
  // In this repository a migration that cannot be replayed is as red as one that is refused: the
  // gate's job is to have judged every one.
  const stopped = outcome.refused ?? outcome.failed;
  return {
    failures: stopped ? [`${label}: ${stopped.message}`] : [],
    declared: outcome.declared.map((line) => `${label}: ${line}`),
  };
}

/** Every vertical's registrations, the engines on their own, and the template. */
async function registrations(): Promise<[string, Registration[]][]> {
  const out: [string, Registration[]][] = [];
  const load = async (label: string, entry: string): Promise<void> => {
    const mod = (await import(pathToFileURL(entry).href)) as { permissions?: { modules?: unknown[] } };
    const modules = mod.permissions?.modules;
    if (!Array.isArray(modules)) {
      console.error(`migration-fence: ${entry} exports no \`permissions.modules\`; cannot replay ${label}.`);
      process.exit(2);
    }
    out.push([label, modules.filter(isRegistration)]);
  };
  for (const root of ['demos', 'apps']) {
    for (const name of readdirSync(root).sort()) {
      const pkg = join(root, name, 'package.json');
      if (!existsSync(pkg)) continue;
      const entry = (JSON.parse(readFileSync(pkg, 'utf8')) as { substrat?: { permissions?: unknown } }).substrat?.permissions;
      if (typeof entry === 'string' && entry.trim() !== '') await load(`${root}/${name}`, join(process.cwd(), root, name, entry));
    }
  }
  for (const name of readdirSync('engines').sort()) {
    const dist = join(process.cwd(), 'engines', name, 'dist', 'index.js');
    if (!existsSync(dist)) {
      console.error(`migration-fence: engines/${name} is not built (${dist}); run the build first.`);
      process.exit(2);
    }
    const mod = (await import(pathToFileURL(dist).href)) as Record<string, unknown>;
    out.push([`engines/${name}`, Object.values(mod).filter(isRegistration)]);
  }
  await load('template', join(syncTemplate(), TEMPLATE_PERMISSIONS_ENTRY));
  return out;
}

/** The gate has to tell its own cases apart, or green means nothing. */
function selfTest(): string[] {
  const module = (migrations: SqlMigration[]): Registration => ({ manifest: { id: 'fixture' }, migrations }) as Registration;
  const init = { version: '0001', sql: 'CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT);' };
  const cases: [string, SqlMigration[], boolean][] = [
    ['an undeclared drop of a populated table', [init, { version: '0002', sql: 'DROP TABLE notes;' }], true],
    ['the same drop, declared', [init, { version: '0002', sql: 'DROP TABLE notes;', discards: { notes: 'retired' } }], false],
    ['a column lost by rename-as-drop+add', [init, { version: '0002', sql: 'ALTER TABLE notes ADD COLUMN text TEXT; ALTER TABLE notes DROP COLUMN body;' }], true],
    ['a faithful rebuild', [init, {
      version: '0002',
      sql: 'CREATE TABLE notes_new (id TEXT PRIMARY KEY, body TEXT NOT NULL); INSERT INTO notes_new SELECT * FROM notes; DROP TABLE notes; ALTER TABLE notes_new RENAME TO notes;',
    }], false],
  ];
  return cases
    .filter(([, migrations, refused]) => (replay('self-test', [module(migrations)]).failures.length > 0) !== refused)
    .map(([what, , refused]) => `${what}: expected ${refused ? 'a refusal' : 'a pass'}`);
}

async function main(): Promise<void> {
  const drift = selfTest();
  if (drift.length > 0) {
    console.error(`migration-fence: the gate no longer tells its own cases apart:\n  ${drift.join('\n  ')}`);
    process.exit(2);
  }
  const failures: string[] = [];
  let migrations = 0;
  for (const [label, modules] of await registrations()) {
    migrations += modules.reduce((n, m) => n + (m.migrations?.length ?? 0), 0);
    const outcome = replay(label, modules);
    failures.push(...outcome.failures);
    for (const line of outcome.declared) console.log(`declared  ${line}`);
  }
  if (failures.length > 0) {
    console.error(`\nmigration-fence: ${failures.length} vertical(s) would lose data a scope holds:\n`);
    for (const f of failures) console.error(`  ${f}\n`);
    console.error(
      'Each one is refused at apply in any scope that holds that data, which closes the scope. Fix the\n' +
        'migration, or declare the loss on it (`moves` / `discards`) for review — see\n' +
        'apps/docs/concepts/deploying.md ("A migration cannot quietly lose data").',
    );
    process.exit(1);
  }
  console.log(`migration-fence: ${migrations} authored migration(s) replayed against populated scopes; none loses undeclared data.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
