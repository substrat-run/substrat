/**
 * #3464 (K-37 limit 6): the lake drain seals each classified payload under its subject's key, and
 * the key store under it holds up when two sealers, or a sealer and a shred, meet. The end-to-end
 * erasure on both adapters is `scope-host-suite.ts`'s; this file holds what needs a port the test
 * controls: the interleavings, one directory read per batch, and a seal that fails.
 */
import { describe, expect, it } from 'vitest';
import { lakeSealedPayload, type DrainedEvent } from '@substrat-run/contracts';
import { createSubjectKeys, type SubjectKeyRecords, type SubjectKeyRow } from '../src/subject-keys.js';
import { webCryptoSecretBox } from '../src/secret-box.js';
import { drainScopeEvents, type EventSink } from '../src/platform-sweep.js';
import { ulid } from '../src/ulid.js';
import type { ScopeHost } from '../src/scope-host.js';

const box = webCryptoSecretBox('master', new Uint8Array(32).fill(7));

/** The directory table as both adapters hold it: `INSERT OR IGNORE`, a tombstone that upserts. */
function memoryRecords(hooks: { beforeInsert?: (subjectId: string) => Promise<void> | void } = {}) {
  const rows = new Map<string, SubjectKeyRow>();
  const calls = { read: 0, readMany: 0 };
  const records: Required<SubjectKeyRecords> = {
    read: (id) => {
      calls.read += 1;
      return rows.get(id);
    },
    readMany: (ids) => {
      calls.readMany += 1;
      return new Map(ids.flatMap((id) => (rows.has(id) ? [[id, rows.get(id)!] as const] : [])));
    },
    insert: async (id, row) => {
      await hooks.beforeInsert?.(id);
      if (!rows.has(id)) rows.set(id, { keyId: row.keyId, wrappedDek: row.wrappedDek, shreddedAt: null });
    },
    tombstone: (id, at) => {
      const existed = Boolean(rows.get(id)?.wrappedDek);
      rows.set(id, { keyId: null, wrappedDek: null, shreddedAt: at });
      return { existed };
    },
  };
  return { rows, calls, records };
}

describe('createSubjectKeys under concurrency (#3464)', () => {
  it('two sealers minting one subject at once both seal under the key that was stored', async () => {
    // Both read "no key" before either inserts: the insert is held until both have read.
    let release!: () => void;
    const bothRead = new Promise<void>((r) => (release = r));
    let inserts = 0;
    const { records } = memoryRecords({
      beforeInsert: async () => {
        if (++inserts === 2) release();
        await bothRead;
      },
    });
    const keys = createSubjectKeys(box, records);
    const subject = ulid();
    const [[a], [b]] = await Promise.all([
      keys.sealMany([{ subjectId: subject, plaintext: 'from the backup' }]),
      keys.sealMany([{ subjectId: subject, plaintext: 'from the lake' }]),
    ]);
    // The loser of the insert must not seal with a key nothing stored: both open.
    expect(await keys.openMany([{ subjectId: subject, sealed: a! }, { subjectId: subject, sealed: b! }])).toEqual([
      'from the backup',
      'from the lake',
    ]);
  });

  it('a shred landing between the read and the mint refuses, and leaves the tombstone', async () => {
    const subject = ulid();
    const { rows, records } = memoryRecords({
      beforeInsert: (id) => void records.tombstone(id, '2026-11-27T00:00:00.000Z'),
    });
    const keys = createSubjectKeys(box, records);
    expect(await keys.sealMany([{ subjectId: subject, plaintext: 'too late' }])).toEqual([null]);
    expect(rows.get(subject)).toEqual({ keyId: null, wrappedDek: null, shreddedAt: '2026-11-27T00:00:00.000Z' });
  });

  it('reads every subject of a batch in one directory call', async () => {
    const { calls, records } = memoryRecords();
    const keys = createSubjectKeys(box, records);
    const subjects = [ulid(), ulid(), ulid()];
    await keys.sealMany(subjects.map((subjectId) => ({ subjectId, plaintext: 'x' })));
    calls.read = 0;
    calls.readMany = 0;
    await keys.sealMany([...subjects, ...subjects].map((subjectId) => ({ subjectId, plaintext: 'y' })));
    expect(calls).toEqual({ read: 0, readMany: 1 });
  });
});

