import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  errorCodeOf,
  eventId,
  platformActorId,
  scopeId as scopeIdSchema,
  tenantId,
  type DeadLettersInput,
  type EntityHistoryInput,
  type EventCauseInput,
  type EventEffectsInput,
  type EventFacetInput,
  type InvocationEventsInput,
  type LifecycleFlowInput,
  type OperationSeriesInput,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { scopeNotHeldRefusal, ulid } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { TEST_LIFECYCLE } from './modules.js';

/** The introspection reads a vertical's `/internal/*` routes make by scope id alone (#2544). */
export interface IntrospectionReads {
  facetEventsLocal(scopeId: ScopeId, input: EventFacetInput): Promise<unknown>;
  eventEffectsLocal(scopeId: ScopeId, input: EventEffectsInput): Promise<unknown>;
  invocationEventsLocal(scopeId: ScopeId, input: InvocationEventsInput): Promise<unknown>;
  deadLettersLocal(scopeId: ScopeId, input: DeadLettersInput): Promise<unknown>;
  lifecycleFlowLocal(scopeId: ScopeId, input: LifecycleFlowInput): Promise<unknown>;
  operationSeriesLocal(scopeId: ScopeId, input: OperationSeriesInput): Promise<unknown>;
  eventCauseLocal(scopeId: ScopeId, input: EventCauseInput): Promise<unknown>;
  entityHistoryLocal(scopeId: ScopeId, input: EntityHistoryInput): Promise<unknown>;
  appliedMigrationsLocal(scopeId: ScopeId): Promise<unknown>;
  migrationBookmarksLocal(scopeId: ScopeId): Promise<unknown>;
  introspectScopeTables(scopeId: ScopeId): Promise<unknown>;
  undrainedEventsLocal(scopeId: ScopeId, limit: number): Promise<unknown>;
  redrainCountLocal(scopeId: ScopeId, drainedBefore: string): Promise<unknown>;
}

/** A host's introspection reads, bound, for a fixture to hand the suite. */
export const introspectionReadsOf = (host: IntrospectionReads): IntrospectionReads => ({
  facetEventsLocal: (s, i) => host.facetEventsLocal(s, i),
  eventEffectsLocal: (s, i) => host.eventEffectsLocal(s, i),
  invocationEventsLocal: (s, i) => host.invocationEventsLocal(s, i),
  deadLettersLocal: (s, i) => host.deadLettersLocal(s, i),
  lifecycleFlowLocal: (s, i) => host.lifecycleFlowLocal(s, i),
  operationSeriesLocal: (s, i) => host.operationSeriesLocal(s, i),
  eventCauseLocal: (s, i) => host.eventCauseLocal(s, i),
  entityHistoryLocal: (s, i) => host.entityHistoryLocal(s, i),
  appliedMigrationsLocal: (s) => host.appliedMigrationsLocal(s),
  migrationBookmarksLocal: (s) => host.migrationBookmarksLocal(s),
  introspectScopeTables: (s) => host.introspectScopeTables(s),
  undrainedEventsLocal: (s, n) => host.undrainedEventsLocal(s, n),
  redrainCountLocal: (s, b) => host.redrainCountLocal(s, b),
});

/** One valid call of each read, for a suite that asks every one of them the same question. */
export function introspectionReadCalls(r: IntrospectionReads): Record<keyof IntrospectionReads, (s: ScopeId) => Promise<unknown>> {
  const window = () => {
    const since = Math.floor(Date.now() / 1000) * 1000;
    return { since: new Date(since - 60_000).toISOString(), until: new Date(since + 60_000).toISOString() };
  };
  return {
    facetEventsLocal: (s) => r.facetEventsLocal(s, { groupBy: { kind: 'type' } }),
    eventEffectsLocal: (s) => r.eventEffectsLocal(s, { eventId: eventId.parse(ulid()) }),
    invocationEventsLocal: (s) => r.invocationEventsLocal(s, { invocationId: ulid() }),
    deadLettersLocal: (s) => r.deadLettersLocal(s, {}),
    lifecycleFlowLocal: (s) =>
      r.lifecycleFlowLocal(s, { entityType: 'test-lifecycle', lifecycle: TEST_LIFECYCLE, ...window() }),
    operationSeriesLocal: (s) =>
      r.operationSeriesLocal(s, {
        moves: [{ entityType: 'test-lifecycle', operation: 'test/move' }],
        bucketMinutes: 1,
        ...window(),
      }),
    eventCauseLocal: (s) => r.eventCauseLocal(s, { eventId: eventId.parse(ulid()) }),
    entityHistoryLocal: (s) => r.entityHistoryLocal(s, { entityType: 'test-thing', entityId: 'x1' }),
    appliedMigrationsLocal: (s) => r.appliedMigrationsLocal(s),
    migrationBookmarksLocal: (s) => r.migrationBookmarksLocal(s),
    introspectScopeTables: (s) => r.introspectScopeTables(s),
    undrainedEventsLocal: (s) => r.undrainedEventsLocal(s, 10),
    redrainCountLocal: (s) => r.redrainCountLocal(s, new Date().toISOString()),
  };
}

