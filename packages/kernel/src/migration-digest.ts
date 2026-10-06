import { substratError, tokenizeSql } from '@substrat-run/contracts';
import { moduleMigrations } from './module-migrations.js';
import { assertNoSpineReference, assertNoSpineWrite } from './spine-guard.js';
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
 * - **A row applied before the column carries `'legacy'`, and is accepted.** Nobody measured
 *   what it ran, so it gets no digest: backfilling the registered one would write a value
 *   nobody measured, and bless the one row this exists to catch if that scope did run
 *   something else. The mark is explicit rather than a NULL, because a NULL cannot say where it
 *   came from: the rows present when the column arrives are marked (`MIGRATION_DIGEST_MARK_LEGACY`),
 *   a dump taken before the column restores as `'legacy'` (the restore derives it), and from
 *   then on the fence below refuses a NULL however it is written. So `'legacy'` is provenance,
 *   and a NULL — say a dump edited to clear a digest — is refused rather than trusted. Such a
 *   row is unprotected for good, which is the price of not lying in the journal.
 */
export function migrationDigest(sql: string): Promise<string> {
  return attachmentSha256(new TextEncoder().encode(sql));
}

/** What a journal row applied before digests were recorded carries in `sql_digest` (#2066). */
export const MIGRATION_DIGEST_LEGACY = 'legacy';

/**
 * Marks the rows present when the column arrived. Run right after the column's ALTER on every
 * wake: once the fence is in place it can only ever find those rows, since nothing else can
 * leave a NULL. Literal text, like the fence, so `lint:spine-ddl` and a reviewer read one spelling.
 */
export const MIGRATION_DIGEST_MARK_LEGACY = "UPDATE _substrat_migrations SET sql_digest = 'legacy' WHERE sql_digest IS NULL";

/**
 * The fence: no journal row is written, or rewritten, without a digest or the legacy mark — in
 * both adapters' KERNEL_DDL, after the journal table, so `lint:spine-ddl` holds it like any
 * spine trigger.
 *
 * Without it an older writer (an instance still on the previous release during a rollout or a
 * rollback, or a second process over the same SQLite file) inserts a row that omits the
 * column, and SQLite records NULL. With it that INSERT aborts, so the older writer's migration
 * fails and its scope fails closed until code that records the digest serves it, which then
 * applies the migration properly. KERNEL_DDL runs before the column is ALTERed onto a legacy
 * journal, and on a table without the column the INSERT trigger makes any INSERT fail with
 * `no such column`: there is no window in which a NULL can be written. A restore loads its
 * rows under the fence too, so a dump that carries a NULL is refused (`spineRowsInsert` gives a
 * dump from before the column the legacy mark instead).
 *
 * Migration SQL cannot drop it: `assertNoJournalSql` refuses any migration naming the journal.
 * Literal text, no interpolation: `lint:spine-ddl` inlines a kernel fragment one level deep.
 */
export const MIGRATION_DIGEST_FENCE_DDL = `
  CREATE TRIGGER IF NOT EXISTS _substrat_migrations_digest_required
  BEFORE INSERT ON _substrat_migrations WHEN NEW.sql_digest IS NULL
  BEGIN
    SELECT RAISE(ABORT, 'a migration journal row must carry its sql_digest (#2066)');
  END;
  CREATE TRIGGER IF NOT EXISTS _substrat_migrations_digest_kept
  BEFORE UPDATE OF sql_digest ON _substrat_migrations WHEN NEW.sql_digest IS NULL
  BEGIN
    SELECT RAISE(ABORT, 'a migration journal row must carry its sql_digest (#2066)');
  END;
`;

/**
 * Refuse migration SQL that names the migration journal (`_substrat_migration…`: the table, its
 * fence, the DO's bookmarks), in any spelling the grammar allows — quoted, any case, schema-
 * qualified — before any of it runs.
 *
 * A migration runs on the kernel's own handle, not `ctx.sql`, so the spine write guard never
 * sees it, and an authored migration that repairs `_substrat_tuples` is a reviewed, linted path
 * (`boundary-lint-allow R4 migration`). The journal is different: a migration that drops the
 * fence, or writes its own journal rows, makes the digest check say whatever it wrote. Nothing
 * legitimate in a module's migration names it, reads included.
 */
export function assertNoJournalSql(sql: string, what: string): void {
  for (const token of tokenizeSql(sql)) {
    if (!token.text.split('.').some((part) => part.toLowerCase().startsWith('_substrat_migration'))) continue;
    throw substratError(
      'forbidden',
      `${what} cannot name the migration journal ('${token.text}'): the journal and its digest fence are the kernel's (#2066)`,
      { reason: 'spine_write' },
    );
  }
}

/**
 * The authored migrations allowed to write the spine: four shipped ticket0 repairs of its own
 * `_substrat_tuples` edges and its hand-recreated derived list indexes, each reviewed under
 * `boundary-lint-allow R4 migration`. Keyed by module, version AND the digest of the exact text,
 * so only those texts pass: a new migration, or any edit to one of these, gets the full guard.
 * Shipped migrations are append-only, so this list only ever shrinks — a new spine repair goes
 * through the platform, not a migration.
 */
const REVIEWED_SPINE_MIGRATIONS: ReadonlySet<string> = new Set([
  '@substrat-run/demo-ticket0@0020#d29122b68f3cc5d07a70fb87874085e0e6805e2e19612984160488c59789d75c',
  '@substrat-run/demo-ticket0@0022#9de9088207fa914e9eb8c8344924708655cbecb11e5b64f76e1d2ec7d0bd0ea2',
  '@substrat-run/demo-ticket0@0024#ba60103ae91108bfce21fd5b24818cec18aefe4ee3b03b49ca8013fd2634aae3',
  '@substrat-run/demo-ticket0@0026#da0bb4e3c8b13f5febd8b2202e7267c30e9ee91a19d202181b99ccdeb71ec3a4',
]);

