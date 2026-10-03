import type { SwitchSql } from './system-switch.js';

/**
 * What a dump leaves behind when it lands in a scope other than the one it was captured from
 * (#1686). One definition for both adapters' loaders, so the DO and the pure host agree.
 *
 * A load is a **copy** when the destination is not the source: a fork, a snapshot, a preview, or
 * one scope's backup restored onto another. It is a **return** when the dump goes back into the
 * scope it came from: a backup restore, a carry onto a new version, adopt, rebind. A copy runs as
 * a scope of its own, so whatever in the dump is bound to being the source (a live link's secret,
 * a side effect the source asked for) must not work in the copy. A return keeps all of it, because
 * restoring a backup must not end live links or lose requests that were waiting.
 *
 * An unknown source (`sourceScopeId` or `destScopeId` absent) counts as a copy: a load that cannot
 * say where the dump came from cannot show it is a return. Only a control plane that predates the
 * field sends a restore with no source.
 */
const isCopy = (destScopeId: string | undefined, sourceScopeId: string | undefined): boolean =>
  destScopeId === undefined || sourceScopeId !== destScopeId;

/** The two capability tables, lowercased, as `capabilitiesForLoad` matches a dump's names. */
const CAPABILITY_TABLES: ReadonlySet<string> = new Set(['_substrat_capabilities', '_substrat_capability_sessions']);

/**
 * A dump's tables as a load into `destScopeId` takes them: **capability rows never cross a scope
 * id.** A copy loads both capability tables empty, so a live link share opens the scope it was
 * minted in and never a copy of it; a return keeps them.
 *
 * Dropped, not loaded as revoked: the copy never minted those links, so a revocation recorded
 * there would be evidence of something that did not happen in it. Names are matched without
 * case, as SQLite resolves a table name.
 */
export function capabilitiesForLoad<T extends { name: string; rows: readonly unknown[] }>(
  tables: readonly T[],
  destScopeId: string | undefined,
  sourceScopeId: string | undefined,
): T[] {
  if (!isCopy(destScopeId, sourceScopeId)) return [...tables];
  return tables.map((t) => (CAPABILITY_TABLES.has(t.name.toLowerCase()) ? { ...t, rows: [] } : t));
}

/** The reason a copied intent is settled with. Names the source, so the journal says where it runs. */
const notCarried = (sourceScopeId: string | undefined): string =>
  `not carried: copied from ${sourceScopeId ? `scope ${sourceScopeId}` : 'another scope'} before it ran; ` +
  'it runs in the scope that asked for it, never in a copy';

/**
 * Settle every intent a copy brought in still `pending`, as `failed` with a "not carried" reason
 * attributed to the platform. Run inside the load's transaction, after the rows are in.
 *
 * The platform's drain walks every active scope, and a fork, a snapshot or a preview is one. A
 * pending intent copied from the source would otherwise be executed a second time from the copy:
 * an email sent twice, a connector delivery repeated, a usage line billed twice. A return leaves
 * them pending, because the scope that asked for them is the one they are back in.
 *
 * Settled rather than dropped: the copy's outbox carries the event that raised each intent, and a
 * journal row saying it was not carried explains why nothing happened here. Rows already settled
 * at the source are its history and are left as they are.
 */
export function settleCopiedIntents(
  sql: SwitchSql,
  destScopeId: string | undefined,
  sourceScopeId: string | undefined,
  now: string,
): void {
  if (!isCopy(destScopeId, sourceScopeId)) return;
  sql.run(
    `UPDATE _substrat_platform_requests
        SET status = 'failed', last_error = ?, last_failure = ?, settled_at = ?
      WHERE status = 'pending'`,
    notCarried(sourceScopeId),
    JSON.stringify({ origin: 'platform', code: 'precondition_failed', permission: null }),
    now,
  );
}
