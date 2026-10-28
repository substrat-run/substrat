/**
 * A store driver's releases, its rollouts and the holds that serialize them (D-63, #2300), shared by
 * both adapters' directories.
 *
 * - `store_driver_releases`: a release's bytes were stored (the bytes themselves live outside the
 *   directory, keyed by driver and sha256). Insert-only: who uploaded a release, and from which
 *   commit, is never rewritten.
 * - `store_driver_approvals`: an inert, append-only approval record for D-65. A partial unique
 *   index permits one live approval per release. `store_driver_revoke_walks` is a cursor per
 *   approval, not a second record of which release each script runs.
 * - `store_driver_rollouts`: one row per attempt to move every script of the driver to a release, in
 *   `seq` order. A row is `rolling` until its holder ends it `good`, `failed` or `diverged`.
 * - `store_driver_current`: the release the last `good` rollout moved every script to.
 * - `store_driver_rollout_walks`: the walk ledger of a rollout paged over several requests (#2312).
 *   Each row is one declaration (vertical, binding, and the version that first declared it) an
 *   earlier request of the same attempt walked; the next request walks only what is not in it.
 *
 * "The immediately previous good release" (D-63) is recorded, never derived from an ordering:
 * each rollout row names `previous_good_sha256`, the release a rollback from it returns to. A
 * rollout of T from current F records F; a rollback goes to the current row's previous good X, and
 * records X's own previous good, so after r1 → r2 → r3 one rollback reaches r2 and the next r1.
 *
 * A hold is a lease: `exclusive` for a rollout or a rollback, `shared` for a push or serve that
 * rebuilds a script at the release it runs, which a rollout must not interleave with (a rebuild
 * that read the old release and uploaded after the rollout moved the script would revert it).
 * A begin or finish is refused unless the caller still holds the driver exclusively, so a holder
 * whose lease lapsed cannot write over the next one; its `rolling` row reads as `diverged` to the
 * next rollout, which converges every script again.
 *
 * - `store_driver_rebuilds` (#2309): the platform's walk that rebuilds every script of the driver
 *   at the release it runs, after what the platform builds a script from changed (a key list, the
 *   entry, its verifier). One row per driver: the `fingerprint` of what the platform builds from
 *   that the walk converges on, the last vertical it walked (`cursor`, in slug order), the
 *   verticals it could not rebuild, and whether it is `done`. A new fingerprint starts the walk
 *   again. The row carries its own lease, so two passes never walk one driver at once.
 */
import { substratError } from '@substrat-run/contracts';
import type { SwitchSql } from './system-switch.js';
import { driverDeclarationsOf } from './vertical-scope-stores.js';

/** Interpolated into both adapters' directory DDL, so `lint:spine-ddl` sees one spelling on each side. */
export const STORE_DRIVER_RELEASES_DDL = `
  CREATE TABLE IF NOT EXISTS store_driver_releases (
    driver        TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    source_commit TEXT NOT NULL,
    uploaded_by   TEXT NOT NULL,
    uploaded_at   TEXT NOT NULL,
    PRIMARY KEY (driver, sha256)
  );
  -- D-65 approval data. No release is admitted by this table until every pin reader switches.
  CREATE TABLE IF NOT EXISTS store_driver_approvals (
    approval_id       TEXT PRIMARY KEY,
    driver            TEXT NOT NULL,
    sha256            TEXT NOT NULL,
    source_commit     TEXT NOT NULL,
    approved_by       TEXT NOT NULL,
    approved_at       TEXT NOT NULL,
    reason            TEXT NOT NULL,
    source_references TEXT NOT NULL,
    isolation_review TEXT NOT NULL,
    schema            INTEGER NOT NULL,
    class_name        TEXT NOT NULL,
    operations        TEXT NOT NULL,
    revoked_by        TEXT,
    revoked_at        TEXT,
    revoked_reason    TEXT,
    revoked_emergency INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS store_driver_approvals_one_live
    ON store_driver_approvals (driver, sha256) WHERE revoked_at IS NULL;
  -- A revoke walk belongs to one approval, even if the same bytes are approved again later.
  -- Its cursor records a vertical slug, never which release that vertical runs.
  CREATE TABLE IF NOT EXISTS store_driver_revoke_walks (
    approval_id TEXT PRIMARY KEY REFERENCES store_driver_approvals(approval_id),
    driver      TEXT NOT NULL,
    sha256      TEXT NOT NULL,
    cursor      TEXT,
    actor       TEXT NOT NULL,
    reason      TEXT NOT NULL,
    rollout_seq INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS store_driver_rollouts (
    driver               TEXT NOT NULL,
    seq                  INTEGER NOT NULL,
    sha256               TEXT NOT NULL,
    action               TEXT NOT NULL,
    from_sha256          TEXT,
    previous_good_sha256 TEXT,
    state                TEXT NOT NULL,
    actor                TEXT NOT NULL,
    -- The hold the rollout runs under: a rolling row whose holder holds nothing has stopped.
    holder               TEXT NOT NULL,
    started_at           TEXT NOT NULL,
    ended_at             TEXT,
    detail               TEXT,
    PRIMARY KEY (driver, seq)
  );
  CREATE TABLE IF NOT EXISTS store_driver_current (
    driver TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    seq    INTEGER NOT NULL
  );
  -- One declaration an attempt walked (#2312). The attempt is the seq of its first row; a row
  -- continues it while the rows before it are paused at the same release and action.
  CREATE TABLE IF NOT EXISTS store_driver_rollout_walks (
    driver           TEXT NOT NULL,
    attempt          INTEGER NOT NULL,
    vertical_slug    TEXT NOT NULL,
    binding          TEXT NOT NULL,
    first_version_id TEXT NOT NULL,
    PRIMARY KEY (driver, attempt, vertical_slug, binding, first_version_id)
  );
  CREATE TABLE IF NOT EXISTS store_driver_holds (
    driver     TEXT NOT NULL,
    holder     TEXT NOT NULL,
    mode       TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (driver, holder)
  );
  CREATE TABLE IF NOT EXISTS store_driver_rebuilds (
    driver           TEXT PRIMARY KEY,
    fingerprint      TEXT NOT NULL,
    -- When this fingerprint was first walked towards: a restart keeps it, a new fingerprint resets it.
    fingerprint_since TEXT NOT NULL,
    cursor           TEXT,
    failures         TEXT NOT NULL,
    state            TEXT NOT NULL,
    holder           TEXT,
    lease_expires_at INTEGER NOT NULL,
    -- When this walk began from its first script: a restart or a new fingerprint sets it, a pass
    -- that continues the walk keeps it.
    started_at       TEXT NOT NULL,
    -- The person who attested, when this walk began, that no control-plane deploy was rolling out.
    attested_by      TEXT,
    -- When a walk towards this fingerprint last proved every script current; kept across a
    -- restart at the same fingerprint, cleared by a new one.
    verified_at      TEXT,
    updated_at       TEXT NOT NULL,
    finished_at      TEXT
  );
`;

