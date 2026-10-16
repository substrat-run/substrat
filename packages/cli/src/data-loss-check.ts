/**
 * The data-loss check a push makes before upload (#2321): the vertical's authored migrations,
 * replayed against an in-memory scope that holds data, through the data-loss fence (#115).
 *
 * The fence refuses, at apply, a migration that would lose data a scope holds and does not
 * declare it — which closes every populated scope until a fixed version ships. In this repository
 * `lint:migration-fence` asks the question in the pull request; a vertical built anywhere else
 * has only this, the push, as the earlier and cheaper place to hear no.
 *
 * The replay is the VERTICAL's own kernel's (`replayMigrations`), reached at run time the way
 * `moduleMigrations` is (#1677): it is the copy of the fence the vertical's scopes run at apply,
 * so it is the one whose answer matters, and this CLI stays Apache-2.0 with no kernel dependency.
 * What this module supplies is only what the kernel does not import: an empty in-memory SQLite
 * (`node:sqlite`), and the platform's spine tables from the vertical's own
 * `@substrat-run/adapter-sqlite`, when it has one, for an authored migration that reads them.
 * Nothing here opens a file, a network connection or the environment's data.
 *
 * Three outcomes, never confused:
 * - REFUSED — the fence would refuse a migration. The push stops, with the fence's own message
 *   naming the declaration (`moves` / `discards`) to add. There is no flag past it: a `discards`
 *   entry with its reason is the reviewed way to lose data on purpose.
 * - INCOMPLETE — a migration could not be run on synthetic rows at all (its SQL needs real input,
 *   or reads a spine table this CLI could not build). The replay stops there, so the migrations
 *   after it go unchecked, and the warning says how many.
 * - SKIPPED — nothing could be replayed: no `node:sqlite` (Node before 22.13), or a kernel with
 *   no replay this CLI knows how to call.
 * The last two do not refuse by default — promote is the hard gate, and the fence still refuses
 * there — unless the caller asks for the guarantee (`--require-data-loss-check`).
 */

/** The replay API this CLI calls — `MIGRATION_REPLAY_API` in `@substrat-run/kernel`. */
const REPLAY_API = 1;

/** What the push hands over: read off the same import that yields the permission surface. */
export interface ReplayInputs {
  /** The vertical's own `@substrat-run/kernel`, as imported from its directory, or null. */
  readonly kernel: unknown;
  /** The permission entry's `modules`, each a registration carrying its `migrations`. */
  readonly modules: readonly unknown[];
  /** The vertical's adapter-sqlite `SCOPE_SPINE_DDL`, resolved only when a replay runs. */
  readonly spineDdl: () => Promise<string | undefined>;
}

export type DataLossCheck =
  | { readonly status: 'passed'; readonly authored: number }
  | { readonly status: 'skipped'; readonly why: string }
  | {
      readonly status: 'incomplete';
      readonly authored: number;
      readonly notReplayed: number;
      readonly key: string;
      readonly message: string;
    };

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): { changes: number | bigint } };
}
type SqliteOpener = () => SqliteDatabase;

interface KernelReplay {
  readonly MIGRATION_REPLAY_API?: unknown;
  readonly replayMigrations?: unknown;
}

interface ReplayOutcome {
  readonly authored: number;
  readonly passed: number;
  readonly refused?: { readonly key: string; readonly message: string };
  readonly failed?: { readonly key: string; readonly message: string };
  readonly declared: readonly string[];
}

const isOutcome = (o: unknown): o is ReplayOutcome => {
  const r = o as ReplayOutcome | null;
  const stop = (s: unknown) =>
    s === undefined || (typeof (s as { key?: unknown }).key === 'string' && typeof (s as { message?: unknown }).message === 'string');
  return (
    typeof r === 'object' && r !== null &&
    typeof r.authored === 'number' && typeof r.passed === 'number' &&
    Array.isArray(r.declared) && r.declared.every((d) => typeof d === 'string') &&
    stop(r.refused) && stop(r.failed)
  );
};

/**
 * `node:sqlite`, opened in memory — or undefined where this Node has none (before 22.13 it is
 * missing or behind a flag). Node announces the module as experimental on load; that notice is
 * noise in a push log and is swallowed for this one import, every other warning passing through.
 */
export async function openInMemorySqlite(): Promise<SqliteOpener | undefined> {
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (/sqlite/i.test(text)) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: new (path: string) => SqliteDatabase };
    return () => new DatabaseSync(':memory:');
  } catch {
    return undefined;
  } finally {
    process.emitWarning = emit;
  }
}

const DOCS = 'see https://substrat.net/concepts/deploying ("A migration cannot quietly lose data")';

/** Is the check required to have run — the flag, or `SUBSTRAT_REQUIRE_DATA_LOSS_CHECK=1` in CI. */
export function dataLossCheckRequired(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return argv.includes('--require-data-loss-check') || env.SUBSTRAT_REQUIRE_DATA_LOSS_CHECK === '1';
}

