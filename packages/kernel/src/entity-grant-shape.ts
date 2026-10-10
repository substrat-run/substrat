import {
  ENTITY_GRANTS_RETIRED,
  ENTITY_GRANTS_TOPPED_UP,
  ENTITY_SHAPE_MARKER_RELATION,
  domainEvent,
  entityGrantsRetiredPayload,
  entityGrantsToppedUpPayload,
  entityObjectRef,
  eventId,
  type DomainEvent,
  type EntityGrantShape,
  type EntityRef,
  type PrincipalId,
} from '@substrat-run/contracts';
import { assertKernelAuthoredType, substratError } from '@substrat-run/contracts';
import { KERNEL_ACTOR, kernelOutboxInsertSql } from './kernel-outbox.js';
import { GRANTEE_KEY_RELATION, explicitTupleSql } from './entity-grant.js';
import { liveTupleSql } from './permission-eval.js';
import { assertSqlIdentifier } from './sql-identifier.js';
import type { SwitchSql } from './system-switch.js';

/**
 * A declared entity-grant SHAPE, reconciled (#2071).
 *
 * A vertical declares the keys a person is given on their own record (`ENTITY_GRANTS`:
 * meridian's `EMPLOYEE_SELF` on `employee`, todo's owner grant on `owner`). They used to be
 * minted key by key, once, when the person arrived, so a key added to the shape by a later
 * release reached only the people who arrived after it, while `PERMISSIONS.md` said everyone
 * held it.
 *
 * Three pieces, each one statement shared by both adapters:
 *
 * - {@link grantEntityShapeIn}: the grant. The shape's keys plus a MARKER tuple
 *   (`ENTITY_SHAPE_MARKER_RELATION`) on the same entity. The marker is what makes a person a
 *   holder of the shape, which no set of keys can: someone `ctx.grant`ed one of those keys
 *   holds part of the shape and must never be topped up to all of it.
 * - {@link topUpEntityGrantShapes}: one bounded pass of the reconcile, writing each top-up's
 *   `entity.grants-topped-up` event beside it. Each live marker whose
 *   entity lacks a key of the CURRENT shape gets that key. A key with any row at all is
 *   skipped, and that includes a tombstone (K-21): a key someone took back from that person
 *   stays taken back. A key merely dropped from the shape is left where it is, because silently
 *   revoking authority on a deploy is the riskier mistake.
 * - The retirement (#2082), in the same pass and budget, between the backfill and the top-up: a
 *   key the shape declares `retired` is tombstoned for every live marker that still holds it
 *   live, with one `entity.grants-retired` event per (person, entity). The tombstones are the
 *   progress; a record tuple (`shape:<type>`, `shape-retired:<key>`, `scope:<id>`) ends it once
 *   a batch comes back short, so a key granted to a holder again afterwards is left alone. A key
 *   back in the shape's `permissions` tombstones that record, so a later release may retire it
 *   again. One tuple is one authority: a direct grant of the key on the same entity to the same
 *   person is that row, and goes with it.
 * - The backfill, inside the same budget, until it is done once per (scope, entity type): how
 *   people granted before markers existed become holders. For own-record holders it reads
 *   provenance, never key sets alone.
 *   The shape's declared `holder` says whose record each entity is (`'self'`: the entity id is
 *   the principal; a table column naming the principal), and a person is marked only on their
 *   own record, and only when they hold a row there (live or tombstoned) for some key of the
 *   shape — evidence they were given it. Someone `ctx.grant`ed even the whole shape on another
 *   person's record is never marked. A shape with no `holder` gets no backfill. Each batch marks
 *   at most what the pass's budget allows; the markers are the progress, since a marked pair is
 *   no longer a candidate, and a record tuple (`shape:<type>`, `shape-backfilled`, `scope:<id>`)
 *   ends it once a batch comes back short.
 * - `holder: 'grantee'` (#2083), for a record that names no principal (a portal customer, a
 *   contact): whoever holds a live current or retired key of the shape on such an entity was given it.
 *   Each pass records current and retired keys (`shape-grantee-key`), and the explicit tuple
 *   writer makes non-shape grants refuse them on that entity type. A tuple from before the
 *   first such pass cannot be told apart. A marker already written by a shape grant persists
 *   through retirement, so its holder receives the new keys even if their old key was K alone.
 *
 * Only a shape declared `bootstrap: true` is reconciled: one a person is GIVEN on their own
 * record. A sharing shape, which people reach through `ctx.grant` (todo's `list`), is skipped
 * whole, backfill included, so a sharee is never marked a holder.
 */