describe('drainScopeEvents with sealEventPayloads (#3464)', () => {
  const tenantId = ulid() as never;
  const scopeId = ulid() as never;
  const event = (over: Partial<DrainedEvent> = {}): DrainedEvent =>
    ({
      id: ulid(),
      type: 'thing.happened',
      schemaVersion: 1,
      occurredAt: '2026-11-27T10:00:00.000Z',
      tenantId,
      scopeId,
      actor: ulid(),
      entity: { entityType: 'thing', entityId: 'x1' },
      piiClass: 'none',
      payload: { note: 'hello' },
      operation: 'mod/op',
      version: null,
      causedBy: null,
      invocationId: null,
      ...over,
    }) as DrainedEvent;

  /** A host with just the three admin verbs the drain calls, and a sink that records. */
  function fixture(events: DrainedEvent[], seal: (items: readonly { subjectId: string; plaintext: string }[]) => Promise<unknown>) {
    const shipped: DrainedEvent[][] = [];
    const marked: string[][] = [];
    const sealCalls: number[] = [];
    const host = {
      admin: {
        readUndrainedEvents: async () => events,
        sealSubjectPayloads: async (_a: unknown, _t: unknown, _s: unknown, items: readonly { subjectId: string; plaintext: string }[]) => {
          sealCalls.push(items.length);
          return seal(items);
        },
        markEventsDrained: async (_a: unknown, _t: unknown, _s: unknown, ids: string[]) => void marked.push(ids),
      },
    } as unknown as ScopeHost;
    const sink: EventSink = { ship: async (_scope, batch) => (shipped.push(batch), { ref: 'r' }) };
    const drain = () => drainScopeEvents(host, { actor: ulid() as never, sealEventPayloads: true }, sink, { tenantId, scopeId, budget: 200 });
    return { shipped, marked, sealCalls, drain };
  }

  it('seals classified payloads in one call, ships a refused one as null, and leaves the rest', async () => {
    const kept = ulid();
    const erased = ulid();
    const plain = event();
    const events = [
      plain,
      event({ piiClass: 'pseudonymous', subjectId: kept as never, payload: { note: 'theirs' } }),
      event({ piiClass: 'pseudonymous', subjectId: erased as never, payload: { note: 'gone' } }),
      event({ piiClass: 'pseudonymous', subjectId: kept as never, payload: null }),
    ];
    const { shipped, marked, sealCalls, drain } = fixture(events, async (items) =>
      items.map((i) => (i.subjectId === erased ? null : { keyId: `subject:${i.subjectId}`, ciphertext: 'c2VhbGVk' })),
    );
    expect((await drain()).shipped).toBe(4);
    expect(sealCalls).toEqual([2]);
    const [batch] = shipped;
    expect(batch![0]!.payload).toEqual(plain.payload);
    expect(lakeSealedPayload.parse(batch![1]!.payload).__sealed.keyId).toBe(`subject:${kept}`);
    expect(JSON.stringify(batch![1])).not.toContain('theirs');
    expect(batch![2]!.payload).toBeNull();
    expect(batch![3]!.payload).toBeNull();
    // Stamped by id as before: the read's events, all of them.
    expect(marked).toEqual([events.map((e) => e.id)]);
  });

  it('ships nothing and stamps nothing when the seal fails', async () => {
    const { shipped, marked, drain } = fixture(
      [event({ piiClass: 'direct', subjectId: ulid() as never, payload: { email: 'p@example.test' } })],
      async () => {
        throw new Error('the directory is unreachable');
      },
    );
    await expect(drain()).rejects.toThrow('the directory is unreachable');
    expect(shipped).toEqual([]);
    expect(marked).toEqual([]);
  });
});
