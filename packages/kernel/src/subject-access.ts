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
 * source and where in it to resume. An entity's rows are paged by offset in the table's own scan
 * order, which is stable while the scope does not change between pages; the caller reads the pages
 * of one request back to back.
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
import { erasureTableOf, subjectMatchOf, type ModuleErasurePlan } from './module-erasure.js';
import type { ScopedSql } from './scope-host.js';
import { readSubjectEvents } from './timeline.js';

/** Where a page resumes: in the events after an id, or in the `entity`th declared entity after `offset` rows. */
type SubjectCursor = { source: 'events'; after?: string } | { source: 'records'; entity: number; offset: number };

const EVENTS_CURSOR = /^e:(.+)$/;
const RECORDS_CURSOR = /^r:(\d{1,6}):(\d{1,9})$/;

function parseCursor(cursor: string | undefined): SubjectCursor {
  if (cursor === undefined) return { source: 'events' };
  const events = EVENTS_CURSOR.exec(cursor);
  if (events) return { source: 'events', after: events[1]! };
  const records = RECORDS_CURSOR.exec(cursor);
  if (records) return { source: 'records', entity: Number(records[1]), offset: Number(records[2]) };
  throw substratError('validation_failed', 'readSubject: not a cursor this read issued', { reason: 'subject_cursor' });
}

const recordsCursor = (entity: number, offset: number): string => `r:${entity}:${offset}`;

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
      cursor = { source: 'records', entity: 0, offset: 0 };
    }
  }

  if (cursor.source === 'records' && nextCursor === null) {
    let { entity: index, offset } = cursor;
    while (index < entities.length) {
      if (budget === 0) {
        nextCursor = recordsCursor(index, offset);
        break;
      }
      const { moduleId, entity } = entities[index]!;
      const { where, params } = subjectMatchOf(entity, subjectId);
      const rows = sql.query<Record<string, unknown>>(
        // `main.`: a TEMP object named like the declared table would otherwise answer in its place.
        `SELECT * FROM main.${erasureTableOf(entity)} WHERE ${where} LIMIT ? OFFSET ?`,
        [...params, budget + 1, offset],
      );
      const taken = rows.slice(0, budget);
      // An entity is listed on the page that reads its first rows, a zero included, so a reader
      // can tell "looked at and held nothing" from "not looked at". Later pages add only rows.
      if (offset === 0 || taken.length > 0) {
        records.push({
          module: moduleId,
          entityType: entity.entityType,
          mode: entity.mode as 'blank' | 'delete',
          subjects: [...(entity.subjects ?? [])],
          erasable: entity.fields.map((f) => f.name),
          rows: taken,
        });
      }
      budget -= taken.length;
      if (rows.length > taken.length) {
        nextCursor = recordsCursor(index, offset + taken.length);
        break;
      }
      index += 1;
      offset = 0;
    }
  }

  return { events, records, ...unreachedOf(plans), nextCursor };
}