/**
 * The index every marker walk reads (#2083): markers only, in `(object, subject)` order, so one
 * shape's markers are one range (`<type>:` up to `<type>;`) and a pass's cursor is a seek into
 * it. Without it a pass scanned the whole `_substrat_tuples` table, even when it had nothing to
 * do. Partial, so it costs a row per marker and nothing for any other tuple. SQLite uses a
 * partial index only where it can prove the index's WHERE from the query's, so the walks write the
 * relation as this same literal: proved from the text alone, with no dependence on SQLite
 * re-planning once a parameter is bound. In KERNEL_DDL on both adapters, which every wake re-runs,
 * so an existing scope builds it on its next wake.
 */
export const SHAPE_MARKER_INDEX_DDL = `CREATE INDEX IF NOT EXISTS _substrat_tuples_shape_marker ON _substrat_tuples (object, subject) WHERE relation = '${ENTITY_SHAPE_MARKER_RELATION}'`;

/** Holders topped up per pass — one transaction each, so a large scope never holds one long. */
export const SHAPE_TOP_UP_BATCH = 500;
/**
 * Markers a pass may READ, per row of work it may write. The budget bounds writes, but finding
 * the holders who need one means reading past the ones who do not, and on a scope where nobody
 * does (the common reconcile: nothing changed) that is every marker. Ten per row keeps a pass at
 * 5000 index rows by default, short on any scope, while a rollout still spends most of each pass
 * writing. A pass that reads its window without filling its budget hands back a cursor, and the
 * next pass reads on from there.
 */
export const SHAPE_MARKER_READS_PER_ROW = 10;
/** The largest batch a caller may ask for: past this a pass is the long transaction it exists to avoid. */
export const SHAPE_TOP_UP_BATCH_MAX = 5000;

/** `batch`, or `validation_failed`: a pass size is a positive integer no larger than the max. */
export function shapeTopUpBatch(batch: number = SHAPE_TOP_UP_BATCH): number {
  if (!Number.isInteger(batch) || batch < 1 || batch > SHAPE_TOP_UP_BATCH_MAX) {
    throw substratError(
      'validation_failed',
      `reconcileEntityGrantShapes: batch must be an integer from 1 to ${SHAPE_TOP_UP_BATCH_MAX}, not ${batch}`,
      { errors: [{ path: 'batch', message: `an integer from 1 to ${SHAPE_TOP_UP_BATCH_MAX}` }] },
    );
  }
  return batch;
}

/** The backfill's run-once record: `(shape:<type>, backfilled, scope:<id>)`. */
const BACKFILLED_RELATION = 'shape-backfilled';
/** A retirement's run-once record, per key: `(shape:<type>, shape-retired:<key>, scope:<id>)`. */
const RETIRED_RELATION = 'shape-retired:';

/** The subject and object of a shape's run-once records on one scope. */
const recordRefs = (entityType: string, scopeId: string) => [`shape:${entityType}`, `scope:${scopeId}`] as const;

/** The writer of the top-up events: the kernel, as no module or person acted. */


const PRINCIPAL = 'principal:';

const keysOf = (permissions: readonly string[]): string[] => [...new Set(permissions)].sort();

/**
 * Every object of one entity type, as an index range: `prefix` is `<type>:`, and `;` is the byte
 * after `:`. A range, not `substr(object, …) = ?`, so an index leading with `object` can seek it.
 */
const typeRange = (prefix: string): [string, string] => [prefix, `${prefix.slice(0, -1)};`];

