import { moduleMigrations } from './module-migrations.js';
import { attachmentSha256, type SqlMigration } from './scope-host.js';

// Declared locally so the kernel needs no platform type packages (§5.8), as `capability.ts` does.
declare const TextEncoder: new () => { encode(input: string): Uint8Array };

/**
 * What a scope's migration journal records beside each version, and the check that reads it
 * (#2066). Shared by both adapters, so the rule and the sentence an operator reads are one.
 *
 * A scope used to record an applied migration by `(module_id, version)` alone, so a later
 * `0025` whose SQL differed from the `0025` it ran was skipped as already applied: a dev
 * database that ran one branch's `0025` and then `main`'s, or a preview that ran an unmerged
 * branch, kept whichever schema it got first, and the first sign was a query failing against
 * a column that was not there. `_substrat_migrations.sql_digest` closes that.
 *
 * - **The digest is SHA-256 over the exact SQL text**, lowercase hex, with no normalisation:
 *   not whitespace, not comments, not line endings. Any change is a different migration. A
 *   shipped migration's text never changes on `main` (`lint:migrations --check` refuses the
 *   edit upstream), so a difference at a scope means the scope ran something else.
 * - **Only a module's AUTHORED migrations are held to it.** The kernel-derived DDL
 *   (`search/…`, `state/…`, `list/…`, see `moduleMigrations`) is versioned by its
 *   declaration on purpose: the version names what decides the DDL, so the kernel may change
 *   how it spells the same declaration between releases. Holding those rows to a digest would
 *   fail every scope with a searchable entity closed on the kernel upgrade that respelled a
 *   trigger. Their digest is still recorded, as the fact of what ran.
 * - **A row with no digest is accepted and left NULL.** It was written before the column,
 *   and nobody measured what it ran. Backfilling the registered digest would write a value
 *   nobody measured, and bless the one row this exists to catch if that scope did run
 *   something else; NULL says "unrecorded", which is true. Such a row is unprotected for
 *   good, which is the price of not lying in the journal.
 */
export function migrationDigest(sql: string): Promise<string> {
  return attachmentSha256(new TextEncoder().encode(sql));
}

/** One migration a host applies, with its digest and whether it is held to it. */
export interface MigrationStep {
  migration: SqlMigration;
  digest: string;
  /** Authored by the module, so held to its digest; false for kernel-derived DDL. */
  authored: boolean;
}

type Registration = Parameters<typeof moduleMigrations>[0];
const stepsOf = new WeakMap<Registration, Promise<readonly MigrationStep[]>>();

/**
 * A module's migrations in the order the host applies them (`moduleMigrations`), each with its
 * digest and whether it is authored. Memoised per registration, so a Durable Object that wakes
 * with the same code-time modules hashes nothing again.
 */
export function migrationSteps(registration: Registration): Promise<readonly MigrationStep[]> {
  let steps = stepsOf.get(registration);
  if (!steps) {
    const authored = new Set((registration.migrations ?? []).map((m) => m.version));
    steps = Promise.all(
      moduleMigrations(registration).map(async (migration) => ({
        migration,
        digest: await migrationDigest(migration.sql),
        authored: authored.has(migration.version),
      })),
    );
    stepsOf.set(registration, steps);
  }
  return steps;
}

/** A step a migration pass still has to run, with the module it belongs to. */
export interface PendingMigration extends MigrationStep {
  moduleId: string;
}

/** What a migration pass has to do, or the divergence that fails the scope closed instead. */
export type MigrationPlan =
  | { pending: PendingMigration[]; diverged?: undefined }
  | { pending: []; diverged: { version: string; error: string } };

/**
 * Plan a scope's migration pass against its journal (`module@version` → recorded digest): the
 * registered steps it has not applied, or the first applied one whose SQL differs, which fails
 * the scope closed before anything else runs. Both adapters plan through this.
 */
export async function planMigrations(
  modules: Iterable<{ readonly id: string; readonly steps: Promise<readonly MigrationStep[]> }>,
  applied: ReadonlyMap<string, string | null>,
): Promise<MigrationPlan> {
  const pending: PendingMigration[] = [];
  for (const mod of modules) {
    for (const step of await mod.steps) {
      const key = `${mod.id}@${step.migration.version}`;
      if (!applied.has(key)) {
        pending.push({ moduleId: mod.id, ...step });
        continue;
      }
      const error = migrationDivergence(applied.get(key), step.digest, step.authored);
      if (error) return { pending: [], diverged: { version: key, error } };
    }
  }
  return { pending };
}

/** The error a scope fails closed with when `module@version` cannot be applied or trusted. */
export function migrationFailedError(key: string, cause: string): Error {
  return new Error(`migration failed for ${key} — scope fails closed: ${cause}`);
}

/**
 * Why a registered migration the scope has already applied cannot be trusted, or null when it
 * can: a recorded digest that differs from the registered one, on an authored migration.
 *
 * The caller fails the scope closed with this as the cause, the way a migration that threw
 * does — the same `migration failed for <module>@<version> — scope fails closed:` record, so
 * the directory, the sweep and the dashboard read it with nothing new. The scope recovers
 * when its journal and its schema agree with the deployment again: a scope that ran another
 * branch's migration is rebuilt (a dev database, a preview) or restored to a dump taken before
 * it ran; a deployment carrying the wrong SQL is redeployed with the SQL the scope ran. A
 * migration is never edited or renumbered once a scope has it, so re-numbering is not a
 * recovery: the scope would still hold the other SQL under this version.
 */
export function migrationDivergence(
  recorded: string | null | undefined,
  registered: string,
  authored: boolean,
): string | null {
  if (!authored || recorded == null || recorded === registered) return null;
  return (
    `this scope applied different SQL under this version (applied sha256 ${recorded}, ` +
    `registered sha256 ${registered}). Rebuild the scope, or restore it to a dump taken before ` +
    `it ran the other SQL; a migration is never edited or renumbered once a scope has applied it (#2066)`
  );
}
