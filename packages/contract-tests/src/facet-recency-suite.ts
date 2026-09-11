/**
 * Contract suite for facet recency under an injected clock (#1234).
 *
 * What it pins is one sentence: **a facet bucket's `lastSeen` is the LATEST event
 * in it, not merely one of them.**
 *
 * `scopeHostContractSuite` already proves the field is present and is a real
 * timestamp. What it cannot prove is which one. Two events emitted back to back
 * share an `occurred_at` — `ctx.now()` is stable for an invocation and two
 * invocations land in the same millisecond — so against the wall clock `MIN` and
 * `MAX` return the same string and every assertion passes either way. That is not
 * a hypothetical: this suite exists because the first version of that test was
 * written without a clock, passed, and went on passing when the aggregate was
 * mutated to `MIN`.
 *
 * It matters because recency is the whole point of the field. The flow map (#1234)
 * asks "has this consumer fired lately", and a bucket reporting its FIRST event
 * answers that question wrongly in the one direction that hides a fault: a
 * consumer that ran once a year ago and never again looks freshly active.
 *
 * **Mounted, not flagged** — the same call `grantExpiryContractSuite` makes, and
 * for the same reason. The fixture returns a `ManualClock` the suite moves, so only
 * an adapter that can hand its host a clock can mount it: the pure SQLite host
 * today. A capability flag that skipped on the other adapter would read as coverage
 * the adapter does not have.
 *
 * **Why the Cloudflare adapter does not mount it.** The Durable Object stamps
 * `occurred_at` from a clock it reads inside the DO, which workerd constructs — an
 * option on the host factory never reaches it (`clock?: never`, #956). The DO runs
 * the same `MAX(occurred_at)` aggregate from the same kernel helper, so the SQL
 * under test is shared; what cannot be arranged there is the passage of time. The
 * day the DO can take a clock, mounting this suite is the whole change.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId, type PrincipalId } from '@substrat-run/contracts';
import { ulid, type ManualClock, type ScopeHost } from '@substrat-run/kernel';
import { contractTestBareOps, testMod } from './modules.js';

/**
 * What the fixture hands the suite. `clock` is the SAME `ManualClock` the host was
 * constructed with — the suite moves it and expects the events to be stamped from it.
 * A fixture built on a different clock would emit every event at the wall time, and
 * the suite would fail exactly where it is supposed to.
 */
export interface FacetRecencyFixture {
  host: ScopeHost;
  clock: ManualClock;
  cleanup: () => Promise<void>;
}

const START = '2026-04-01T08:00:00.000Z';
const DAY = 86_400_000;

export function facetRecencyContractSuite(
  adapterName: string,
  makeFixture: () => Promise<FacetRecencyFixture>,
): void {
  describe(`facet recency under an injected clock: ${adapterName}`, () => {
    let fixture: FacetRecencyFixture;
    let host: ScopeHost;
    let clock: ManualClock;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    const at = (ms: number) => new Date(Date.parse(START) + ms).toISOString();

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      clock = fixture.clock;
      clock.set(START);
      for (const [name, handler] of Object.entries(contractTestBareOps)) {
        host.defineOperation(name, handler);
      }
      host.registerModule(testMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'recency-tenant', name: 'Recency Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'testmod');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'recency-vertical' });
      await host.admin.activateScope(staff, t1, s1);

      // Three events of one type, each a day apart on the host's clock.
      const stub = await host.getScope(alice, t1, s1);
      for (const day of [0, 1, 2]) {
        clock.set(at(day * DAY));
        await stub.invoke('test/emit-event');
      }
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('reports the LATEST event in a bucket, not the first', async () => {
      const facet = await host.admin.facetEvents(staff, t1, s1, { groupBy: { kind: 'type' } });
      const bucket = facet.buckets.find((b) => b.value === 'test.happened')!;
      expect(bucket.count).toBe(3);
      // The assertion the wall clock cannot make. `MIN` would answer day 0 here, and
      // a consumer that stopped two days ago would read as one that just ran.
      expect(bucket.lastSeen).toBe(at(2 * DAY));
    });

    it('moves with the window it was asked about, rather than reporting all of history', async () => {
      // `until` is exclusive, so this asks about days 0 and 1 only — and recency has
      // to be the latest of THOSE. A bucket that carried its all-time maximum through
      // a narrowed window would report an event the caller deliberately excluded.
      const earlier = await host.admin.facetEvents(staff, t1, s1, {
        groupBy: { kind: 'type' },
        until: at(2 * DAY),
      });
      const bucket = earlier.buckets.find((b) => b.value === 'test.happened')!;
      expect(bucket.count).toBe(2);
      expect(bucket.lastSeen).toBe(at(DAY));
    });

    it('answers recency for a payload grouping too, where erased rows are excluded', async () => {
      const facet = await host.admin.facetEvents(staff, t1, s1, {
        groupBy: { kind: 'payload', field: 'nothing-here' },
        type: 'test.happened',
      });
      // Every event lands in the extraction-null bucket, and its recency is still the
      // latest of them — the payload branch runs its own query, so it needs its own
      // proof rather than inheriting the envelope branch's.
      const bucket = facet.buckets.find((b) => b.value === null)!;
      expect(bucket.count).toBe(3);
      expect(bucket.lastSeen).toBe(at(2 * DAY));
    });
  });
}