/**
 * The shape's grant to one person on one entity: the marker and every key, each an explicit
 * write, so a re-grant brings back what a revoke tombstoned — as `ctx.grant` does.
 * `entityObjectRef` refuses a ref the walk could not read back (#1856). Run it in ONE
 * transaction, so the marker and its keys land together or not at all.
 */
export function grantEntityShapeIn(db: SwitchSql, principal: PrincipalId, entity: EntityRef, permissions: readonly string[]): void {
  const object = entityObjectRef(entity, 'grantEntityShape');
  const subject = `${PRINCIPAL}${principal}`;
  for (const st of [
    explicitTupleSql(subject, ENTITY_SHAPE_MARKER_RELATION, object),
    ...keysOf(permissions).map((p) => explicitTupleSql(subject, `granted:${p}`, object)),
  ]) {
    db.run(st.sql, ...st.params);
  }
}

/**
 * Where a pass stopped, so the next pass of the same reconcile starts there instead of at the
 * first marker (#2083): the shape (its index in `shapes`), the step of it, and for a marker walk
 * the last marker it read. Without it every pass re-read the holders earlier passes had already
 * finished, and a rollout cost passes × markers.
 *
 * Skipping what lies behind it is safe because a walk leaves every marker it passes finished:
 * topped up (each key now has a row) or with its retired keys tombstoned. A marker written behind
 * it mid-run is complete when a shape grant writes it, and the backfill finishes before its
 * shape's walks begin. The one exception: a shape grant by an OLDER deployment, carrying the
 * shape before it grew, landing behind the cursor while the reconcile runs. That holder is caught
 * at the next reconcile, the same as a grant landing just after this one finished.
 */
export interface ShapeCursor {
  shape: number;
  step: 'backfill' | 'retire' | 'topUp';
  /** The last marker a walk read; `null` resumes the step from its start. */
  after: { object: string; subject: string } | null;
}

/** Where a pass runs and how its events are stamped — the facts only the adapter holds. */
export interface ShapePass {
  tenantId: string;
  scopeId: string;
  shapes: readonly EntityGrantShape[];
  /** The pass's one instant: marker liveness and every event's `occurredAt`. */
  now: string;
  /** Rows of work at most: a backfill mark or a holder topped up each count one. */
  limit: number;
  /** The previous pass's `next`; absent or `null` starts the reconcile from the beginning. */
  after?: ShapeCursor | null;
  /** The adapter's monotonic event-id mint, given the instant in ms. */
  mintEventId: (ms: number) => string;
  /** The deploy writing the events, for the outbox `version` column. */
  version: string | null;
}

const STEPS = ['backfill', 'retire', 'topUp'] as const;

/**
 * One pass of the reconcile over one scope, at most `limit` rows of work and
 * `limit × SHAPE_MARKER_READS_PER_ROW` markers read: backfill marks for any shape whose backfill
 * is not done here, then holders whose retired keys are taken back, each with its
 * `entity.grants-retired` event, then holders topped up, each with its `entity.grants-topped-up`
 * event. `next` is `null` once the scope is done; otherwise the caller runs another pass with it
 * as `after`. Run it inside ONE transaction, so the keys and their events commit together.
 * Re-running a finished scope writes nothing.
 */