/** The one summary line, the same in the check's own output and the push's last line. */
export function formatDataLossCheck(check: DataLossCheck): string {
  switch (check.status) {
    case 'passed':
      return `data-loss check: PASSED (${check.authored} authored migration(s) replayed against a populated scope)`;
    case 'skipped':
      return `data-loss check: SKIPPED (${check.why}) — the fence still refuses at promote`;
    case 'incomplete':
      return (
        `data-loss check: INCOMPLETE (${check.notReplayed} of ${check.authored} authored migration(s) were not replayed ` +
        `after ${check.key} failed) — the fence still refuses at promote`
      );
  }
}

/**
 * Replay the vertical's migrations through its own kernel's fence. Throws when the fence would
 * refuse one, and — with `require` — when the check was skipped or incomplete. Otherwise returns
 * the outcome, having printed each declared move and discard with its reason (`log`) and the
 * summary (`log` when passed, `warn` — stderr — when it is not).
 */
export async function checkMigrationDataLoss(
  inputs: ReplayInputs,
  opts: {
    readonly require?: boolean;
    readonly openSqlite?: () => Promise<SqliteOpener | undefined>;
    readonly log?: (message: string) => void;
    readonly warn?: (message: string) => void;
  } = {},
): Promise<DataLossCheck> {
  const log = opts.log ?? console.log;
  const warn = opts.warn ?? console.error;
  const check = await replay(inputs, opts.openSqlite ?? openInMemorySqlite, log);
  const line = formatDataLossCheck(check);
  if (check.status === 'passed') {
    log(line);
    return check;
  }
  if (check.status === 'incomplete') {
    warn(`⚠ ${check.key} could not be replayed on synthetic data: ${check.message}`);
    if (/no such table: _substrat_/i.test(check.message)) {
      warn(
        '  it reads a platform table this CLI could not build: add @substrat-run/adapter-sqlite as a devDependency ' +
          'so the replay can create them.',
      );
    }
  }
  if (opts.require) {
    throw new Error(`${line}.\n--require-data-loss-check (or SUBSTRAT_REQUIRE_DATA_LOSS_CHECK=1) refuses a push it could not fully check.`);
  }
  warn(`⚠ ${line}`);
  return check;
}

async function replay(
  inputs: ReplayInputs,
  openSqlite: () => Promise<SqliteOpener | undefined>,
  log: (message: string) => void,
): Promise<DataLossCheck> {
  const kernel = inputs.kernel as KernelReplay | null;
  const authoredCount = inputs.modules.reduce<number>((n, m) => {
    const migrations = (m as { migrations?: unknown }).migrations;
    return n + (Array.isArray(migrations) ? migrations.length : 0);
  }, 0);
  // Nothing authored, nothing the fence judges — and no reason to need SQLite.
  if (authoredCount === 0) return { status: 'passed', authored: 0 };
  if (!kernel) return { status: 'skipped', why: 'no @substrat-run/kernel resolves from the vertical' };
  if (typeof kernel.replayMigrations !== 'function') {
    return { status: 'skipped', why: "the vertical's @substrat-run/kernel has no migration replay (upgrade it)" };
  }
  if (kernel.MIGRATION_REPLAY_API !== REPLAY_API) {
    return {
      status: 'skipped',
      why: `the vertical's @substrat-run/kernel has migration replay API ${String(kernel.MIGRATION_REPLAY_API)}, this CLI calls ${REPLAY_API} (upgrade the CLI)`,
    };
  }
  const open = await openSqlite();
  if (!open) return { status: 'skipped', why: `node:sqlite unavailable on Node ${process.versions.node}; it needs 22.13 or later` };

  const db = open();
  const database = {
    exec: (q: string) => db.exec(q),
    query: (q: string, p: readonly unknown[] = []) => db.prepare(q).all(...p),
    run: (q: string, p: readonly unknown[] = []) => ({ changes: Number(db.prepare(q).run(...p).changes) }),
  };
  let outcome: unknown;
  try {
    const spineDdl = await inputs.spineDdl();
    outcome = (kernel.replayMigrations as (db: unknown, modules: readonly unknown[], opts: unknown) => unknown)(
      database,
      inputs.modules,
      { spineDdl },
    );
  } catch (e) {
    return { status: 'skipped', why: `the replay itself failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isOutcome(outcome)) return { status: 'skipped', why: "the vertical's kernel returned a replay outcome this CLI does not recognise" };
  for (const line of outcome.declared) log(`declared  ${line}`);
  if (outcome.refused) {
    throw new Error(
      `data-loss check: REFUSED — ${outcome.refused.message}\n` +
        'A scope holding that data would refuse this migration at promote and fail closed. Fix the migration, or ' +
        `declare the loss on it (\`moves\` / \`discards\`, with its reason) for review — ${DOCS}.`,
    );
  }
  if (outcome.failed) {
    return {
      status: 'incomplete',
      authored: outcome.authored,
      notReplayed: outcome.authored - outcome.passed,
      key: outcome.failed.key,
      message: outcome.failed.message,
    };
  }
  return { status: 'passed', authored: outcome.authored };
}
