import type { EntityRef, PermissionKey } from '@substrat-run/contracts';
import { fromBase64url, toBase64url } from './base64url.js';

/** Added to both scope schemas and their on-wake upgrade path. */
export const GRANT_CHILDREN_INDEX_DDL =
  'CREATE INDEX IF NOT EXISTS _substrat_tuples_object_relation_subject ON _substrat_tuples (object, relation, subject)';

export type GrantedEntitiesPage =
  | { kind: 'all' }
  | { kind: 'incomplete'; reason: 'capability' | 'checker' }
  | { kind: 'ids'; ids: string[]; nextCursor: string | null };

export interface GrantWalkRow {
  subject: string;
  object: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface GrantWalkStore {
  /** The next grant for one subject, from the tuple primary key. */
  nextGrant(subject: string, relation: string, after: string): GrantWalkRow | undefined;
  /** The next reverse parent edge, from GRANT_CHILDREN_INDEX_DDL. */
  nextChild(parent: string, after: string): GrantWalkRow | undefined;
}

type Frame = { ref: string; after: string; entered: boolean };
type Position = { v: 1; permission: string; entityType: string; subject: number; rootAfter: string; stack: Frame[] };

const WALK_DEPTH = 4;
export const GRANT_READ_MAX_LIMIT = 100;
export const GRANT_READ_WORK_BUDGET = 2_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const live = (row: GrantWalkRow, now: string): boolean =>
  row.revoked_at === null && (row.expires_at === null || row.expires_at > now);

function decode(cursor: string, permission: PermissionKey, entityType: string): Position {
  try {
    const bytes = fromBase64url(cursor);
    if (!bytes || bytes.length > 16_384) throw new Error();
    const value = JSON.parse(decoder.decode(bytes)) as Position;
    if (
      value.v !== 1 || value.permission !== permission || value.entityType !== entityType ||
      !Number.isSafeInteger(value.subject) || value.subject < 0 ||
      typeof value.rootAfter !== 'string' || !Array.isArray(value.stack) ||
      value.stack.length > WALK_DEPTH + 1 ||
      value.stack.some((f) => typeof f.ref !== 'string' || typeof f.after !== 'string' || typeof f.entered !== 'boolean')
    ) throw new Error();
    return value;
  } catch {
    throw new Error('invalid grantedEntities cursor');
  }
}

const encode = (position: Position): string => toBase64url(encoder.encode(JSON.stringify(position)));

/**
 * Depth-first over grant roots and reverse parent edges. A cursor stores only the current
 * path (at most five refs), so neither graph width nor total result count grows it. A
 * multi-parent graph can produce the same id on different pages; consumers combine pages
 * as a set. Every id is rechecked by the caller before it leaves the kernel.
 */
export async function walkGrantedEntities(
  store: GrantWalkStore,
  subjects: readonly string[],
  permission: PermissionKey,
  entityType: string,
  now: string,
  check: (entity: EntityRef) => Promise<boolean>,
  options: { limit?: number; cursor?: string; workBudget?: number } = {},
): Promise<Extract<GrantedEntitiesPage, { kind: 'ids' }>> {
  const limit = options.limit ?? 50;
  const workBudget = options.workBudget ?? GRANT_READ_WORK_BUDGET;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > GRANT_READ_MAX_LIMIT) {
    throw new Error(`grantedEntities limit must be 1..${GRANT_READ_MAX_LIMIT}`);
  }
  if (!Number.isSafeInteger(workBudget) || workBudget < 1 || workBudget > GRANT_READ_WORK_BUDGET) {
    throw new Error(`grantedEntities work budget must be 1..${GRANT_READ_WORK_BUDGET}`);
  }
  const p: Position = options.cursor
    ? decode(options.cursor, permission, entityType)
    : { v: 1, permission, entityType, subject: 0, rootAfter: '', stack: [] };
  const ids: string[] = [];
  const seenOnPage = new Set<string>();
  let work = 0;
  const relation = `granted:${permission}`;
  while (p.subject < subjects.length) {
    if (work >= workBudget || ids.length >= limit) {
      return { kind: 'ids', ids, nextCursor: encode(p) };
    }
    if (p.stack.length === 0) {
      const grant = store.nextGrant(subjects[p.subject]!, relation, p.rootAfter);
      work++;
      if (!grant) {
        p.subject++;
        p.rootAfter = '';
        continue;
      }
      if (!live(grant, now)) {
        p.rootAfter = grant.object;
        continue;
      }
      p.stack.push({ ref: grant.object, after: '', entered: false });
    }
    const frame = p.stack[p.stack.length - 1]!;
    if (!frame.entered) {
      frame.entered = true;
      work++;
      const colon = frame.ref.indexOf(':');
      if (colon >= 0 && frame.ref.slice(0, colon) === entityType) {
        const id = frame.ref.slice(colon + 1);
        if (!seenOnPage.has(id) && await check({ entityType, entityId: id })) {
          seenOnPage.add(id);
          ids.push(id);
        }
      }
      continue;
    }
    if (p.stack.length <= WALK_DEPTH) {
      const child = store.nextChild(frame.ref, frame.after);
      work++;
      if (child) {
        frame.after = child.subject;
        if (live(child, now) && !p.stack.some((f) => f.ref === child.subject)) {
          p.stack.push({ ref: child.subject, after: '', entered: false });
        }
        continue;
      }
    }
    p.stack.pop();
    if (p.stack.length === 0) p.rootAfter = frame.ref;
  }
  return { kind: 'ids', ids, nextCursor: null };
}