export function topUpEntityGrantShapes(
  db: SwitchSql,
  pass: ShapePass,
): { toppedUp: number; retired: number; next: ShapeCursor | null } {
  // Here as well as at each entry point: a pass with no budget never reports done, so a caller
  // looping until it does would never stop.
  const limit = shapeTopUpBatch(pass.limit);
  const room = { writes: limit, reads: limit * SHAPE_MARKER_READS_PER_ROW };
  recordGranteeKeys(db, pass.shapes);
  let toppedUp = 0;
  let retired = 0;
  const from = pass.after ?? null;
  for (let i = from?.shape ?? 0; i < pass.shapes.length; i++) {
    const shape = pass.shapes[i]!;
    // A sharing shape is never reconciled — not topped up, not backfilled, nothing retired.
    if (!shape.bootstrap) continue;
    const keys = keysOf(shape.permissions);
    // A key the shape grants is never taken back, whatever the declaration says.
    const gone = keysOf(shape.retired ?? []).filter((k) => !keys.includes(k));
    if (keys.length === 0 && gone.length === 0) continue;
    const resume = from?.shape === i ? from : null;
    const first = resume ? STEPS.indexOf(resume.step) : 0;
    const after = (step: ShapeCursor['step']) => (resume?.step === step ? resume.after : null);
    const stop = (step: ShapeCursor['step'], at: ShapeCursor['after']) => ({ toppedUp, retired, next: { shape: i, step, after: at } });
    const prefix = `${shape.entityType}:`;
    if (first <= 0) {
      // A live retired key still identifies a legacy holder so this pass can retire it.
      // The grantee query excludes tombstoned tuples.
      room.writes -= backfill(db, pass, shape, prefix, JSON.stringify([...keys, ...gone]), room.writes);
      if (room.writes === 0) return stop('backfill', null);
    }
    if (first <= 1) {
      reopenRetirements(db, pass, shape.entityType, keys);
      const took = retire(db, pass, shape.entityType, prefix, gone, after('retire'), room);
      retired += took.holders;
      if (took.walk && !took.walk.done) return stop('retire', took.walk.at);
    }
    if (keys.length === 0) continue;
    const gave = topUp(db, pass, shape.entityType, prefix, keys, after('topUp'), room);
    toppedUp += gave.holders;
    if (gave.walk && !gave.walk.done) return stop('topUp', gave.walk.at);
  }
  return { toppedUp, retired, next: null };
}

/** What a pass may still spend: rows of work it may write, and markers it may read. */
interface Room {
  writes: number;
  reads: number;
}

/** Where a marker walk stopped: `done` once it read the shape's last marker, else the last one it read. */
interface Walk {
  found: { subject: string; object: string }[];
  done: boolean;
  at: ShapeCursor['after'];
}

/**
 * The live markers of one shape after `after`, in index order, that are `wanted` (a SQL predicate
 * on the marker `m`, binding one parameter: `json`), as many as `room` allows. Spends one read per marker
 * read and one write per marker found.
 */
function walkMarkers(
  db: SwitchSql,
  pass: ShapePass,
  prefix: string,
  after: ShapeCursor['after'],
  room: Room,
  wanted: string,
  json: string,
): Walk {
  if (room.writes === 0 || room.reads === 0) return { found: [], done: false, at: after };
  const [, end] = typeRange(prefix);
  const window = room.reads;
  const rows = db.all(
    `SELECT m.object, m.subject,
            (substr(m.subject, 1, ${PRINCIPAL.length}) = '${PRINCIPAL}' AND ${liveTupleSql('m')} AND ${wanted}) AS hit
       FROM _substrat_tuples m
      WHERE m.relation = '${ENTITY_SHAPE_MARKER_RELATION}' AND m.object >= ? AND m.object < ?
        AND (m.object > ? OR (m.object = ? AND m.subject > ?))
      ORDER BY m.object, m.subject
      LIMIT ?`,
    pass.now,
    json,
    // The seek starts AT the cursor's object, so a resumed walk reads none of what it passed.
    after?.object ?? prefix,
    end,
    after?.object ?? '',
    after?.object ?? '',
    after?.subject ?? '',
    window,
  ) as { object: string; subject: string; hit: number }[];
  const found: { subject: string; object: string }[] = [];
  let read = 0;
  while (read < rows.length && found.length < room.writes) {
    const r = rows[read++]!;
    if (r.hit) found.push({ subject: r.subject, object: r.object });
  }
  room.reads -= read;
  room.writes -= found.length;
  const last = rows[read - 1];
  return {
    found,
    // Every marker it fetched was read, and the fetch came back short of the window: no more.
    done: read === rows.length && rows.length < window,
    at: last ? { object: last.object, subject: last.subject } : after,
  };
}

/**
 * One bounded walk of a shape's top-up: each live marker whose entity lacks a key of the current
 * shape (no row at all — a tombstone is a revoke, kept) gets that key, with one event.
 */
