/**
 * Subject access (GDPR Art. 15, D-74): one page of what a scope holds about one data subject.
 *
 * **It reads exactly what erasure writes, through the same plan.** The declared entities come from
 * the `ModuleErasurePlan`s erasure runs, and each one's rows are matched by `subjectMatchOf`, the
 * predicate `eraseSubjectFromModules` blanks and deletes by. A subject column a model adds reaches
 * both, and the parity contract test (`subjectAccessContractSuite`) holds the two to the same
 * counts.
 *
 * **The event read is wider than erasure's**: every outbox row with the subject's id, `piiClass:
 * 'none'` included, and an erased event as its envelope with `erased: true` (`readSubjectEvents`).
 *
 * **It writes nothing and runs no module code.** A `custom` entity is reached by erasure only
 * through the module's `onSubjectErased` hook, which can write; access does not call it, so those
 * entities are named in `hookEntities` instead, unreached for access until a read-only twin exists
 * (P3 of the RFC).
 *
 * Paging: each source is walked in turn, events first and then each declared entity in
 * registration order, until the page's budget of events plus rows is spent. The cursor names the
 * source and where in it to resume. The pages of one request are separate reads (a separate RPC on
 * a Durable Object), so the scope can change between them, and both sources resume by key: events
 * after the last outbox id, an entity's rows after the last primary key in key order (#3303). A row
 * written or deleted between two pages then repeats or skips no other row. A manifest derived
 * before the erasure declaration carried the key has none to seek on; its rows are paged by offset
 * in scan order, and each listing says which (`paging`), so the package can state it.
 */
import {
  SUBJECT_READ_PAGE_DEFAULT,
  SUBJECT_READ_PAGE_MAX,
  substratError,
  type SubjectEvent,
  type SubjectReadPage,
  type SubjectReadRequest,
  type SubjectRecords,
  type UnreachedEntity,
} from '@substrat-run/contracts';
import { base64UrlToBytes, bytesToBase64Url } from '@substrat-run/contracts/scope-store-envelope';
import { erasureColumnOf, erasureTableOf, subjectMatchOf, type ModuleErasurePlan } from './module-erasure.js';
import type { ScopedSql } from './scope-host.js';
import { readSubjectEvents } from './timeline.js';

/** Where an entity's rows resume: after a primary key, or after `offset` rows in scan order. */
type RowPosition = { key: readonly KeyValue[] } | { offset: number };
type KeyValue = string | number;

/** Where a page resumes: in the events after an id, or in the `entity`th declared entity at `at` (its start when absent). */
type SubjectCursor = { source: 'events'; after?: string } | { source: 'records'; entity: number; at?: RowPosition };

// Web-standard globals the kernel's lib does not declare (as in `sweep-budget.ts`).
declare const TextDecoder: new () => { decode(input: Uint8Array): string };
declare const TextEncoder: new () => { encode(input: string): Uint8Array };

const EVENTS_CURSOR = /^e:(.+)$/;
const OFFSET_CURSOR = /^r:(\d{1,6}):(\d{1,9})$/;
const KEY_CURSOR = /^r:(\d{1,6}):k:([A-Za-z0-9_-]{1,4096})$/;

const notACursor = () =>
  substratError('validation_failed', 'readSubject: not a cursor this read issued', { reason: 'subject_cursor' });

function parseKey(encoded: string): KeyValue[] {
  const bytes = base64UrlToBytes(encoded);
  let key: unknown;
  try {
    key = bytes && JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw notACursor();
  }
  if (!Array.isArray(key) || key.length === 0 || !key.every((v) => typeof v === 'string' || Number.isFinite(v))) {
    throw notACursor();
  }
  return key as KeyValue[];
}

function parseCursor(cursor: string | undefined): SubjectCursor {
  if (cursor === undefined) return { source: 'events' };
  const events = EVENTS_CURSOR.exec(cursor);
  if (events) return { source: 'events', after: events[1]! };
  const offset = OFFSET_CURSOR.exec(cursor);
  if (offset) {
    // Offset 0 is the entity's start, whichever way the entity is then paged.
    const n = Number(offset[2]);
    return { source: 'records', entity: Number(offset[1]), ...(n > 0 ? { at: { offset: n } } : {}) };
  }
  const keyed = KEY_CURSOR.exec(cursor);
  if (keyed) return { source: 'records', entity: Number(keyed[1]), at: { key: parseKey(keyed[2]!) } };
  throw notACursor();
}

const recordsCursor = (entity: number, at: RowPosition): string =>
  'offset' in at
    ? `r:${entity}:${at.offset}`
    : `r:${entity}:k:${bytesToBase64Url(new TextEncoder().encode(JSON.stringify(at.key)))}`;

/**
 * The key a cursor carries: the last row's primary key values. Only text and finite numbers round
 * trip through the cursor's JSON exactly; any other key value (a blob, a NULL) is refused here rather
 * than resumed from a different place.
 */
function keyOf(entityType: string, row: Record<string, unknown>, primaryKey: readonly string[]): KeyValue[] {
  return primaryKey.map((column) => {
    const v = row[column];
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) return v;
    throw substratError('internal', `readSubject: ${entityType}.${column} holds a primary key value a cursor cannot carry`);
  });
}

