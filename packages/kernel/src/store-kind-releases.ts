/**
 * A store kind's releases, its rollouts and the holds that serialize them (D-63, #2300), shared by
 * both adapters' directories.
 *
 * - `store_kind_releases`: a release's bytes were stored (the bytes themselves live outside the
 *   directory, keyed by kind and sha256). Insert-only: who uploaded a release, and from which
 *   commit, is never rewritten.
 * - `store_kind_rollouts`: one row per attempt to move every script of the kind to a release, in
 *   `seq` order. A row is `rolling` until its holder ends it `good`, `failed` or `diverged`.
 * - `store_kind_current`: the release the last `good` rollout moved every script to.
 *
 * "The immediately previous good release" (D-63) is recorded, never derived from an ordering:
 * each rollout row names `previous_good_sha256`, the release a rollback from it returns to. A
 * rollout of T from current F records F; a rollback goes to the current row's previous good X, and
 * records X's own previous good, so after r1 → r2 → r3 one rollback reaches r2 and the next r1.
 *
 * A hold is a lease: `exclusive` for a rollout or a rollback, `shared` for a push or serve that
 * rebuilds a script at the release it runs, which a rollout must not interleave with (a rebuild
 * that read the old release and uploaded after the rollout moved the script would revert it).
 * A begin or finish is refused unless the caller still holds the kind exclusively, so a holder
 * whose lease lapsed cannot write over the next one; its `rolling` row reads as `diverged` to the
 * next rollout, which converges every script again.
 */
import { substratError } from '@substrat-run/contracts';
import type { SwitchSql } from './system-switch.js';

/** Interpolated into both adapters' directory DDL, so `lint:spine-ddl` sees one spelling on each side. */
export const STORE_KIND_RELEASES_DDL = `
  CREATE TABLE IF NOT EXISTS store_kind_releases (
    kind          TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    source_commit TEXT NOT NULL,
    uploaded_by   TEXT NOT NULL,
    uploaded_at   TEXT NOT NULL,
    PRIMARY KEY (kind, sha256)
  );
  CREATE TABLE IF NOT EXISTS store_kind_rollouts (
    kind                 TEXT NOT NULL,
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
    PRIMARY KEY (kind, seq)
  );
  CREATE TABLE IF NOT EXISTS store_kind_current (
    kind   TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    seq    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS store_kind_holds (
    kind       TEXT NOT NULL,
    holder     TEXT NOT NULL,
    mode       TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (kind, holder)
  );
`;

/** A stored release: its bytes are kept elsewhere under `<kind>/<sha256>`. */
export interface StoreKindReleaseRecord {
  readonly kind: string;
  readonly sha256: string;
  readonly sourceCommit: string;
  readonly uploadedBy: string;
  readonly uploadedAt: string;
}

export type StoreKindRolloutAction = 'rollout' | 'rollback';
export type StoreKindRolloutState = 'rolling' | 'good' | 'failed' | 'diverged';

export interface StoreKindRolloutRecord {
  readonly kind: string;
  readonly seq: number;
  readonly sha256: string;
  readonly action: StoreKindRolloutAction;
  /** The current good release when the rollout began; null for a kind's first. */
  readonly fromSha256: string | null;
  /** Where a rollback from this release, once it is good, returns to; null when nowhere. */
  readonly previousGoodSha256: string | null;
  readonly state: StoreKindRolloutState;
  readonly actor: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly detail: string | null;
}

export interface StoreKindState {
  /** The release the last good rollout reached, and that rollout. Null before any. */
  readonly current: { readonly sha256: string; readonly seq: number; readonly previousGoodSha256: string | null } | null;
  /** Every rollout, oldest first. */
  readonly rollouts: StoreKindRolloutRecord[];
  /** Where a rollback goes now (see `storeKindStateIn`); null when nowhere. */
  readonly rollbackTarget: string | null;
}

export type StoreKindHoldMode = 'shared' | 'exclusive';