function topUp(
  db: SwitchSql,
  pass: ShapePass,
  entityType: string,
  prefix: string,
  keys: readonly string[],
  after: ShapeCursor['after'],
  room: Room,
): { holders: number; walk: Walk | null } {
  const json = JSON.stringify(keys);
  const walk = walkMarkers(
    db,
    pass,
    prefix,
    after,
    room,
    `EXISTS (SELECT 1 FROM json_each(?) k
              WHERE NOT EXISTS (SELECT 1 FROM _substrat_tuples t
                                 WHERE t.subject = m.subject AND t.object = m.object
                                   AND t.relation = 'granted:' || k.value))`,
    json,
  );
  for (const h of walk.found) {
    const added = (
      db.all(
        `SELECT k.value AS key FROM json_each(?) k
          WHERE NOT EXISTS (SELECT 1 FROM _substrat_tuples t
                             WHERE t.subject = ? AND t.object = ? AND t.relation = 'granted:' || k.value)
          ORDER BY k.value`,
        json,
        h.subject,
        h.object,
      ) as { key: string }[]
    ).map((m) => m.key);
    for (const key of added) {
      db.run(`INSERT OR IGNORE INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)`, h.subject, `granted:${key}`, h.object);
    }
    const st = kernelOutboxInsertSql(
      shapeEvent(pass, ENTITY_GRANTS_TOPPED_UP, entityGrantsToppedUpPayload, {
        principal: h.subject.slice(PRINCIPAL.length) as PrincipalId,
        entity: { entityType, entityId: h.object.slice(prefix.length) },
        added,
      }),
      pass.version,
    );
    db.run(st.sql, ...st.params);
  }
  return { holders: walk.found.length, walk };
}

/**
 * One bounded walk of a shape's retirement: each live marker still holding a retired key live
 * there has its retired keys tombstoned, with one event. Keys whose retirement already finished
 * on this scope are skipped, and a walk that reaches the shape's last marker records the rest
 * finished.
 */
function retire(
  db: SwitchSql,
  pass: ShapePass,
  entityType: string,
  prefix: string,
  gone: readonly string[],
  after: ShapeCursor['after'],
  room: Room,
): { holders: number; walk: Walk | null } {
  if (gone.length === 0) return { holders: 0, walk: null };
  const [shapeRef, scopeRef] = recordRefs(entityType, pass.scopeId);
  const finished = new Set(
    (
      db.all(
        `SELECT substr(relation, ${RETIRED_RELATION.length + 1}) AS key FROM _substrat_tuples
          WHERE subject = ? AND object = ? AND revoked_at IS NULL
            AND relation IN (SELECT '${RETIRED_RELATION}' || value FROM json_each(?))`,
        shapeRef,
        scopeRef,
        JSON.stringify(gone),
      ) as { key: string }[]
    ).map((r) => r.key),
  );
  const open = gone.filter((k) => !finished.has(k));
  if (open.length === 0) return { holders: 0, walk: null };
  const json = JSON.stringify(open);
  const walk = walkMarkers(
    db,
    pass,
    prefix,
    after,
    room,
    `EXISTS (SELECT 1 FROM _substrat_tuples t
              WHERE t.subject = m.subject AND t.object = m.object AND t.revoked_at IS NULL
                AND t.relation IN (SELECT 'granted:' || value FROM json_each(?)))`,
    json,
  );
  for (const h of walk.found) {
    // Tombstoned and read back in one statement: the keys this holder lost are what it touched.
    const removed = keysOf(
      (
        db.all(
          `UPDATE _substrat_tuples SET revoked_at = ?
            WHERE subject = ? AND object = ? AND revoked_at IS NULL
              AND relation IN (SELECT 'granted:' || value FROM json_each(?))
            RETURNING substr(relation, 9) AS key`,
          pass.now,
          h.subject,
          h.object,
          json,
        ) as { key: string }[]
      ).map((r) => r.key),
    );
    const st = kernelOutboxInsertSql(
      shapeEvent(pass, ENTITY_GRANTS_RETIRED, entityGrantsRetiredPayload, {
        principal: h.subject.slice(PRINCIPAL.length) as PrincipalId,
        entity: { entityType, entityId: h.object.slice(prefix.length) },
        removed,
      }),
      pass.version,
    );
    db.run(st.sql, ...st.params);
  }
  if (walk.done) {
    for (const k of open) {
      db.run('INSERT OR REPLACE INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)', shapeRef, `${RETIRED_RELATION}${k}`, scopeRef);
    }
  }
  return { holders: walk.found.length, walk };
}