/** The declared entities access reads, in the order a cursor numbers them. */
function readableEntities(plans: readonly ModuleErasurePlan[]) {
  return plans.flatMap((plan) =>
    plan.declaration.entities
      .filter((e) => e.mode === 'blank' || e.mode === 'delete')
      .map((entity) => ({ moduleId: plan.moduleId, entity })),
  );
}

/** What a page says about the entities it cannot read: the same on every page. */
function unreachedOf(plans: readonly ModuleErasurePlan[]): Pick<SubjectReadPage, 'unreachedEntities' | 'hookEntities'> {
  const unreachedEntities: UnreachedEntity[] = [];
  const hookEntities: UnreachedEntity[] = [];
  for (const plan of plans) {
    for (const entity of plan.declaration.entities) {
      if (entity.mode === 'unreached') unreachedEntities.push({ module: plan.moduleId, entityType: entity.entityType });
      if (entity.mode === 'custom') hookEntities.push({ module: plan.moduleId, entityType: entity.entityType });
    }
  }
  return { unreachedEntities, hookEntities };
}

/**
 * One page of what this scope holds about `subjectId`. `sql` is the kernel's own handle on the
 * scope, never module code's; the caller runs this inside one read so the page is consistent, and
 * applies the scope's pending migrations first so every declared table exists.
 */
export function readSubjectPage(input: {
  readonly sql: Pick<ScopedSql, 'query'>;
  readonly plans: readonly ModuleErasurePlan[];
  readonly subjectId: string;
  readonly page?: SubjectReadRequest;
}): SubjectReadPage {
  const { sql, plans, subjectId } = input;
  const limit = Math.min(Math.max(Math.floor(input.page?.limit ?? SUBJECT_READ_PAGE_DEFAULT) || 1, 1), SUBJECT_READ_PAGE_MAX);
  let cursor = parseCursor(input.page?.cursor);
  const entities = readableEntities(plans);
  const events: SubjectEvent[] = [];
  const records: SubjectRecords[] = [];
  let budget = limit;
  let nextCursor: string | null = null;

  if (cursor.source === 'events') {
    const read = readSubjectEvents({ sql }, subjectId, cursor.after, budget);
    events.push(...read.slice(0, budget));
    if (read.length > budget) {
      nextCursor = `e:${events[events.length - 1]!.id}`;
      budget = 0;
    } else {
      budget -= read.length;
      cursor = { source: 'records', entity: 0 };
    }
  }

  if (cursor.source === 'records' && nextCursor === null) {
    let index = cursor.entity;
    let at = cursor.at;
    while (index < entities.length) {
      if (budget === 0) {
        nextCursor = recordsCursor(index, at ?? { offset: 0 });
        break;
      }
      const { moduleId, entity } = entities[index]!;
      const primaryKey = entity.primaryKey;
      // An offset cursor stays an offset walk to the entity's end, even where the key is now
      // declared: it counts rows in scan order, which a key seek cannot resume.
      const byKey = primaryKey !== undefined && !(at && 'offset' in at);
      const { where, params } = subjectMatchOf(entity, subjectId);
      // `main.`: a TEMP object named like the declared table would otherwise answer in its place.
      const from = `SELECT * FROM main.${erasureTableOf(entity)} WHERE ${where}`;
      let rows: Record<string, unknown>[];
      if (byKey) {
        const columns = primaryKey.map(erasureColumnOf);
        const after = at && 'key' in at ? at.key : undefined;
        if (after && after.length !== columns.length) throw notACursor();
        // A row value compares column by column in key order, each under its column's collation,
        // which is the order ORDER BY walks: SQLite 3.15+, which both adapters run.
        const seek = !after
          ? ''
          : columns.length === 1
            ? ` AND ${columns[0]} > ?`
            : ` AND (${columns.join(', ')}) > (${columns.map(() => '?').join(', ')})`;
        rows = sql.query<Record<string, unknown>>(`${from}${seek} ORDER BY ${columns.join(', ')} LIMIT ?`, [
          ...params,
          ...(after ?? []),
          budget + 1,
        ]);
      } else {
        // A key cursor for an entity with no key to seek on resumes nowhere it means.
        if (at && 'key' in at) throw notACursor();
        const offset = at && 'offset' in at ? at.offset : 0;
        rows = sql.query<Record<string, unknown>>(`${from} LIMIT ? OFFSET ?`, [...params, budget + 1, offset]);
      }
      const taken = rows.slice(0, budget);
      // An entity is listed on the page that reads its first rows, a zero included, so a reader
      // can tell "looked at and held nothing" from "not looked at". Later pages add only rows.
      if (at === undefined || taken.length > 0) {
        records.push({
          module: moduleId,
          entityType: entity.entityType,
          mode: entity.mode as 'blank' | 'delete',
          subjects: [...(entity.subjects ?? [])],
          erasable: entity.fields.map((f) => f.name),
          rows: taken,
          paging: byKey ? 'key' : 'offset',
        });
      }
      budget -= taken.length;
      if (rows.length > taken.length) {
        nextCursor = recordsCursor(
          index,
          byKey
            ? { key: keyOf(entity.entityType, taken[taken.length - 1]!, primaryKey) }
            : { offset: (at && 'offset' in at ? at.offset : 0) + taken.length },
        );
        break;
      }
      index += 1;
      at = undefined;
    }
  }

  return { events, records, ...unreachedOf(plans), nextCursor };
}