interface RolloutRow {
  kind: string;
  seq: number;
  sha256: string;
  action: StoreKindRolloutAction;
  from_sha256: string | null;
  previous_good_sha256: string | null;
  state: StoreKindRolloutState;
  actor: string;
  started_at: string;
  ended_at: string | null;
  detail: string | null;
}

const rolloutOf = (r: RolloutRow): StoreKindRolloutRecord => ({
  kind: r.kind,
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
  'kind, seq, sha256, action, from_sha256, previous_good_sha256, state, actor, started_at, ended_at, detail';

function rolloutAt(db: SwitchSql, kind: string, seq: number): StoreKindRolloutRecord | undefined {
  const [row] = db.all(`SELECT ${ROLLOUT_COLUMNS} FROM store_kind_rollouts WHERE kind = ? AND seq = ?`, kind, seq) as unknown as RolloutRow[];
  return row ? rolloutOf(row) : undefined;
}

/** A stored release, or undefined. */
export function storeKindReleaseIn(db: SwitchSql, kind: string, sha256: string): StoreKindReleaseRecord | undefined {
  const [row] = db.all(
    'SELECT kind, sha256, source_commit, uploaded_by, uploaded_at FROM store_kind_releases WHERE kind = ? AND sha256 = ?',
    kind, sha256,
  ) as { kind: string; sha256: string; source_commit: string; uploaded_by: string; uploaded_at: string }[];
  return row
    ? { kind: row.kind, sha256: row.sha256, sourceCommit: row.source_commit, uploadedBy: row.uploaded_by, uploadedAt: row.uploaded_at }
    : undefined;
}

/**
 * Record that a release's bytes are stored. The same sha256 again is the same release, and the
 * row already written is returned as it stands (`created: false`). The same sha256 from another
 * commit is refused (`conflict`): one bundle has one source the reviewer reads.
 */
export function recordStoreKindReleaseIn(
  db: SwitchSql,
  input: { kind: string; sha256: string; sourceCommit: string; actor: string; at: string },
): { record: StoreKindReleaseRecord; created: boolean } {
  const held = storeKindReleaseIn(db, input.kind, input.sha256);
  if (held) {
    if (held.sourceCommit !== input.sourceCommit) {
      throw substratError(
        'conflict',
        `release ${input.sha256} of '${input.kind}' is stored as built from ${held.sourceCommit}, not ${input.sourceCommit}`,
      );
    }
    return { record: held, created: false };
  }
  db.run(
    'INSERT INTO store_kind_releases (kind, sha256, source_commit, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?)',
    input.kind, input.sha256, input.sourceCommit, input.actor, input.at,
  );
  return { record: storeKindReleaseIn(db, input.kind, input.sha256)!, created: true };
}

/**
 * The kind's current release, every rollout, and where a rollback goes now.
 *
 * With `nowMs`, a `rolling` row whose holder no longer holds the kind exclusively is reported as
 * `diverged` (read-time only, nothing is written): its holder stopped, and its scripts may be on
 * either release. The next rollout's begin writes that state.
 *
 * `rollbackTarget` is the immediately previous good release, or, when a rollout since the current
 * one ended `diverged`, the current release itself: then the fleet may be mixed, and undoing the
 * bad rollout means converging every script back on the release it was healthy on, never going
 * past it. A diverged rollout never changes what "previous good" means.
 */
export function storeKindStateIn(db: SwitchSql, kind: string, nowMs?: number): StoreKindState {
  const live = nowMs === undefined
    ? undefined
    : new Set((db.all("SELECT holder FROM store_kind_holds WHERE kind = ? AND mode = 'exclusive' AND expires_at > ?", kind, nowMs) as { holder: string }[]).map((h) => h.holder));
  const rows = db.all(`SELECT ${ROLLOUT_COLUMNS}, holder FROM store_kind_rollouts WHERE kind = ? ORDER BY seq`, kind) as unknown as (RolloutRow & { holder: string | null })[];
  const rollouts = rows.map((r) =>
    live && r.state === 'rolling' && !(r.holder && live.has(r.holder))
      ? rolloutOf({ ...r, state: 'diverged', detail: 'its holder no longer holds the kind; the rollout stopped before it ended' })
      : rolloutOf(r),
  );
  const [current] = db.all('SELECT sha256, seq FROM store_kind_current WHERE kind = ?', kind) as { sha256: string; seq: number }[];
  if (!current) return { current: null, rollouts, rollbackTarget: null };
  const seq = Number(current.seq);
  const row = rollouts.find((r) => r.seq === seq);
  const previousGoodSha256 = row?.previousGoodSha256 ?? null;
  const mixed = rollouts.some((r) => r.seq > seq && r.state === 'diverged');
  return {
    current: { sha256: current.sha256, seq, previousGoodSha256 },
    rollouts,
    rollbackTarget: mixed ? current.sha256 : previousGoodSha256,
  };
}

/**
 * Take, or renew, a hold on a kind. Answers false when another holder's live hold excludes it: an
 * exclusive one for any request, or any one for an exclusive request. A lapsed hold is dropped
 * first. Asking in the other mode than the one held is refused.
 *
 * `renew` only extends a hold the holder still holds: a holder whose lease lapsed gets false, even
 * when nobody took the kind since, because a lapsed holder cannot know what happened meanwhile.
 * With `rolloutSeq` it also answers false unless that rollout is still `rolling`, so a rollout
 * whose row another holder ended stops instead of moving scripts the state no longer describes.
 */
export function holdStoreKindIn(
  db: SwitchSql,
  input: { kind: string; holder: string; mode: StoreKindHoldMode; nowMs: number; ttlMs: number; renew?: boolean; rolloutSeq?: number },
): boolean {
  if (!(input.ttlMs > 0)) throw substratError('validation_failed', 'a store-kind hold needs a positive lifetime');
  db.run('DELETE FROM store_kind_holds WHERE kind = ? AND expires_at <= ?', input.kind, input.nowMs);
  const live = db.all('SELECT holder, mode FROM store_kind_holds WHERE kind = ?', input.kind) as { holder: string; mode: StoreKindHoldMode }[];
  const own = live.find((h) => h.holder === input.holder);
  if (own && own.mode !== input.mode) {
    throw substratError('conflict', `holder ${input.holder} holds '${input.kind}' ${own.mode}, not ${input.mode}`);
  }
  if ((input.renew || input.rolloutSeq !== undefined) && !own) return false;
  if (input.rolloutSeq !== undefined && rolloutAt(db, input.kind, input.rolloutSeq)?.state !== 'rolling') return false;
  const others = live.filter((h) => h.holder !== input.holder);
  if (input.mode === 'exclusive' ? others.length > 0 : others.some((h) => h.mode === 'exclusive')) return false;
  db.run(
    `INSERT INTO store_kind_holds (kind, holder, mode, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (kind, holder) DO UPDATE SET expires_at = excluded.expires_at`,
    input.kind, input.holder, input.mode, input.nowMs + input.ttlMs,
  );
  return true;
}
/** Drop a hold. Dropping one already gone is not an error. */
export function releaseStoreKindHoldIn(db: SwitchSql, input: { kind: string; holder: string }): void {
  db.run('DELETE FROM store_kind_holds WHERE kind = ? AND holder = ?', input.kind, input.holder);
}

function assertExclusive(db: SwitchSql, kind: string, holder: string, nowMs: number): void {
  const [row] = db.all(
    "SELECT 1 AS held FROM store_kind_holds WHERE kind = ? AND holder = ? AND mode = 'exclusive' AND expires_at > ?",
    kind, holder, nowMs,
  );
  if (!row) throw substratError('conflict', `'${kind}' is not held exclusively by ${holder}`);
}

/**
 * Begin a rollout or a rollback of a stored release, as the exclusive holder. A rollout left
 * `rolling` by an earlier holder ends `diverged` here: its scripts may be on either release, and
 * this rollout reaches all of them. A rollback must name the current release's previous good one.
 */
export function beginStoreKindRolloutIn(
  db: SwitchSql,
  input: { kind: string; sha256: string; action: StoreKindRolloutAction; holder: string; actor: string; at: string; nowMs: number },
): StoreKindRolloutRecord {
  assertExclusive(db, input.kind, input.holder, input.nowMs);
  if (!storeKindReleaseIn(db, input.kind, input.sha256)) {
    throw substratError('not_found', `release ${input.sha256} of '${input.kind}' is not stored`);
  }
  db.run(
    `UPDATE store_kind_rollouts SET state = 'diverged', ended_at = ?, detail = 'its holder stopped before the rollout ended'
     WHERE kind = ? AND state = 'rolling'`,
    input.at, input.kind,
  );
  const { current, rollbackTarget } = storeKindStateIn(db, input.kind, input.nowMs);
  let previousGood: string | null;
  if (input.action === 'rollback') {
    if (!current || !rollbackTarget) throw substratError('conflict', `'${input.kind}' has no previous good release to roll back to`);
    if (rollbackTarget !== input.sha256) {
      throw substratError('conflict', `a rollback of '${input.kind}' returns to ${rollbackTarget}, not ${input.sha256}`);
    }
    if (input.sha256 === current.sha256) {
      // Undoing a diverged rollout: back onto the current release, whose previous good stays.
      previousGood = current.previousGoodSha256;
    } else {
      const [made] = db.all(
        `SELECT previous_good_sha256 FROM store_kind_rollouts
         WHERE kind = ? AND sha256 = ? AND state = 'good' ORDER BY seq DESC LIMIT 1`,
        input.kind, input.sha256,
      ) as { previous_good_sha256: string | null }[];
      previousGood = made?.previous_good_sha256 ?? null;
    }
  } else {
    // Rolling out the current release again (a resume) keeps where a rollback from it returns to.
    previousGood = current ? (current.sha256 === input.sha256 ? current.previousGoodSha256 : current.sha256) : null;
  }
  const next = Number((db.all('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM store_kind_rollouts WHERE kind = ?', input.kind)[0] as { next: number }).next);
  db.run(
    `INSERT INTO store_kind_rollouts (${ROLLOUT_COLUMNS}, holder) VALUES (?, ?, ?, ?, ?, ?, 'rolling', ?, ?, NULL, NULL, ?)`,
    input.kind, next, input.sha256, input.action, current?.sha256 ?? null, previousGood, input.actor, input.at, input.holder,
  );
  return rolloutAt(db, input.kind, next)!;
}

/** End a rollout the caller began, as the exclusive holder. A good one makes its release current. */
export function finishStoreKindRolloutIn(
  db: SwitchSql,
  input: { kind: string; seq: number; holder: string; state: Exclude<StoreKindRolloutState, 'rolling'>; detail: string | null; at: string; nowMs: number },
): StoreKindRolloutRecord {
  assertExclusive(db, input.kind, input.holder, input.nowMs);
  const row = rolloutAt(db, input.kind, input.seq);
  if (!row) throw substratError('not_found', `'${input.kind}' has no rollout ${input.seq}`);
  if (row.state !== 'rolling') throw substratError('conflict', `rollout ${input.seq} of '${input.kind}' already ended ${row.state}`);
  db.run(
    'UPDATE store_kind_rollouts SET state = ?, ended_at = ?, detail = ? WHERE kind = ? AND seq = ?',
    input.state, input.at, input.detail, input.kind, input.seq,
  );
  if (input.state === 'good') {
    db.run(
      `INSERT INTO store_kind_current (kind, sha256, seq) VALUES (?, ?, ?)
       ON CONFLICT (kind) DO UPDATE SET sha256 = excluded.sha256, seq = excluded.seq`,
      input.kind, row.sha256, input.seq,
    );
  }
  return rolloutAt(db, input.kind, input.seq)!;
}