/**
 * A key back in the shape ends its retirement's record (tombstoned, like any tuple), so a later
 * release that drops and retires it again runs the retirement again.
 */
function reopenRetirements(db: SwitchSql, pass: ShapePass, entityType: string, keys: readonly string[]): void {
  if (keys.length === 0) return;
  db.run(
    `UPDATE _substrat_tuples SET revoked_at = ?
      WHERE subject = ? AND object = ? AND revoked_at IS NULL
        AND relation IN (SELECT '${RETIRED_RELATION}' || value FROM json_each(?))`,
    pass.now,
    ...recordRefs(entityType, pass.scopeId),
    JSON.stringify(keys),
  );
}

/**
 * One bounded batch of the backfill for one shape — at most `budget` marks — and the run-once
 * record when the batch comes back short. Returns how many it marked. See the module comment:
 * provenance only, from the shape's declared `holder`.
 */
function backfill(db: SwitchSql, pass: ShapePass, shape: EntityGrantShape, prefix: string, json: string, budget: number): number {
  if (!shape.holder || budget === 0) return 0;
  const [shapeRef, scopeRef] = recordRefs(shape.entityType, pass.scopeId);
  const record = [shapeRef, BACKFILLED_RELATION, scopeRef] as const;
  if (db.all('SELECT 1 FROM _substrat_tuples WHERE subject = ? AND relation = ? AND object = ?', ...record).length > 0) {
    return 0;
  }
  // Not yet a holder in any state: a tombstoned marker is a revoke of the holding, kept.
  const unmarked = (subject: string, object: string) =>
    `NOT EXISTS (SELECT 1 FROM _substrat_tuples m WHERE m.subject = ${subject} AND m.relation = '${ENTITY_SHAPE_MARKER_RELATION}' AND m.object = ${object})`;
  const heldThere = (subject: string, object: string) =>
    `EXISTS (SELECT 1 FROM _substrat_tuples g WHERE g.subject = ${subject} AND g.object = ${object}
               AND g.relation IN (SELECT 'granted:' || value FROM json_each(?)))`;
  let candidates: { subject: string; object: string }[];
  if (shape.holder === 'self') {
    // The entity id IS the principal: `owner:<p>` belongs to `principal:<p>` and nobody else.
    candidates = db.all(
      `SELECT DISTINCT t.subject, t.object FROM _substrat_tuples t
        WHERE t.object >= ? AND t.object < ?
          AND t.subject = '${PRINCIPAL}' || substr(t.object, ?)
          AND t.relation IN (SELECT 'granted:' || value FROM json_each(?))
          AND ${unmarked('t.subject', 't.object')}
        ORDER BY t.subject, t.object
        LIMIT ?`,
      ...typeRange(prefix),
      prefix.length + 1,
      json,
      budget,
    ) as { subject: string; object: string }[];
  } else if (shape.holder === 'grantee') {
    // Whoever holds a LIVE key of the shape on an entity of this type. Live, unlike the other two
    // holders: with no record naming the person, a key taken back from them is no evidence they
    // still belong there, and marking them would hand a revoked portal the next key it gains.
    candidates = db.all(
      `SELECT DISTINCT t.subject, t.object FROM _substrat_tuples t
        WHERE t.object >= ? AND t.object < ?
          AND substr(t.subject, 1, ${PRINCIPAL.length}) = '${PRINCIPAL}'
          AND t.relation IN (SELECT 'granted:' || value FROM json_each(?))
          AND ${liveTupleSql('t')}
          AND ${unmarked('t.subject', 't.object')}
        ORDER BY t.subject, t.object
        LIMIT ?`,
      ...typeRange(prefix),
      json,
      pass.now,
      budget,
    ) as { subject: string; object: string }[];
  } else {
    const { table, idColumn, principalColumn } = shape.holder;
    const where = `entityGrants holder of '${shape.entityType}'`;
    for (const [kind, name] of [['a table', table], ['a column', idColumn], ['a column', principalColumn]] as const) {
      assertSqlIdentifier('reconcileEntityGrantShapes', kind, name, where);
    }
    // The vertical's table may not exist yet on this scope (a module not migrated): nothing to
    // mark, and the backfill stays open for the next reconcile rather than being recorded done.
    if (db.all(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, table).length === 0) return 0;
    const subject = `'${PRINCIPAL}' || e."${principalColumn}"`;
    const object = `? || e."${idColumn}"`;
    candidates = db.all(
      `SELECT ${subject} AS subject, ${object} AS object FROM "${table}" e
        WHERE e."${principalColumn}" IS NOT NULL
          AND ${heldThere(subject, object)}
          AND ${unmarked(subject, object)}
        ORDER BY 1, 2
        LIMIT ?`,
      prefix,
      prefix,
      json,
      prefix,
      budget,
    ) as { subject: string; object: string }[];
  }
  for (const c of candidates) {
    db.run('INSERT OR IGNORE INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)', c.subject, ENTITY_SHAPE_MARKER_RELATION, c.object);
  }
  if (candidates.length < budget) {
    db.run('INSERT OR IGNORE INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)', ...record);
  }
  return candidates.length;
}

