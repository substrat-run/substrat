import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  orgId,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type DomainEvent,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid, type HostAdmin, type ScopeHost } from '@substrat-run/kernel';
import { connectorMod } from './modules.js';
import { CAUSED_BY_HOLD, causedByMod, tick, type CausedByHold } from './caused-by-module.js';
import type { ScopeHostFixture } from './scope-host-suite.js';

/**
 * #2055: an executor's admin rows name the event they are the effect of (K-22, `causedBy`),
 * and no other admin row does — in particular not one some other caller writes on the same
 * host while the handler is suspended. The SQLite host used to keep the event in a host-wide
 * field set around the handler's `await`, so a staff call landing in that window was recorded
 * as caused by an event it had nothing to do with.
 *
 * Each door an executor runs through is held here with a staff write landing inside the hold:
 * a plain executor (`registerExecutor`, through the `admin` it is handed), an in-process
 * connector (`registerConnector`, through `ctx.admin`), and a routed connector delivery
 * (`dispatchConnector`). Every case asserts both halves — the staff row carries no cause, and
 * the handler's own row still carries its event — because either alone is also what dropping
 * `causedBy` everywhere looks like.
 */
export function causedByContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`causedBy is per call, never host-wide (#2055): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const staff = platformActorId.parse(ulid());
    const alice = principalId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());

    /** Every handler waits here, after it was entered and before it writes. */
    let gate: Promise<void> = Promise.resolve();
    let release: () => void = () => undefined;
    let entered: Promise<void> = Promise.resolve();
    let enter: () => void = () => undefined;
    const shut = () => {
      gate = new Promise((r) => (release = r));
      entered = new Promise((r) => (enter = r));
    };

    /** The handlers' one write: an org named by the event's tag, so its row is findable. */
    const heldWrite = async (admin: HostAdmin, event: DomainEvent): Promise<void> => {
      enter();
      await gate;
      const tag = (event.payload as { tag: string }).tag;
      await admin.createOrg(staff, { id: orgId.parse(ulid()), tenantId: event.tenantId as TenantId, slug: tag, name: tag });
    };

    const tagOf = (kind: string) => `${kind}-${ulid().slice(-8).toLowerCase()}`;

    /**
     * Start a handler with `start` (handed a fresh tag; answers the id of the event the handler
     * runs for once it is done), make a staff write while it is held, release it, and assert both
     * halves: the staff row carries no cause, the handler's own row carries its event.
     */
    const expectCausedPerCall = async (start: (tag: string) => Promise<string>, kind: string): Promise<void> => {
      shut();
      const tag = tagOf(kind);
      const done = start(tag);
      await entered;
      const staffSlug = tagOf('staff');
      await host.admin.createOrg(staff, { id: orgId.parse(ulid()), tenantId: t, slug: staffSlug, name: staffSlug });
      release();
      const eventId = await done;
      const created = await host.admin.auditLog(staff, { tenantId: t, action: 'createOrg', limit: 500 });
      const causeOf = (slug: string) => created.find((r) => (r.after as { slug?: string } | null)?.slug === slug)?.causedBy;
      expect(causeOf(staffSlug)).toBeNull();
      expect(causeOf(tag)).toBe(eventId);
    };

    /** Invoke `operation` for `tag`; answers the event id the one executor delivered. */
    const invoked = (operation: string) => async (tag: string): Promise<string> => {
      const outcomes: { eventId: string; outcome: string }[] = [];
      await (await host.getScope(alice, t, s)).invoke(operation, { tag }, { onExecutorOutcomes: (o) => outcomes.push(...o) });
      expect(outcomes.map((o) => o.outcome)).toEqual(['delivered']);
      return outcomes[0]!.eventId;
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(connectorMod);
      host.registerExecutor('held-effector', 'effect.requested', (admin, event) => heldWrite(admin, event));
      host.registerConnector('held-caller', 'outbound.requested', (ctx, event) => heldWrite(ctx.admin, event));
      await host.admin.createTenant(staff, { id: t, slug: `caused-${t.slice(-10).toLowerCase()}`, name: 'Caused' });
      await host.admin.grantEntitlement(staff, t, 'connector');
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'connector-vertical' });
      await host.admin.activateScope(staff, t, s);
    });
    afterAll(async () => {
      await fixture.cleanup();
    });

    it('an executor: a staff write while its handler awaits carries no cause; the handler\'s own row carries its event', async () => {
      await expectCausedPerCall(invoked('connector/request-effect'), 'effect');
    });

    it('an in-process connector: the same, through `ctx.admin`', async () => {
      await expectCausedPerCall(invoked('connector/request-outbound'), 'outbound');
    });

    it('a routed connector delivery (`dispatchConnector`): the same', async () => {
      await expectCausedPerCall(async (tag) => {
        const event = { id: ulid(), tenantId: t, type: 'outbound.requested', payload: { tag } } as unknown as DomainEvent;
        await host.dispatchConnector(t, s, (ctx, e) => heldWrite(ctx.admin, e), event);
        return event.id;
      }, 'routed');
    });

    it('two views with two causes, their writes interleaved across awaits: each row carries its own', async () => {
      // A null cause beside a non-null one cannot catch two causes trading places, so both are
      // set here. Both views are made before either's admin is first read (it is built lazily),
      // and each is written through twice.
      const e1 = ulid();
      const e2 = ulid();
      const a = host.attributed!({ principal: alice, tenantId: t }, { causedBy: e1 });
      const b = host.attributed!({ principal: alice, tenantId: t }, { causedBy: e2 });
      const [a1, a2, b1, b2] = [tagOf('a1'), tagOf('a2'), tagOf('b1'), tagOf('b2')];
      const write = (view: ScopeHost, slug: string) =>
        view.admin.createOrg(staff, { id: orgId.parse(ulid()), tenantId: t, slug, name: slug });

      const first = write(a, a1); // A starts…
      await write(b, b1); // …B writes while A's write is in flight…
      await first;
      await write(a, a2); // …A writes again…
      await write(b, b2); // …and B again.

      const created = await host.admin.auditLog(staff, { tenantId: t, action: 'createOrg', limit: 500 });
      const causeOf = (slug: string) => created.find((r) => (r.after as { slug?: string } | null)?.slug === slug)?.causedBy;
      expect([a1, a2, b1, b2].map(causeOf)).toEqual([e1, e1, e2, e2]);
    });
  });
}

/**
 * #2055, the scope's half: what a consumer emits names the event it consumed (#1237), and no
 * other emit in the scope does — in particular not one another call makes while the consumer
 * awaits. Each adapter serializes a scope's emitting work (the SQLite `ScopeActor`, the
 * Durable Object's `OperationQueue`), and the cause is passed into the consumer's context
 * rather than read off a field, so neither guarantee leans on the other.
 *
 * The fixture's host must carry `causedByMod` in the scope it reaches: the suite registers it
 * on the host, and a code-time module set (a Cloudflare ScopeDO's) must already include it.
 */
export function scopeCausedByContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`a consumer's cause stamps its own emits, never another call's (#2055): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const staff = platformActorId.parse(ulid());
    const alice = principalId.parse(ulid());
    const bob = principalId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(causedByMod);
      await host.admin.createTenant(staff, { id: t, slug: `scope-caused-${t.slice(-10).toLowerCase()}`, name: 'Scope caused' });
      await host.admin.grantEntitlement(staff, t, 'causedby');
      await host.provisionScope(staff, { tenantId: t, scopeId: s });
      await host.admin.activateScope(staff, t, s);
    });
    afterAll(async () => {
      delete (globalThis as Record<string, unknown>)[CAUSED_BY_HOLD];
      await fixture.cleanup();
    });

    it('a call emitting while a consumer awaits is caused by nothing; the consumer\'s own emit is caused by its event', async () => {
      const hold: CausedByHold = { shut: true, entered: false };
      (globalThis as Record<string, unknown>)[CAUSED_BY_HOLD] = hold;
      const tag = ulid().slice(-8).toLowerCase();
      const starting = (await host.getScope(alice, t, s)).invoke('causedby/start', { tag });
      while (!hold.entered) await tick();
      // Another caller, the same scope, while the consumer is suspended. Where the scope's
      // work is serialized it waits for the consumer; either way, its event is its own.
      // Not awaited before the release: on a host whose scope work is queued, reaching the
      // scope at all waits for the consumer.
      const other = host.getScope(bob, t, s).then((stub) => stub.invoke('causedby/other', { tag }));
      await tick(20);
      hold.shut = false;
      await Promise.all([starting, other]);

      const events = await host.admin.readUndrainedEvents(staff, t, s, 200);
      const one = (type: string) => {
        const found = events.filter((e) => e.type === type && e.entity.entityId === tag);
        expect(found).toHaveLength(1);
        return found[0]!;
      };
      const requested = one('causedby.requested');
      expect(one('causedby.other').causedBy).toBeNull();
      expect(one('causedby.effected').causedBy).toBe(requested.id);
      expect(requested.causedBy).toBeNull();
    });
  });
}