/**
 * The directory's names from before a store's code was called a driver (K-53's rename): the four
 * release tables were `store_kind_*`, and they and `vertical_scope_stores` keyed by a `kind`
 * column. The values are the same ids, so only names move.
 */
const LEGACY_STORE_DRIVER_TABLES: ReadonlyMap<string, string> = new Map([
  ['store_kind_releases', 'store_driver_releases'],
  ['store_kind_rollouts', 'store_driver_rollouts'],
  ['store_kind_current', 'store_driver_current'],
  ['store_kind_holds', 'store_driver_holds'],
]);
const DRIVER_KEYED_TABLES = [...LEGACY_STORE_DRIVER_TABLES.values(), 'vertical_scope_stores'];

/**
 * The statements that move a directory built before the rename onto its names, to run before
 * the directory's DDL on every start: that DDL is all `IF NOT EXISTS`, so it would leave an old
 * table as it is and create an empty one beside it. Renames keep every row, a release uploaded
 * before its pin included. Empty once moved, so a later start does nothing.
 *
 * A directory can hold both names: code from before the rename, run again after it (a rollback),
 * creates the old tables empty beside the moved ones, and writes to them while it runs. Then the
 * name that holds no rows is dropped, and the one that holds them ends under the new name. When
 * both hold rows, both are left where they are: nothing is merged, and nothing with rows is
 * dropped.
 *
 * `tables` is every table the directory holds; `columnsOf` answers a table's columns, and
 * `hasRows` whether it holds any.
 */
export function legacyStoreDriverRenames(
  tables: readonly string[],
  columnsOf: (table: string) => readonly string[] | undefined,
  hasRows: (table: string) => boolean,
): string[] {
  const held = new Set(tables.map((t) => t.toLowerCase()));
  const statements: string[] = [];
  const renamed = new Set<string>();
  for (const [from, to] of LEGACY_STORE_DRIVER_TABLES) {
    if (!held.has(from)) continue;
    if (held.has(to)) {
      if (!hasRows(from)) {
        statements.push(`DROP TABLE ${from}`);
        continue;
      }
      if (hasRows(to)) continue;
      statements.push(`DROP TABLE ${to}`);
    }
    statements.push(`ALTER TABLE ${from} RENAME TO ${to}`);
    renamed.add(to);
  }
  for (const table of DRIVER_KEYED_TABLES) {
    const columns = renamed.has(table) ? ['kind'] : held.has(table) ? (columnsOf(table) ?? []) : [];
    const lowered = columns.map((c) => c.toLowerCase());
    if (lowered.includes('kind') && !lowered.includes('driver')) {
      statements.push(`ALTER TABLE ${table} RENAME COLUMN kind TO driver`);
    }
  }
  return statements;
}

/** What to do about a table that holds rows under both names (see {@link legacyStoreDriverRenames}). */
const BOTH_NAMES_REMEDY =
  'Restore a directory dump taken before the pre-rename code ran again (a restore replaces every table), ' +
  'or export the store_kind_* rows, carry over any that are still wanted, and drop the store_kind_* tables by hand.';

/**
 * The tables that hold rows under both names, which {@link legacyStoreDriverRenames} leaves
 * alone, as one line a start logs: until one is cleared, a directory dump carries both and a
 * restore of it is refused. Undefined when there are none. Reachable only after a rollback to
 * pre-rename code that wrote a release, rollout or hold, which no registered driver allowed yet.
 */
export function legacyStoreDriverConflict(tables: readonly string[], hasRows: (table: string) => boolean): string | undefined {
  const held = new Set(tables.map((t) => t.toLowerCase()));
  const both = [...LEGACY_STORE_DRIVER_TABLES].filter(
    ([from, to]) => held.has(from) && held.has(to) && hasRows(from) && hasRows(to),
  );
  if (both.length === 0) return undefined;
  return (
    `substrat: the directory holds rows under both ${both.map(([from, to]) => `${from} and ${to}`).join(', ')}: ` +
    `code from before the store driver rename (K-53) ran again and wrote them. Both are kept, and a directory ` +
    `dump of it is refused at restore until one is cleared. ${BOTH_NAMES_REMEDY}`
  );
}