/**
 * Refuse a migration's SQL before any of it runs, if it reaches where a migration must not.
 *
 * A migration runs on the kernel's own handle, not `ctx.sql`, so `ctx.sql`'s guard never sees it.
 * Every migration is held to: no foreign key to the spine (#1898), and nothing that names the
 * journal (`assertNoJournalSql`). An AUTHORED one is also held to the full spine write guard —
 * no write, DDL or same-named TEMP object on any `_substrat_*` table — unless it is one of the
 * exact reviewed texts above. Kernel-derived DDL is exempt from that last rule: creating
 * `_substrat_*` indexes and triggers is what it is for.
 */
export function assertMigrationSql(sql: string, step: { key: string; digest: string; authored: boolean }): void {
  const what = `migration ${step.key}`;
  assertNoSpineReference(sql, what);
  assertNoJournalSql(sql, what);
  if (!step.authored || REVIEWED_SPINE_MIGRATIONS.has(`${step.key}#${step.digest}`)) return;
  try {
    assertNoSpineWrite(sql);
  } catch (err) {
    throw substratError('forbidden', `${what} cannot write the platform spine: ${(err as Error).message.replace(/^ctx\.sql cannot write the platform spine: /, '')}`, {
      reason: 'spine_write',
    });
  }
}

/**
 * Refuse a dump whose journal is not consistent with its own shape (#2066 r3): a table whose
 * recorded DDL declares `sql_digest` while its columns omit it, or the other way round.
 *
 * A dump exported before digests were recorded restores as `'legacy'` (`spineRowsInsert`), so
 * the shape of the journal is what says which kind of dump this is — and a current dump with
 * the column stripped would otherwise pass as legacy and unprotect every row. The dump's DDL is
 * `sqlite_master`'s text, which an ALTER rewrites, so a real pre-#2066 journal carries neither.
 * Nothing else a dump carries changed with #2066 to cross-check against (the fence is a trigger,
 * and a dump holds tables). A dump is freely editable data: a consistent edit of both is not
 * detectable, and restore is privileged, audited staff work that could forge any digest anyway.
 * This catches corruption and partial edits, not an author set on lying.
 */
export function assertJournalDumpCoherent(tables: readonly { name: string; ddl: string; columns: readonly string[] }[]): void {
  for (const t of tables) {
    if (t.name.toLowerCase() !== '_substrat_migrations') continue;
    const declared = tokenizeSql(t.ddl).some((tok) => tok.text.toLowerCase() === 'sql_digest');
    const carried = t.columns.some((c) => c.toLowerCase() === 'sql_digest');
    if (declared === carried) continue;
    throw substratError(
      'validation_failed',
      `restore refused: the dump's _substrat_migrations ${declared ? 'declares sql_digest in its DDL but carries no such column' : 'carries sql_digest but its DDL does not declare it'} — ` +
        `it is neither a dump from before digests were recorded nor a whole one from after. Nothing was changed (#2066).`,
    );
  }
}

/** One migration a host applies, with its digest and whether it is held to it. */
export interface MigrationStep {
  migration: SqlMigration;
  digest: string;
  /** Authored by the module, so held to its digest; false for kernel-derived DDL. */
  authored: boolean;
}

/**
 * Digests by SQL text. Keyed on the content, not on the registration object: a registration
 * mutated or rebuilt with other SQL under the same version gets that SQL's digest, never a
 * stale one. Bounded by the distinct migration texts the isolate has registered.
 */
const digestOf = new Map<string, Promise<string>>();
const cachedDigest = (sql: string): Promise<string> => {
  let digest = digestOf.get(sql);
  if (!digest) digestOf.set(sql, (digest = migrationDigest(sql)));
  return digest;
};

/**
 * A module's migrations in the order the host applies them (`moduleMigrations`), each with its
 * digest and whether it is authored — read from the registration as it is now. The digest of a
 * text is computed once per isolate, so a Durable Object that wakes with the same code hashes
 * nothing again.
 */
export function migrationSteps(registration: Parameters<typeof moduleMigrations>[0]): Promise<readonly MigrationStep[]> {
  const authored = new Set((registration.migrations ?? []).map((m) => m.version));
  return Promise.all(
    moduleMigrations(registration).map(async (migration) => ({
      migration,
      digest: await cachedDigest(migration.sql),
      authored: authored.has(migration.version),
    })),
  );
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
 * can: on an authored migration, a recorded digest that differs from the registered one, or
 * no digest and no legacy mark at all.
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
  if (!authored || recorded === undefined || recorded === registered || recorded === MIGRATION_DIGEST_LEGACY) return null;
  if (recorded === null) {
    // The fence makes this unreachable through the kernel; a row that has it anyway was not
    // written by the kernel, and says nothing about what ran.
    return (
      `this scope's journal records neither a digest nor the legacy mark for this version, so ` +
      `what it ran is unknown (registered sha256 ${registered}). Rebuild the scope, or restore it ` +
      `to a dump the kernel wrote (#2066)`
    );
  }
  return (
    `this scope applied different SQL under this version (applied sha256 ${recorded}, ` +
    `registered sha256 ${registered}). Rebuild the scope, or restore it to a dump taken before ` +
    `it ran the other SQL; a migration is never edited or renumbered once a scope has applied it (#2066)`
  );
}
