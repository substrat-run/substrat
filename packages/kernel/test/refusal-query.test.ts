// `node:sqlite`, as facet-events.test.ts: the kernel declares no better-sqlite3.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { refusalRecord } from '@substrat-run/contracts';
import { REFUSALS_DDL, refusalInsert } from '../src/refusals.js';
import { mapRefusalRow, refusalListQuery, type RefusalDbRow } from '../src/refusal-query.js';
import { ulid } from '../src/ulid.js';

const T = ulid();
const S = ulid();
const ALICE = ulid();

/**
 * #1745: the refusal log's read, against the real DDL both adapters run — the INSERT the
 * kernel writes, read back by the SELECT both adapters build. Executed, never string-matched.
 */
function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(REFUSALS_DDL);
  return d;
}

function write(d: DatabaseSync, over: Partial<Parameters<typeof refusalInsert>[0]> & { entityId?: string; at: string }): void {
  const q = refusalInsert({
    tenantId: T,
    scopeId: S,
    refused: { entityType: 'order', entityId: over.entityId ?? 'o1', from: 'closed', operation: 'shop/complete', attempted: 'completed' },
    invokedOperation: 'shop/complete',
    actor: over.actor ?? JSON.stringify(ALICE),
    impersonation: null,
    invocationId: over.invocationId ?? null,
    at: over.at,
  });
  d.prepare(q.sql).run(...q.params);
}

function read(d: DatabaseSync, filter?: Parameters<typeof refusalListQuery>[0]) {
  const q = refusalListQuery(filter);
  return (d.prepare(q.sql).all(...q.params) as unknown as RefusalDbRow[]).map(mapRefusalRow);
}

describe('refusal log read (#1745)', () => {
  it('maps a written row to the published shape, with the problem code and actor kind', () => {
    const d = db();
    write(d, { at: '2026-10-01T10:00:00.000Z', invocationId: 'call-1' });
    const [row] = read(d);
    expect(refusalRecord.parse(row)).toEqual(row);
    expect(row).toMatchObject({
      kind: 'transition',
      reason: 'invalid_transition',
      actor: ALICE,
      actorKind: 'principal',
      entityType: 'order',
      entityId: 'o1',
      fromState: 'closed',
      attemptedState: 'completed',
      operation: 'shop/complete',
      invocationId: 'call-1',
    });
    expect(row!.decodeError).toBeUndefined();
  });

  it('filters by record, actor (logical form), call and a half-open window, newest first', () => {
    const d = db();
    write(d, { at: '2026-10-01T10:00:00.000Z', entityId: 'o1' });
    write(d, { at: '2026-10-01T11:00:00.000Z', entityId: 'o2', actor: JSON.stringify({ system: 'mail' }), invocationId: 'c2' });
    write(d, { at: '2026-10-01T12:00:00.000Z', entityId: 'o1' });
    expect(read(d).map((r) => r.at)).toEqual([
      '2026-10-01T12:00:00.000Z',
      '2026-10-01T11:00:00.000Z',
      '2026-10-01T10:00:00.000Z',
    ]);
    expect(read(d, { entityType: 'order', entityId: 'o1' })).toHaveLength(2);
    expect(read(d, { actor: ALICE })).toHaveLength(2);
    expect(read(d, { actor: '{"system":"mail"}' })).toMatchObject([{ entityId: 'o2', actorKind: 'system' }]);
    expect(read(d, { invocationId: 'c2' })).toHaveLength(1);
    expect(read(d, { since: '2026-10-01T11:00:00.000Z', until: '2026-10-01T12:00:00.000Z' })).toMatchObject([{ entityId: 'o2' }]);
    expect(read(d, { limit: 1 })).toHaveLength(1);
  });

  it('reads an undecodable actor as the marker, saying so, rather than losing the page', () => {
    const d = db();
    write(d, { at: '2026-10-01T10:00:00.000Z', actor: '{not json' });
    write(d, { at: '2026-10-01T11:00:00.000Z' });
    const rows = read(d);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ actor: { system: 'undecodable' }, actorKind: 'unknown' });
    expect(rows[1]!.decodeError).toMatch(/actor/);
  });

  it('refuses a filter outside its bounds rather than building SQL from it', () => {
    expect(() => refusalListQuery({ limit: 0 })).toThrow();
    expect(() => refusalListQuery({ limit: 10_000 })).toThrow();
  });
});