/**
 * A directory dump's tables with the pre-rename names mapped onto this code's (see
 * {@link legacyStoreDriverRenames}), so a copy taken before the rename restores: the dump's rows
 * go in by name, and a restore refuses a table it does not build. A dump that carries a table
 * under both names keeps the one that holds rows, the way a start does; one where both hold rows
 * is refused, since loading both would merge two histories.
 */
export function mapLegacyStoreDriverDump<
  T extends { readonly name: string; readonly columns: readonly string[]; readonly rows: readonly unknown[] },
>(tables: readonly T[]): T[] {
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const dropped = new Set<T>();
  for (const [from, to] of LEGACY_STORE_DRIVER_TABLES) {
    const legacy = byName.get(from);
    const current = byName.get(to);
    if (!legacy || !current) continue;
    if (legacy.rows.length === 0) dropped.add(legacy);
    else if (current.rows.length === 0) dropped.add(current);
    else {
      throw substratError(
        'validation_failed',
        `restore refused: the dump carries rows in both ${legacy.name} and ${current.name}, the same table ` +
          `before and after the store driver rename (K-53). Nothing was changed. ${BOTH_NAMES_REMEDY}`,
      );
    }
  }
  return tables.filter((t) => !dropped.has(t)).map((t) => {
    const name = LEGACY_STORE_DRIVER_TABLES.get(t.name.toLowerCase()) ?? t.name;
    if (!DRIVER_KEYED_TABLES.includes(name.toLowerCase())) return t;
    const columns = t.columns.map((c) => c.toLowerCase());
    const keepsKind = columns.includes('kind') && !columns.includes('driver');
    return { ...t, name, columns: keepsKind ? t.columns.map((c) => (c.toLowerCase() === 'kind' ? 'driver' : c)) : t.columns };
  });
}

/** A stored release: its bytes are kept elsewhere under `<driver>/<sha256>`. */
export interface StoreDriverReleaseRecord {
  readonly driver: string;
  readonly sha256: string;
  readonly sourceCommit: string;
  readonly uploadedBy: string;
  readonly uploadedAt: string;
}

export type StoreDriverRolloutAction = 'rollout' | 'rollback';
/**
 * `paused`: the request's batch ran out with verticals left to walk. Nothing failed; the fleet is
 * part way, and posting the same rollout (or the same rollback) again continues it.
 */
export type StoreDriverRolloutState = 'rolling' | 'good' | 'failed' | 'diverged' | 'paused';

export interface StoreDriverRolloutRecord {
  readonly driver: string;
  readonly seq: number;
  readonly sha256: string;
  readonly action: StoreDriverRolloutAction;
  /** The current good release when the rollout began; null for a driver's first. */
  readonly fromSha256: string | null;
  /** Where a rollback from this release, once it is good, returns to; null when nowhere. */
  readonly previousGoodSha256: string | null;
  readonly state: StoreDriverRolloutState;
  readonly actor: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly detail: string | null;
}

export interface StoreDriverState {
  /** The release the last good rollout reached, and that rollout. Null before any. */
  readonly current: { readonly sha256: string; readonly seq: number; readonly previousGoodSha256: string | null } | null;
  /** Every rollout, oldest first. */
  readonly rollouts: StoreDriverRolloutRecord[];
  /** Where a rollback goes now (see `storeDriverStateIn`); null when nowhere. */
  readonly rollbackTarget: string | null;
  /** The target of a rollback that paused or diverged part way, until it ends good. Unless it is the current release, it blocks rollouts. */
  readonly unfinishedRollback: string | null;
}

export type StoreDriverHoldMode = 'shared' | 'exclusive';

interface RolloutRow {
  driver: string;
  seq: number;
  sha256: string;
  action: StoreDriverRolloutAction;
  from_sha256: string | null;
  previous_good_sha256: string | null;
  state: StoreDriverRolloutState;
  actor: string;
  started_at: string;
  ended_at: string | null;
  detail: string | null;
}

const rolloutOf = (r: RolloutRow): StoreDriverRolloutRecord => ({
  driver: r.driver,
  seq: Number(r.seq),
  sha256: r.sha256,
  action: r.action,
  fromSha256: r.from_sha256,
  previousGoodSha256: r.previous_good_sha256,
  state: r.state,
  actor: r.actor,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  detail: r.detail,
});

const ROLLOUT_COLUMNS =
  'driver, seq, sha256, action, from_sha256, previous_good_sha256, state, actor, started_at, ended_at, detail';

function rolloutAt(db: SwitchSql, driver: string, seq: number): StoreDriverRolloutRecord | undefined {
  const [row] = db.all(`SELECT ${ROLLOUT_COLUMNS} FROM store_driver_rollouts WHERE driver = ? AND seq = ?`, driver, seq) as unknown as RolloutRow[];
  return row ? rolloutOf(row) : undefined;
}

/** A stored release, or undefined. */
export function storeDriverReleaseIn(db: SwitchSql, driver: string, sha256: string): StoreDriverReleaseRecord | undefined {
  const [row] = db.all(
    'SELECT driver, sha256, source_commit, uploaded_by, uploaded_at FROM store_driver_releases WHERE driver = ? AND sha256 = ?',
    driver, sha256,
  ) as { driver: string; sha256: string; source_commit: string; uploaded_by: string; uploaded_at: string }[];
  return row
    ? { driver: row.driver, sha256: row.sha256, sourceCommit: row.source_commit, uploadedBy: row.uploaded_by, uploadedAt: row.uploaded_at }
    : undefined;
}