/**
 * The introspection reads that name only a scope id hold the scope before they read it (#2544), as
 * the size reads do (#2541): a scope this deployment does not hold (reaped, or never provisioned
 * here) is refused `conflict` with one sentence, never answered as an empty store, and a refusal
 * creates no store. A held scope still reads. One case per read, on both adapters.
 */
export function introspectionReadsContractSuite(
  adapterName: string,
  makeFixture: () => Promise<
    ScopeHostFixture &
      IntrospectionReads & {
        /** Whether the scope's store holds nothing, as `sizeReadsContractSuite` asks. */
        storeHoldsNothing(tenantId: TenantId, scopeId: ScopeId): Promise<boolean>;
      }
  >,
): void {
  describe(`introspection reads refuse a scope the deployment does not hold (#2544): ${adapterName}`, () => {
    let fixture: Awaited<ReturnType<typeof makeFixture>>;
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      await fixture.host.admin.createTenant(staff, { id: t, slug: `introspect-${t.slice(-8).toLowerCase()}`, name: 'Introspection' });
    });
    afterAll(async () => fixture?.cleanup());

    const newScope = async (): Promise<ScopeId> => {
      const s = scopeIdSchema.parse(ulid());
      await fixture.host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'introspect' });
      await fixture.host.admin.activateScope(staff, t, s);
      return s;
    };
    const reap = async (s: ScopeId): Promise<void> => {
      await fixture.host.admin.archiveScope(staff, t, s);
      await fixture.host.admin.reapScope(staff, t, s, { force: true });
    };
    const refusal = (p: Promise<unknown>) =>
      p.then(
        () => undefined,
        (e: unknown) => ({ code: errorCodeOf(e), message: (e as Error).message }),
      );
    const refusedAs = (s: ScopeId) => ({ code: 'conflict', message: scopeNotHeldRefusal(s) });

    // The calls are built before the fixture is (they name the cases), so each one reaches it late.
    const lazy = new Proxy({} as IntrospectionReads, {
      get: (_target, name: string) => (...args: unknown[]) =>
        (fixture as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!(...args),
    });
    const reads = introspectionReadCalls(lazy);

    describe.each(Object.entries(reads))('%s', (_name, read) => {
      it('reads a held scope, and answers something', async () => {
        const s = await newScope();
        expect(await read(s)).not.toBeNull();
        expect(await read(s)).toBeDefined();
      });

      it('refuses a reaped scope, in the shared words, and leaves nothing stored for it', async () => {
        const s = await newScope();
        await reap(s);
        expect(await refusal(read(s))).toEqual(refusedAs(s));
        // Asked again, it is still refused: the first refusal did not make the scope held.
        expect(await refusal(read(s))).toEqual(refusedAs(s));
        expect(await fixture.storeHoldsNothing(t, s)).toBe(true);
      });

      it('refuses an id nothing provisioned here, and leaves nothing stored for it', async () => {
        const s = scopeIdSchema.parse(ulid());
        expect(await refusal(read(s))).toEqual(refusedAs(s));
        expect(await fixture.storeHoldsNothing(t, s)).toBe(true);
      });
    });

    it('a scope listed as active and reaped before it is read is refused, while the held one beside it reads', async () => {
      const [gone, kept] = [await newScope(), await newScope()];
      const due = (await fixture.host.admin.listScopes(staff, { tenantId: t, status: 'active' })).map((x) => x.id);
      expect(due).toEqual(expect.arrayContaining([gone, kept]));
      await reap(gone);
      expect(await refusal(fixture.undrainedEventsLocal(gone, 10))).toEqual(refusedAs(gone));
      expect(await refusal(fixture.undrainedEventsLocal(kept, 10))).toBeUndefined();
    });
  });
}
