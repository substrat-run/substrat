/**
 * The event-id floor outlives the mint that held it (#1335).
 *
 * #956 gave the mint a monotonic floor, and `event-id-clock.test.ts` beside this one
 * covers what that buys WITHIN one host's life. The floor was a field on the host
 * object, so it was only as old as the mint: `close()` and reopen the same directory
 * with the clock behind where it had got to, and the next id sorted UNDERNEATH rows
 * that were already stored — which a reader paging `id > <last seen>` is never handed.
 *
 * The fix is to seed the floor from the outbox rather than from the clock, per scope,
 * when the scope's runtime is built. That is a fact about a host you can hand a clock,
 * which the DO adapter is not (see `event-id-clock.test.ts`'s header), so it is tested
 * here rather than in a shared contract suite. The DO's half of the same fix is its
 * constructor: one DO is one scope, and every eviction runs the constructor again.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { principalId, scopeId, tenantId, platformActorId, type PrincipalId } from '@substrat-run/contracts';
import { manualClock, ulid, ulidTime, type ManualClock } from '@substrat-run/kernel';
import { contractTestBareOps, testMod } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

interface OutboxRow {
  id: string;
  occurred_at: string;
}

describe('the event-id floor survives a restart (#1335)', () => {
  let dir: string;
  let clock: ManualClock;
  let host: SqliteScopeHost;
  const t1 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const s2 = scopeId.parse(ulid());
  const anna: PrincipalId = principalId.parse(ulid());
  const staff = platformActorId.parse(ulid());

  const START = '2026-01-02T03:04:05.000Z';
  /** Where the reproduction in the issue puts the clock on the second run. */
  const REWOUND = '2025-06-01T00:00:00.000Z';

  /** A host over the SAME directory — a restart, not a second world. */
  const open = (): SqliteScopeHost => {
    const opened = new SqliteScopeHost({ dir, clock: clock.read });
    for (const [name, handler] of Object.entries(contractTestBareOps)) {
      opened.defineOperation(name, handler);
    }
    opened.registerModule(testMod);
    return opened;
  };

  const emitInto = async (scope: typeof s1): Promise<OutboxRow> => {
    const stub = await host.getScope(anna, t1, scope);
    await stub.invoke('test/emit-event');
    const rows = await stub.invoke<OutboxRow[]>('test/read-outbox');
    return rows[rows.length - 1]!;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-event-id-floor-'));
    clock = manualClock(START);
    host = open();
    await host.admin.createTenant(staff, { id: t1, slug: 'floor-tenant', name: 'Floor' });
    await host.admin.grantEntitlement(staff, t1, 'testmod');
    for (const scope of [s1, s2]) {
      await host.provisionScope(staff, { tenantId: t1, scopeId: scope, vertical: 'floor-vertical' });
      await host.admin.activateScope(staff, t1, scope);
    }
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('mints above the persisted maximum after a close/reopen with a rewound clock', async () => {
    const before = await emitInto(s1);
    await host.close();

    clock.set(REWOUND);
    host = open();
    const after = await emitInto(s1);

    // `ORDER BY id` is the outbox's cursor, so this is the whole claim: a reader that
    // stopped at `before` is handed `after` on its next page.
    expect(after.id > before.id).toBe(true);
    // The floor held at the persisted instant rather than following the clock down,
    // exactly as it does for a rewind inside one host's life.
    expect(ulidTime(after.id)).toBe(Date.parse(START));
    // `occurredAt` is not floored — it still reports what the clock actually said.
    expect(after.occurred_at).toBe(REWOUND);
  });

  it('keeps the rows in `ORDER BY id` the order they were written in', async () => {
    // The reader's view, rather than a comparison of two ids: the reproduction in
    // the issue is that the NEW row comes back first.
    const first = await emitInto(s1);
    await host.close();
    clock.set(REWOUND);
    host = open();
    await emitInto(s1);

    const stub = await host.getScope(anna, t1, s1);
    const rows = await stub.invoke<OutboxRow[]>('test/read-outbox');
    expect(rows.map((r) => r.occurred_at)).toEqual([START, REWOUND]);
    expect(rows[0]!.id).toBe(first.id);
  });

  it('seeds each scope from its own outbox, not from a sibling that ran later', async () => {
    // The floor is per scope because the ordering is: `ORDER BY id` is an ordering
    // over ONE outbox. A host-wide floor would drag a quiet scope's first id forward
    // to whatever the busiest scope last stamped, and its ids would then disagree
    // with their own `occurredAt` for no reason anybody reading them could see.
    clock.set('2026-06-01T00:00:00.000Z');
    const busy = await emitInto(s1);

    clock.set(START); // behind the sibling, but s2 has stored nothing at all
    const quiet = await emitInto(s2);

    expect(ulidTime(quiet.id)).toBe(Date.parse(START));
    expect(quiet.id < busy.id).toBe(true);
    expect(quiet.occurred_at).toBe(START);
  });

  it('carries a scope its own floor across a restart, without the sibling', async () => {
    clock.set('2026-06-01T00:00:00.000Z');
    const busy = await emitInto(s1);
    await host.close();

    clock.set(REWOUND);
    host = open();
    // s2 is untouched, so it has no floor to inherit and stamps the rewound clock.
    const fresh = await emitInto(s2);
    expect(ulidTime(fresh.id)).toBe(Date.parse(REWOUND));
    // s1 does have one, read back from its own rows.
    const resumed = await emitInto(s1);
    expect(resumed.id > busy.id).toBe(true);
  });
});