/**
 * Record that a release's bytes are stored. The same sha256 again is the same release, and the
 * row already written is returned as it stands (`created: false`). The same sha256 from another
 * commit is refused (`conflict`): one bundle has one source the reviewer reads.
 */
export function recordStoreDriverReleaseIn(
  db: SwitchSql,
  input: { driver: string; sha256: string; sourceCommit: string; actor: string; at: string },
): { record: StoreDriverReleaseRecord; created: boolean } {
  const held = storeDriverReleaseIn(db, input.driver, input.sha256);
  if (held) {
    if (held.sourceCommit !== input.sourceCommit) {
      throw substratError(
        'conflict',
        `release ${input.sha256} of '${input.driver}' is stored as built from ${held.sourceCommit}, not ${input.sourceCommit}`,
      );
    }
    return { record: held, created: false };
  }
  db.run(
    'INSERT INTO store_driver_releases (driver, sha256, source_commit, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?)',
    input.driver, input.sha256, input.sourceCommit, input.actor, input.at,
  );
  return { record: storeDriverReleaseIn(db, input.driver, input.sha256)!, created: true };
}

/**
 * The driver's current release, every rollout, and where a rollback goes now.
 *
 * With `nowMs`, a `rolling` row whose holder no longer holds the driver exclusively is reported as
 * `diverged` (read-time only, nothing is written): its holder stopped, and its scripts may be on
 * either release. The next rollout's begin writes that state.
 *
 * `rollbackTarget` is, in order:
 * - the target of a rollback that is the newest attempt since the current release, a `failed` one
 *   aside, and ended `paused` or `diverged` (`unfinishedRollback`): posting the rollback again
 *   continues it, and never turns it around onto the release it is leaving. A `failed` request
 *   changes nothing here: it moved nothing, or returned what its attempt moved, or (a later page's
 *   canary) moved nothing in its own request while earlier pages' verticals stay on the new
 *   release; those pages' `paused` rows are still since the current release, so the fleet still
 *   reads as mixed below. No rollout may begin while a
 *   rollback to an earlier release is unfinished, `paused` or `diverged` (`beginStoreDriverRolloutIn`):
 *   it is finished first, by posting it again. A rollback onto the current release (undoing a
 *   diverged rollout) does not block a rollout. A rollback to an earlier release cannot meet the
 *   schema rule (the route refuses one below the current schema), but one onto the current release
 *   can, and then it never finishes, so going forward must stay open;
 * - the current release itself, when a rollout since it ended `diverged` or `paused` on ANOTHER
 *   release: the fleet may be mixed, and undoing that rollout means converging every script back
 *   on the release it was healthy on, never going past it. A row that moves scripts to the current
 *   release itself (a re-post of it, paged over several requests, or a rollback onto it) leaves
 *   every script on the current release whatever it ended, so it never makes the fleet mixed:
 *   otherwise re-posting the current release past one request's walk would turn the rollback
 *   onto the release being escaped (#2312);
 * - otherwise the immediately previous good release.
 * An unfinished attempt never changes what "previous good" means.
 */
export function storeDriverStateIn(db: SwitchSql, driver: string, nowMs?: number): StoreDriverState {
  const live = nowMs === undefined
    ? undefined
    : new Set((db.all("SELECT holder FROM store_driver_holds WHERE driver = ? AND mode = 'exclusive' AND expires_at > ?", driver, nowMs) as { holder: string }[]).map((h) => h.holder));
  const rows = db.all(`SELECT ${ROLLOUT_COLUMNS}, holder FROM store_driver_rollouts WHERE driver = ? ORDER BY seq`, driver) as unknown as (RolloutRow & { holder: string | null })[];
  const rollouts = rows.map((r) =>
    live && r.state === 'rolling' && !(r.holder && live.has(r.holder))
      ? rolloutOf({ ...r, state: 'diverged', detail: 'its holder no longer holds the driver; the rollout stopped before it ended' })
      : rolloutOf(r),
  );
  const [current] = db.all('SELECT sha256, seq FROM store_driver_current WHERE driver = ?', driver) as { sha256: string; seq: number }[];
  if (!current) return { current: null, rollouts, rollbackTarget: null, unfinishedRollback: null };
  const seq = Number(current.seq);
  const row = rollouts.find((r) => r.seq === seq);
  const previousGoodSha256 = row?.previousGoodSha256 ?? null;
  const since = rollouts.filter((r) => r.seq > seq);
  // A failed request never decides what comes next (see above).
  const newest = since.filter((r) => r.state !== 'failed').at(-1);
  const unfinishedRollback = newest?.action === 'rollback' && (newest.state === 'paused' || newest.state === 'diverged') ? newest.sha256 : null;
  const mixed = since.some((r) => (r.state === 'diverged' || r.state === 'paused') && r.sha256 !== current.sha256);
  return {
    current: { sha256: current.sha256, seq, previousGoodSha256 },
    rollouts,
    rollbackTarget: unfinishedRollback ?? (mixed ? current.sha256 : previousGoodSha256),
    unfinishedRollback,
  };
}

/**
 * Take, or renew, a hold on a driver. Answers false when another holder's live hold excludes it: an
 * exclusive one for any request, or any one for an exclusive request. A lapsed hold is dropped
 * first. Asking in the other mode than the one held is refused.
 *
 * `renew` only extends a hold the holder still holds: a holder whose lease lapsed gets false, even
 * when nobody took the driver since, because a lapsed holder cannot know what happened meanwhile.
 * With `rolloutSeq` it also answers false unless that rollout is still `rolling`, so a rollout
 * whose row another holder ended stops instead of moving scripts the state no longer describes.
 */
