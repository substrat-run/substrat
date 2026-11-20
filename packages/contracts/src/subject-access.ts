/**
 * Subject access (GDPR Art. 15, D-74, `docs/rfc/subject-access.md`): what one scope holds about one
 * data subject, read through the same reach erasure writes through.
 *
 * This file is the read's page, the shape that crosses a Durable Object's RPC and a vertical's
 * `/internal` hop. The package a controller downloads is assembled from pages by the control
 * plane, which is also where masking and the audit happen.
 */
import { z } from 'zod';
import { scopeHistoryEntry } from './events.js';
import { subjectErasureMode, unreachedEntity } from './subject-erasure.js';

/**
 * One event keyed to the subject, decoded as `readScopeHistory` decodes it, and whether an erasure
 * already took its payload.
 *
 * Wider than erasure on purpose: every outbox row with the subject's id, `piiClass: 'none'`
 * included, because access answers *whether* data about the person is processed at all. An
 * erased event keeps its envelope, which is what the person is owed: the fact that something
 * happened, without what was said.
 */
export const subjectEvent = scopeHistoryEntry.extend({
  /** The stored payload is NULL: an erasure took it (K-37). A payload that only failed to decode is not erased. */
  erased: z.boolean(),
});
export type SubjectEvent = z.infer<typeof subjectEvent>;

/** One declared entity's rows that are the subject's: whole rows, matched by the predicate erasure uses. */
export const subjectRecords = z.object({
  module: z.string().min(1),
  entityType: z.string().min(1),
  mode: subjectErasureMode.extract(['blank', 'delete']),
  /** The entity's subject columns, so a reader can tell the subject's id from another person's. */
  subjects: z.array(z.string().min(1)).min(1),
  /** The entity's erasable fields: the data categories this entity holds about a person. */
  erasable: z.array(z.string().min(1)),
  rows: z.array(z.record(z.string(), z.unknown())),
});
export type SubjectRecords = z.infer<typeof subjectRecords>;

/**
 * One page of `readSubject`. Each source is walked in turn, the events first and then each
 * declared entity, until the page's budget is spent; `nextCursor` resumes where it stopped and is
 * null once every source is exhausted. Opaque to the caller.
 *
 * `unreachedEntities` is the list a shred receipt names (an entity with erasable fields and no
 * subject link). `hookEntities` are the entities erasure reaches only through a module's
 * `onSubjectErased` hook, which access has no read-only twin for yet: unreached for access, and
 * named so the package says so. Both are the same on every page.
 */
export const subjectReadPage = z.object({
  events: z.array(subjectEvent),
  records: z.array(subjectRecords),
  unreachedEntities: z.array(unreachedEntity),
  hookEntities: z.array(unreachedEntity),
  nextCursor: z.string().min(1).nullable(),
});
export type SubjectReadPage = z.infer<typeof subjectReadPage>;

/** What a caller may ask of one page: where to resume, and how many items at most. */
export interface SubjectReadRequest {
  readonly cursor?: string;
  readonly limit?: number;
}

/** The default and the ceiling of a `readSubject` page, in events plus rows. */
export const SUBJECT_READ_PAGE_DEFAULT = 200;
export const SUBJECT_READ_PAGE_MAX = 1000;
