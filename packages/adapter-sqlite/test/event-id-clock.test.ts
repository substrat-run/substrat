/**
 * An event's id is minted from the operation's instant, not the wall clock (#956).
 *
 * `occurredAt` has always been the injected instant, but the id beside it came from
 * a bare `ulid()` — i.e. `Date.now()`. The two disagreeing is not cosmetic: the
 * outbox, `readTimeline`/`readHistory` and `ctx.versionOf` all page by `ORDER BY id`
 * and treat the id AS the cursor, so the log was ordered by a clock nothing else in
 * the operation used. Under a scripted clock the disagreement is total.
 *
 * Lives beside `grant-expiry-clock.test.ts` and for the same reason: it is a fact
 * about a host that can be handed a clock, and the DO adapter has no clock option
 * yet — a shared contract suite would be red rather than covering.
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

describe('an event id carries the operation instant (#956)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let clock: ManualClock;
  const t1 = tenantId.parse(ulid());
  const s1 = scopeId.parse(ulid());
  const anna: PrincipalId = principalId.parse(ulid());
  const staff = platformActorId.parse(ulid());

  /** The scripted clock sits well BEHIND the wall clock — the case a shared
   *  process-wide monotonic floor used to silently drag forward. */
  const START = '2026-01-02T03:04:05.000Z';

  const emitAndRead = async (): Promise<OutboxRow> => {
    const stub = await host.getScope(anna, t1, s1);
    await stub.invoke('test/emit-event');
    const rows = await stub.invoke<OutboxRow[]>('test/read-outbox');
    return rows[rows.length - 1]!;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-event-id-clock-'));
    clock = manualClock(START);
    host = new SqliteScopeHost({ dir, clock: clock.read });
    // `test/emit-event` and `test/read-outbox` are bare ops, not testMod's — the
    // module is here because a scope wants one, the ops because they are the
    // shortest emit-then-read pair the contract fixtures already carry.
    for (const [name, handler] of Object.entries(contractTestBareOps)) {
      host.defineOperation(name, handler);
    }
    host.registerModule(testMod);
    await host.admin.createTenant(staff, { id: t1, slug: 'clock-tenant', name: 'Clock' });
    await host.admin.grantEntitlement(staff, t1, 'testmod');
    await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'clock-vertical' });
    await host.admin.activateScope(staff, t1, s1);
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stamps the id with occurredAt, not Date.now()', async () => {
    const row = await emitAndRead();

    expect(row.occurred_at).toBe(START);
    expect(ulidTime(row.id)).toBe(Date.parse(START));
    // The assertion that would have passed on a wall-clock id and says nothing:
    // spelled out so the one above cannot be "fixed" into it.
    expect(ulidTime(row.id)).not.toBe(ulidTime(ulid()));
  });

  it('follows the clock when it moves, so ids sort the way occurredAt does', async () => {
    const first = await emitAndRead();
    clock.advance(60 * 60_000);
    const second = await emitAndRead();

    expect(ulidTime(second.id) - ulidTime(first.id)).toBe(60 * 60_000);
    // Lexical id order IS the outbox's order, and it now agrees with the instants.
    expect(second.id > first.id).toBe(true);
    expect(Date.parse(second.occurred_at)).toBeGreaterThan(Date.parse(first.occurred_at));
  });

  it('never lets an id go backwards, even when the clock does', async () => {
    const first = await emitAndRead();
    clock.set('2020-01-01T00:00:00.000Z');
    const second = await emitAndRead();

    // The ULID monotonic floor still applies: `ORDER BY id` is the outbox's cursor,
    // so a rewound clock must not bury a newer row underneath an older one. The id
    // holds at the previous instant rather than following the clock down.
    expect(second.id > first.id).toBe(true);
    expect(ulidTime(second.id)).toBe(ulidTime(first.id));
    // `occurredAt` is not floored — it reports what the clock actually said.
    expect(second.occurred_at).toBe('2020-01-01T00:00:00.000Z');
  });

  it('names the clock when the instant cannot be an id at all', async () => {
    // `instant` accepts a pre-1970 value, so a host can genuinely be handed one,
    // and a ULID's timestamp is 48 UNSIGNED bits — there is nothing to encode it
    // as. This is the one case the monotonic floor cannot absorb, because there is
    // no floor yet: the pre-epoch instant is the first thing this host stamps.
    //
    // Either way the outbox stays clean — `eventId` refuses a malformed id, so the
    // emit already failed before #956. What the mint adds is the REASON: a
    // RangeError naming the instant, rather than a schema complaining about the
    // shape of a string of `undefined`s that says nothing about the clock.
    clock.set('1969-12-31T23:59:59.999Z');
    const preDir = mkdtempSync(join(tmpdir(), 'substrat-pre-epoch-'));
    const pre = new SqliteScopeHost({ dir: preDir, clock: clock.read });
    try {
      for (const [name, handler] of Object.entries(contractTestBareOps)) pre.defineOperation(name, handler);
      pre.registerModule(testMod);
      await pre.admin.createTenant(staff, { id: t1, slug: 'pre-epoch', name: 'Pre' });
      await pre.admin.grantEntitlement(staff, t1, 'testmod');
      await pre.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'clock-vertical' });
      await pre.admin.activateScope(staff, t1, s1);

      const stub = await pre.getScope(anna, t1, s1);
      await expect(stub.invoke('test/emit-event')).rejects.toThrow(/not an encodable ULID instant/);

      // The failed emit took its row with it, so nothing unreadable was stored.
      const rows = await stub.invoke<OutboxRow[]>('test/read-outbox');
      for (const row of rows) expect(() => ulidTime(row.id)).not.toThrow();
    } finally {
      await pre.close();
      rmSync(preDir, { recursive: true, force: true });
    }
  });
});