export function holdStoreDriverIn(
  db: SwitchSql,
  input: { driver: string; holder: string; mode: StoreDriverHoldMode; nowMs: number; ttlMs: number; renew?: boolean; rolloutSeq?: number },
): boolean {
  if (!(input.ttlMs > 0)) throw substratError('validation_failed', 'a store-driver hold needs a positive lifetime');
  db.run('DELETE FROM store_driver_holds WHERE driver = ? AND expires_at <= ?', input.driver, input.nowMs);
  const live = db.all('SELECT holder, mode FROM store_driver_holds WHERE driver = ?', input.driver) as { holder: string; mode: StoreDriverHoldMode }[];
  const own = live.find((h) => h.holder === input.holder);
  if (own && own.mode !== input.mode) {
    throw substratError('conflict', `holder ${input.holder} holds '${input.driver}' ${own.mode}, not ${input.mode}`);
  }
  if ((input.renew || input.rolloutSeq !== undefined) && !own) return false;
  if (input.rolloutSeq !== undefined && rolloutAt(db, input.driver, input.rolloutSeq)?.state !== 'rolling') return false;
  const others = live.filter((h) => h.holder !== input.holder);
  if (input.mode === 'exclusive' ? others.length > 0 : others.some((h) => h.mode === 'exclusive')) return false;
  db.run(
    `INSERT INTO store_driver_holds (driver, holder, mode, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (driver, holder) DO UPDATE SET expires_at = excluded.expires_at`,
    input.driver, input.holder, input.mode, input.nowMs + input.ttlMs,
  );
  return true;
}
/** Drop a hold. Dropping one already gone is not an error. */
export function releaseStoreDriverHoldIn(db: SwitchSql, input: { driver: string; holder: string }): void {
  db.run('DELETE FROM store_driver_holds WHERE driver = ? AND holder = ?', input.driver, input.holder);
}

function assertExclusive(db: SwitchSql, driver: string, holder: string, nowMs: number): void {
  const [row] = db.all(
    "SELECT 1 AS held FROM store_driver_holds WHERE driver = ? AND holder = ? AND mode = 'exclusive' AND expires_at > ?",
    driver, holder, nowMs,
  );
  if (!row) throw substratError('conflict', `'${driver}' is not held exclusively by ${holder}`);
}

/**
 * Begin a rollout or a rollback of a stored release, as the exclusive holder. A rollout left
 * `rolling` by an earlier holder ends `diverged` here: its scripts may be on either release, and
 * this rollout reaches all of them. A rollback must name the current release's previous good one.
 */
export function beginStoreDriverRolloutIn(
  db: SwitchSql,
  input: { driver: string; sha256: string; action: StoreDriverRolloutAction; holder: string; actor: string; at: string; nowMs: number },
): StoreDriverRolloutRecord {
  assertExclusive(db, input.driver, input.holder, input.nowMs);
  if (!storeDriverReleaseIn(db, input.driver, input.sha256)) {
    throw substratError('not_found', `release ${input.sha256} of '${input.driver}' is not stored`);
  }
  db.run(
    `UPDATE store_driver_rollouts SET state = 'diverged', ended_at = ?, detail = 'its holder stopped before the rollout ended'
     WHERE driver = ? AND state = 'rolling'`,
    input.at, input.driver,
  );
  const { current, rollbackTarget, unfinishedRollback } = storeDriverStateIn(db, input.driver, input.nowMs);
  // A rollback under way to an earlier release blocks every rollout until it ends good. One onto
  // the current release (undoing a diverged rollout) does not: if a script refuses to go below its
  // schema, that rollback can never finish, and going forward is the way out.
  if (input.action === 'rollout' && unfinishedRollback && unfinishedRollback !== current?.sha256) {
    throw substratError(
      'conflict',
      `a rollback of '${input.driver}' to ${unfinishedRollback} is part way through; post the rollback again to finish it before any rollout`,
    );
  }
  let previousGood: string | null;
  if (input.action === 'rollback') {
    if (!current || !rollbackTarget) throw substratError('conflict', `'${input.driver}' has no previous good release to roll back to`);
    if (rollbackTarget !== input.sha256) {
      throw substratError('conflict', `a rollback of '${input.driver}' returns to ${rollbackTarget}, not ${input.sha256}`);
    }
    if (input.sha256 === current.sha256) {
      // Undoing a diverged rollout: back onto the current release, whose previous good stays.
      previousGood = current.previousGoodSha256;
    } else {
      const [made] = db.all(
        `SELECT previous_good_sha256 FROM store_driver_rollouts
         WHERE driver = ? AND sha256 = ? AND state = 'good' ORDER BY seq DESC LIMIT 1`,
        input.driver, input.sha256,
      ) as { previous_good_sha256: string | null }[];
      previousGood = made?.previous_good_sha256 ?? null;
    }
  } else {
    // Rolling out the current release again (a resume) keeps where a rollback from it returns to.
    previousGood = current ? (current.sha256 === input.sha256 ? current.previousGoodSha256 : current.sha256) : null;
  }
  const next = Number((db.all('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM store_driver_rollouts WHERE driver = ?', input.driver)[0] as { next: number }).next);
  db.run(
    `INSERT INTO store_driver_rollouts (${ROLLOUT_COLUMNS}, holder) VALUES (?, ?, ?, ?, ?, ?, 'rolling', ?, ?, NULL, NULL, ?)`,
    input.driver, next, input.sha256, input.action, current?.sha256 ?? null, previousGood, input.actor, input.at, input.holder,
  );
  return rolloutAt(db, input.driver, next)!;
}