/**
 * The current and retired keys of every `holder: 'grantee'` bootstrap shape, recorded so the
 * explicit tuple writer can refuse them to every non-shape grant. A reconcile carries the
 * reached version's whole reviewed registry,
 * so the records are made to match it exactly: a declaration a later version drops stops
 * refusing. Bounded by the declared keys, so it runs in every pass without a budget.
 */
function recordGranteeKeys(db: SwitchSql, shapes: readonly EntityGrantShape[]): void {
  const rows = shapes
    .filter((s) => s.bootstrap && s.holder === 'grantee')
    .flatMap((s) => keysOf([...s.permissions, ...(s.retired ?? [])]).map((k): [string, string] => [`shape:${s.entityType}`, `granted:${k}`]));
  db.run(
    // The subject range keeps it on the primary key: `shape:` rows only, never the whole table.
    `DELETE FROM _substrat_tuples WHERE subject >= 'shape:' AND subject < 'shape;' AND relation = ?
        AND NOT EXISTS (SELECT 1 FROM json_each(?) r
                         WHERE json_extract(r.value, '$[0]') = _substrat_tuples.subject
                           AND json_extract(r.value, '$[1]') = _substrat_tuples.object)`,
    GRANTEE_KEY_RELATION,
    JSON.stringify(rows),
  );
  for (const [subject, object] of rows) {
    db.run('INSERT OR IGNORE INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)', subject, GRANTEE_KEY_RELATION, object);
  }
}

/**
 * The kernel's event for one (person, entity) a pass changed — a top-up or a retirement — the
 * audit record, on the entity's own history.
 */
function shapeEvent<P extends { entity: EntityRef }>(
  pass: ShapePass,
  type: typeof ENTITY_GRANTS_TOPPED_UP | typeof ENTITY_GRANTS_RETIRED,
  schema: { parse: (v: unknown) => P },
  payload: P,
): DomainEvent {
  return domainEvent.parse({
    id: eventId.parse(pass.mintEventId(Date.parse(pass.now))),
    type,
    schemaVersion: 1,
    occurredAt: pass.now,
    tenantId: pass.tenantId,
    scopeId: pass.scopeId,
    actor: KERNEL_ACTOR,
    entity: payload.entity,
    piiClass: 'none',
    payload: schema.parse(payload),
  });
}