/**
 * End a rollout the caller began, as the exclusive holder. A good one makes its release current.
 *
 * `walked` is what this request walked, and only a `paused` end takes it (#2312): it joins the
 * attempt's ledger in the transaction that writes the state, so a request that stops before its
 * end leaves no ledger rows, and the next attempt walks those verticals again rather than skip
 * them. What keeps a dead ledger unread is the attempt key (`attemptOf`); the deletes here keep the
 * table to the one attempt a driver can continue: any end drops every other attempt's rows, and any
 * end but `paused` this attempt's too.
 */
export function finishStoreDriverRolloutIn(
  db: SwitchSql,
  input: {
    driver: string;
    seq: number;
    holder: string;
    state: Exclude<StoreDriverRolloutState, 'rolling'>;
    detail: string | null;
    walked?: readonly StoreDriverRolloutTarget[];
    at: string;
    nowMs: number;
  },
): StoreDriverRolloutRecord {
  assertExclusive(db, input.driver, input.holder, input.nowMs);
  const row = rolloutAt(db, input.driver, input.seq);
  if (!row) throw substratError('not_found', `'${input.driver}' has no rollout ${input.seq}`);
  if (row.state !== 'rolling') throw substratError('conflict', `rollout ${input.seq} of '${input.driver}' already ended ${row.state}`);
  if (input.walked && input.state !== 'paused') {
    throw substratError('validation_failed', `only a paused rollout records what it walked; ${input.seq} of '${input.driver}' ends ${input.state}`);
  }
  db.run(
    'UPDATE store_driver_rollouts SET state = ?, ended_at = ?, detail = ? WHERE driver = ? AND seq = ?',
    input.state, input.at, input.detail, input.driver, input.seq,
  );
  const attempt = attemptOf(db, input.driver, input.seq, row.sha256, row.action);
  db.run(
    `DELETE FROM store_driver_rollout_walks WHERE driver = ?${input.state === 'paused' ? ' AND attempt <> ?' : ''}`,
    ...(input.state === 'paused' ? [input.driver, attempt] : [input.driver]),
  );
  if (input.state === 'paused') {
    for (const target of input.walked ?? []) {
      for (const store of target.stores) {
        db.run(
          `INSERT OR IGNORE INTO store_driver_rollout_walks (driver, attempt, vertical_slug, binding, first_version_id) VALUES (?, ?, ?, ?, ?)`,
          input.driver, attempt, target.vertical, store.binding, store.firstVersionId,
        );
      }
    }
  }
  if (input.state === 'good') {
    db.run(
      `INSERT INTO store_driver_current (driver, sha256, seq) VALUES (?, ?, ?)
       ON CONFLICT (driver) DO UPDATE SET sha256 = excluded.sha256, seq = excluded.seq`,
      input.driver, row.sha256, input.seq,
    );
  }
  return rolloutAt(db, input.driver, input.seq)!;
}

/** One vertical (or the driver's canary) the fleet rebuild could not rebuild, and why. */
export interface StoreDriverRebuildFailure {
  readonly vertical: string;
  readonly detail: string;
}

/** Where the platform's rebuild of every script of a driver stands (#2309). */
export interface StoreDriverRebuildRecord {
  readonly driver: string;
  /** What the platform builds every script from, as the walk converges every script on it. */
  readonly fingerprint: string;
  /** When a walk towards this fingerprint first began: about when the control plane building from it was deployed. */
  readonly fingerprintSince: string;
  /** The last vertical the walk reached, in slug order; null before the first. */
  readonly cursor: string | null;
  /** The verticals walked and not rebuilt. Retried on every pass until each is, or no longer declares the driver. */
  readonly failures: readonly StoreDriverRebuildFailure[];
  /** `done`: every vertical was walked and none failed. */
  readonly state: 'running' | 'done';
  /** When this walk began from its first script. */
  readonly startedAt: string;
  /** The person who attested, when this walk began, that no control-plane deploy was rolling out. */
  readonly attestedBy: string | null;
  /** When a walk towards this fingerprint last proved every script current; null before any. */
  readonly verifiedAt: string | null;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

interface RebuildRow {
  driver: string;
  fingerprint: string;
  fingerprint_since: string;
  cursor: string | null;
  failures: string;
  state: 'running' | 'done';
  holder: string | null;
  lease_expires_at: number;
  started_at: string;
  attested_by: string | null;
  verified_at: string | null;
  updated_at: string;
  finished_at: string | null;
}

const rebuildRowOf = (db: SwitchSql, driver: string): RebuildRow | undefined =>
  (db.all(
    'SELECT driver, fingerprint, fingerprint_since, cursor, failures, state, holder, lease_expires_at, started_at, attested_by, verified_at, updated_at, finished_at FROM store_driver_rebuilds WHERE driver = ?',
    driver,
  ) as unknown as RebuildRow[])[0];

const rebuildOf = (r: RebuildRow): StoreDriverRebuildRecord => ({
  driver: r.driver,
  fingerprint: r.fingerprint,
  fingerprintSince: r.fingerprint_since,
  cursor: r.cursor,
  failures: JSON.parse(r.failures) as StoreDriverRebuildFailure[],
  state: r.state,
  startedAt: r.started_at,
  attestedBy: r.attested_by,
  verifiedAt: r.verified_at,
  updatedAt: r.updated_at,
  finishedAt: r.finished_at,
});

/** The driver's fleet rebuild, or undefined before its first. */
export function storeDriverRebuildIn(db: SwitchSql, driver: string): StoreDriverRebuildRecord | undefined {
  const row = rebuildRowOf(db, driver);
  return row ? rebuildOf(row) : undefined;
}

/**
 * Take the lease on a driver's fleet rebuild, towards `fingerprint`, for `ttlMs`. Answers the
 * rebuild as it stands, or null while another holder's lease is live. A rebuild towards another
 * fingerprint (or none yet) starts over: no vertical is walked and none has failed, because every
 * script may have been built from something else than what the platform builds from now. With
 * `restart`, a rebuild already `done` at this fingerprint starts over too (a re-verification: a
 * script uploaded since by a control plane still building from older inputs is found and rebuilt).
 * With `attestedBy` (a person attesting no control-plane deploy is rolling out), the rebuild starts
 * over and the new walk carries the attestation, unless a walk this attestation (any person's, at
 * this fingerprint) already started is under way: that walk is continued, so repeating an attested
 * run finishes a fleet larger than one run. Any other start clears it.
 */
export function claimStoreDriverRebuildIn(
  db: SwitchSql,
  input: { driver: string; fingerprint: string; holder: string; nowMs: number; ttlMs: number; at: string; restart?: boolean; attestedBy?: string },
): StoreDriverRebuildRecord | null {
  if (!(input.ttlMs > 0)) throw substratError('validation_failed', 'a store-driver rebuild lease needs a positive lifetime');
  const row = rebuildRowOf(db, input.driver);
  if (row && row.holder !== null && row.holder !== input.holder && Number(row.lease_expires_at) > input.nowMs) return null;
  const lease = input.nowMs + input.ttlMs;
  // An attested walk under way at these lists is the attestation's own: continued, never restarted.
  const attestedUnderway = row?.fingerprint === input.fingerprint && row.state === 'running' && row.attested_by !== null;
  if (
    !row ||
    row.fingerprint !== input.fingerprint ||
    (input.restart && row.state === 'done') ||
    (input.attestedBy !== undefined && !attestedUnderway)
  ) {
    db.run(
      `INSERT INTO store_driver_rebuilds (driver, fingerprint, fingerprint_since, cursor, failures, state, holder, lease_expires_at, started_at, attested_by, verified_at, updated_at, finished_at)
       VALUES (?, ?, ?, NULL, '[]', 'running', ?, ?, ?, ?, NULL, ?, NULL)
       ON CONFLICT (driver) DO UPDATE SET fingerprint = excluded.fingerprint, cursor = NULL, failures = '[]', state = 'running',
         fingerprint_since = CASE WHEN store_driver_rebuilds.fingerprint = excluded.fingerprint
           THEN store_driver_rebuilds.fingerprint_since ELSE excluded.fingerprint_since END,
         verified_at = CASE WHEN store_driver_rebuilds.fingerprint = excluded.fingerprint
           THEN store_driver_rebuilds.verified_at ELSE NULL END,
         holder = excluded.holder, lease_expires_at = excluded.lease_expires_at, started_at = excluded.started_at,
         attested_by = excluded.attested_by, updated_at = excluded.updated_at, finished_at = NULL`,
      input.driver, input.fingerprint, input.at, input.holder, lease, input.at, input.attestedBy ?? null, input.at,
    );
  } else {
    db.run('UPDATE store_driver_rebuilds SET holder = ?, lease_expires_at = ? WHERE driver = ?', input.holder, lease, input.driver);
  }
  return rebuildOf(rebuildRowOf(db, input.driver)!);
}

/**
 * Record how far the lease holder's walk got, renewing the lease for `ttlMs`, or with `release`
 * dropping it. `done` ends the rebuild; it needs no failure left. Refused (`conflict`) unless the
 * caller is still the row's holder, towards `fingerprint`: once another pass claimed the row (a
 * lapsed lease) or restarted it (a new fingerprint), the old holder writes nothing. A holder whose
 * lease lapsed while nobody claimed the row still records what it did, which is then true. With
 * `verified` (only with `done`), the walk proved every script current, and `verifiedAt` is set.
 */
export function advanceStoreDriverRebuildIn(
  db: SwitchSql,
  input: {
    driver: string;
    fingerprint: string;
    holder: string;
    cursor: string | null;
    failures: readonly StoreDriverRebuildFailure[];
    done: boolean;
    verified?: boolean;
    nowMs: number;
    ttlMs: number;
    release?: boolean;
    at: string;
  },
): StoreDriverRebuildRecord {
  const row = rebuildRowOf(db, input.driver);
  if (!row || row.holder !== input.holder || row.fingerprint !== input.fingerprint) {
    throw substratError('conflict', `the rebuild of '${input.driver}' is not held by ${input.holder}`);
  }
  if (input.done && input.failures.length > 0) {
    throw substratError('validation_failed', `the rebuild of '${input.driver}' is not done while a vertical failed`);
  }
  if (input.verified && !input.done) {
    throw substratError('validation_failed', `the rebuild of '${input.driver}' proves nothing before it is done`);
  }
  db.run(
    `UPDATE store_driver_rebuilds SET cursor = ?, failures = ?, state = ?, holder = ?, lease_expires_at = ?, updated_at = ?, finished_at = ?,
       verified_at = COALESCE(?, verified_at)
     WHERE driver = ?`,
    input.cursor,
    JSON.stringify(input.failures),
    input.done ? 'done' : 'running',
    input.release ? null : input.holder,
    input.release ? 0 : input.nowMs + input.ttlMs,
    input.at,
    input.done ? input.at : null,
    input.verified ? input.at : null,
    input.driver,
  );
  return rebuildOf(rebuildRowOf(db, input.driver)!);
}

/**
 * One vertical's bindings of a driver as a rollout walks them (#2312). `firstVersionId` is the
 * version that first declared the binding: a vertical deleted and registered again under the
 * same slug declares it anew, under another id, so the ledger never counts the new one walked.
 */
export interface StoreDriverRolloutTarget {
  readonly vertical: string;
  readonly stores: readonly { readonly binding: string; readonly firstVersionId: string }[];
}

/**
 * The attempt the rollout at `seq` belongs to: the seq of the first row of the run of `paused`
 * rows of the same release and action just before it, or `seq` itself. Any other row between
 * (good, failed, diverged, a rolling one left by a holder that stopped, another release) ends the
 * run, so its ledger is never read: what it walked may since have been moved elsewhere.
 */
function attemptOf(db: SwitchSql, driver: string, seq: number, sha256: string, action: StoreDriverRolloutAction): number {
  const before = db.all(
    'SELECT seq, sha256, action, state FROM store_driver_rollouts WHERE driver = ? AND seq < ? ORDER BY seq DESC',
    driver, seq,
  ) as { seq: number; sha256: string; action: StoreDriverRolloutAction; state: StoreDriverRolloutState }[];
  let attempt = seq;
  for (const row of before) {
    if (row.state !== 'paused' || row.sha256 !== sha256 || row.action !== action) break;
    attempt = Number(row.seq);
  }
  return attempt;
}

interface DeclarationRow {
  vertical_slug: string;
  binding: string;
  first_version_id: string;
}

/** Rows in (vertical, binding) order, grouped by vertical. */
function targetsOf(rows: readonly DeclarationRow[]): StoreDriverRolloutTarget[] {
  const byVertical = new Map<string, { binding: string; firstVersionId: string }[]>();
  for (const r of rows) {
    const stores = byVertical.get(r.vertical_slug) ?? [];
    stores.push({ binding: r.binding, firstVersionId: r.first_version_id });
    byVertical.set(r.vertical_slug, stores);
  }
  return [...byVertical].map(([vertical, stores]) => ({ vertical, stores }));
}

const assertLimit = (limit: number) => {
  if (!(Number.isInteger(limit) && limit > 0)) throw substratError('validation_failed', 'a rollout page needs a positive limit');
};

/** A declaration the attempt walked: the ledger row of the same vertical, binding and first version. */
const WALKED = `EXISTS (SELECT 1 FROM store_driver_rollout_walks AS w
  WHERE w.driver = s.driver AND w.attempt = ? AND w.vertical_slug = s.vertical_slug
    AND w.binding = s.binding AND w.first_version_id = s.first_version_id)`;

/**
 * What the next request of a rollout of `sha256` (or a rollback to it) walks (#2312): the first
 * `limit` verticals, in (vertical, binding) order, with a declaration of the driver that the attempt
 * it would continue has not walked, and how many verticals are pending in all. Asked before the
 * request's row begins, as the exclusive holder will begin it: a request that continues no attempt
 * walks every declaration. `walked` counts the verticals the continued attempt walked that still
 * declare the driver. `unreadable` is `driverDeclarationsOf`'s: a caller that must reach every script
 * refuses while it is not empty.
 */
export function storeDriverRolloutPendingIn(
  db: SwitchSql,
  input: { driver: string; sha256: string; action: StoreDriverRolloutAction; limit: number },
): { verticals: StoreDriverRolloutTarget[]; pending: number; walked: number; unreadable: string[] } {
  assertLimit(input.limit);
  // Indexes every vertical not indexed yet, and names the ones that cannot say what they declare.
  const { unreadable } = driverDeclarationsOf(db, input.driver);
  const next = Number((db.all('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM store_driver_rollouts WHERE driver = ?', input.driver)[0] as { next: number }).next);
  const attempt = attemptOf(db, input.driver, next, input.sha256, input.action);
  const rows = db.all(
    `SELECT s.vertical_slug, s.binding, s.first_version_id, ${WALKED} AS walked
       FROM vertical_scope_stores AS s WHERE s.driver = ? ORDER BY s.vertical_slug, s.binding`,
    attempt, input.driver,
  ) as unknown as (DeclarationRow & { walked: number })[];
  const pending = targetsOf(rows.filter((r) => !r.walked));
  const walked = new Set(rows.filter((r) => r.walked).map((r) => r.vertical_slug)).size;
  return { verticals: pending.slice(0, input.limit), pending: pending.length, walked, unreadable };
}

/**
 * What the attempt of the rollout at `seq` walked in its EARLIER requests and still declares the
 * driver, in (vertical, binding) order: the verticals a failure part way returns, besides the ones
 * its own request reached (#2312). At most `limit`, and `walked` counts them all.
 */
export function storeDriverRolloutWalkedIn(
  db: SwitchSql,
  input: { driver: string; seq: number; limit: number },
): { verticals: StoreDriverRolloutTarget[]; walked: number } {
  assertLimit(input.limit);
  const row = rolloutAt(db, input.driver, input.seq);
  if (!row) throw substratError('not_found', `'${input.driver}' has no rollout ${input.seq}`);
  const attempt = attemptOf(db, input.driver, input.seq, row.sha256, row.action);
  const walked = targetsOf(db.all(
    `SELECT s.vertical_slug, s.binding, s.first_version_id FROM vertical_scope_stores AS s
      WHERE s.driver = ? AND ${WALKED} ORDER BY s.vertical_slug, s.binding`,
    input.driver, attempt,
  ) as unknown as DeclarationRow[]);
  return { verticals: walked.slice(0, input.limit), walked: walked.length };
}
