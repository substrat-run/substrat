/**
 * Contract suite for impersonation — acting as a principal with the real actor
 * preserved (K-42, #868).
 *
 * What it pins is one sentence: **the permission model answers as the
 * impersonated principal, and every record keeps both actors.** Half of that is
 * easy to get right and half of it is easy to get subtly wrong, and the ones
 * that go wrong quietly are the ones this suite is mostly about.
 *
 * Four properties, and why each has to be a behavioural test rather than a note:
 *
 * 1. **The authority is the impersonated principal's, resolved the ordinary
 *    way.** A door that grants authority by opening is a door nobody can audit,
 *    so the assertion is that a session against a principal who holds NOTHING is
 *    refused exactly as that principal would be — with the denial recorded, and
 *    recorded against both actors.
 *
 * 2. **The stamp cannot be supplied or suppressed by module code.** It is absent
 *    from `DomainEventInput`, which is a compile-time fact; what a test can show
 *    is the runtime half — the same operation, invoked through the ordinary door,
 *    writes a null stamp, and through the impersonation door writes both actors,
 *    with nothing about the handler differing.
 *
 * 3. **Read-only is a mechanism, not a promise.** The test that matters is the
 *    one where the handler never calls an effecting verb at all: it writes a row
 *    with plain `ctx.sql.exec`. An adapter that only refused `ctx.emit` passes
 *    every other case here and commits that row.
 *
 * 4. **The time box is checked per invoke, not per stub.** A stub is a
 *    capability and nothing takes it away, so a session validated only at the
 *    door expires for everyone except the one caller holding it. `endImpersonation`
 *    is the same property from the other side.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  IMPERSONATION_MAX_MINUTES,
  type ImpersonationSession,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { impersonationEchoMod, permMod } from './modules.js';

const PERM_USE = permissionKey.parse('perm:use');

interface OutboxRow {
  type: string;
  authorization: string | null;
  impersonation: string | null;
}

interface DenialRow {
  actor: string;
  permission: string;
  operation: string | null;
  impersonation: string | null;
}

interface EchoRow {
  event_id: string;
  impersonation: string | null;
}

interface IntentRow {
  kind: string;
  requested_by: string;
  impersonation: string | null;
}

export function impersonationContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`impersonation (K-42): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid()) as TenantId;
    /** Holds `perm:use` through a role — the person support is helping. */
    const anna: PrincipalId = principalId.parse(ulid());
    /** Holds nothing at all — the lever that proves the door grants no authority. */
    const nobody: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    /**
     * A FRESH scope per test. These assertions are about what a whole session
     * left behind — rows, outbox, denials, intents — so a scope carrying another
     * test's writes would make every count ambiguous.
     */
    const freshScope = async (): Promise<ScopeId> => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t1, scopeId: s, vertical: 'imp-vertical' });
      await host.admin.activateScope(staff, t1, s);
      return s;
    };

    const openSession = async (
      scope: ScopeId,
      overrides: Partial<{ principal: PrincipalId; mode: 'read-only' | 'write'; minutes: number }> = {},
    ): Promise<ImpersonationSession> =>
      host.admin.beginImpersonation(staff, {
        tenantId: t1,
        scopeId: scope,
        principal: overrides.principal ?? anna,
        reason: 'ticket #4182 — the invoice screen is empty',
        ...(overrides.mode ? { mode: overrides.mode } : {}),
        ...(overrides.minutes ? { minutes: overrides.minutes } : {}),
      });

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(permMod);
      // K-42: the read-back half of the stamp — see the test that reads `imp-echo/seen`.
      host.registerModule(impersonationEchoMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'imp-tenant', name: 'Imp Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'perm');
      await host.admin.grantEntitlement(staff, t1, 'imp-echo');
      await host.admin.defineRole(staff, t1, {
        key: 'imp-user',
        permissions: [PERM_USE],
        source: 'vertical',
      });
      await host.admin.assignRole(staff, {
        principalId: anna,
        roleKey: 'imp-user',
        node: { tenantId: t1, scopeId: null },
      });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    // -- the session record ---------------------------------------------------

    describe('a session is bounded, reason-carrying and recorded before it is usable', () => {
      it('records the staff actor, the principal, the reason and an expiry', async () => {
        const scope = await freshScope();
        const session = await openSession(scope);
        expect(session.actor).toBe(staff);
        expect(session.principal).toBe(anna);
        expect(session.tenantId).toBe(t1);
        expect(session.scopeId).toBe(scope);
        expect(session.reason).toContain('#4182');
        expect(session.endedAt).toBeNull();
        expect(session.expiresAt > session.startedAt).toBe(true);
      });

      it('is read-only unless the caller asked for otherwise', async () => {
        const scope = await freshScope();
        expect((await openSession(scope)).mode).toBe('read-only');
        expect((await openSession(scope, { mode: 'write' })).mode).toBe('write');
      });

      it('refuses a session with no real reason', async () => {
        const scope = await freshScope();
        await expect(
          host.admin.beginImpersonation(staff, {
            tenantId: t1,
            scopeId: scope,
            principal: anna,
            reason: 'x',
          }),
        ).rejects.toThrow();
      });

      /**
       * REFUSED, not clamped. A caller silently handed a shorter session than it
       * asked for believes it has one that is still open, which is the failure a
       * time box exists to prevent, arrived at through the time box.
       */
      it('refuses an ask beyond the ceiling rather than shortening it', async () => {
        const scope = await freshScope();
        await expect(
          openSession(scope, { minutes: IMPERSONATION_MAX_MINUTES + 1 }),
        ).rejects.toThrow();
      });

      it('refuses a scope that does not exist — a session for nothing is not issued', async () => {
        await expect(
          host.admin.beginImpersonation(staff, {
            tenantId: t1,
            scopeId: scopeId.parse(ulid()),
            principal: anna,
            reason: 'a scope that was never provisioned',
          }),
        ).rejects.toThrow();
      });

      /**
       * The admin-log entry PRECEDES the session being usable (K-33's failure
       * ordering). Asserted by reading the log immediately after `begin` and
       * before any invoke: if the row were written afterwards, or on first use,
       * this is empty.
       */
      it('is in the admin log before a single operation has run', async () => {
        const scope = await freshScope();
        const session = await openSession(scope);
        const log = await host.admin.auditLog(staff, { tenantId: t1, scopeId: scope });
        const entry = log.find((e) => e.action === 'beginImpersonation');
        expect(entry).toBeDefined();
        expect(entry!.actor).toBe(staff);
        // The reason is IN the record — a log saying a session opened but not why
        // is half a record, and the half an incident review reads is the why.
        expect(JSON.stringify(entry!.after)).toContain(session.reason);
      });

      it('reads back through the session log, and closes explicitly', async () => {
        const scope = await freshScope();
        const session = await openSession(scope);
        const open = await host.admin.listImpersonations(staff, { scopeId: scope, active: true });
        expect(open.map((s) => s.id)).toContain(session.id);

        const ended = await host.admin.endImpersonation(staff, session.id);
        expect(ended.endedAt).not.toBeNull();
        // Idempotent: stopping a stopped session is not an error, and does not
        // move the moment it stopped.
        expect((await host.admin.endImpersonation(staff, session.id)).endedAt).toBe(ended.endedAt);
        const stillOpen = await host.admin.listImpersonations(staff, { scopeId: scope, active: true });
        expect(stillOpen.map((s) => s.id)).not.toContain(session.id);
      });
    });

    // -- the authority --------------------------------------------------------

    describe('the permission model answers about the IMPERSONATED principal', () => {
      it('runs as that principal — `ctx.principal` is never the staff actor', async () => {
        const scope = await freshScope();
        const session = await openSession(scope);
        const stub = await host.getImpersonatedScope(session.id, t1, scope);
        await expect(stub.invoke('perm/whoami')).resolves.toBe(anna);
      });

      /**
       * The door grants NOTHING. A session against a principal who holds no
       * permission is refused exactly as that principal is — which is what makes
       * "see what they see" true rather than "see everything, as them".
       */
      it('is refused wherever the impersonated principal would be refused', async () => {
        const scope = await freshScope();
        const session = await openSession(scope, { principal: nobody, mode: 'write' });
        const stub = await host.getImpersonatedScope(session.id, t1, scope);
        await expect(stub.invoke('perm/write-note', { note: 'nope' })).rejects.toThrow(
          /permission denied/,
        );
      });

      it('records that denial against BOTH actors', async () => {
        const scope = await freshScope();
        const session = await openSession(scope, { principal: nobody, mode: 'write' });
        const stub = await host.getImpersonatedScope(session.id, t1, scope);
        await expect(stub.invoke('perm/write-note', { note: 'nope' })).rejects.toThrow();

        // Read as a principal who may: the denial log is scope-local spine.
        const asAnna = await host.getScope(anna, t1, scope);
        const denials = await asAnna.invoke<DenialRow[]>('perm/read-denials');
        expect(denials).toHaveLength(1);
        expect(JSON.parse(denials[0]!.actor)).toBe(nobody);
        expect(denials[0]!.impersonation).not.toBeNull();
        expect(JSON.parse(denials[0]!.impersonation!)).toEqual({
          session: session.id,
          by: staff,
        });
      });
    });

    // -- the stamp ------------------------------------------------------------

    describe('every record keeps both actors', () => {
      it('stamps the emitted event with the session and the staff actor', async () => {
        const scope = await freshScope();
        const session = await openSession(scope, { mode: 'write' });
        const stub = await host.getImpersonatedScope(session.id, t1, scope);
        await stub.invoke('perm/authorized-emit', { permission: PERM_USE });

        const asAnna = await host.getScope(anna, t1, scope);
        const outbox = await asAnna.invoke<OutboxRow[]>('perm/read-outbox');
        const acted = outbox.find((e) => e.type === 'perm.acted');
        expect(acted).toBeDefined();
        // The envelope's own `actor` stays the principal — K-34's authorization is
        // untouched, and the domain fact is still theirs.
        expect(JSON.parse(acted!.authorization!)).toEqual([{ permission: PERM_USE }]);
        expect(JSON.parse(acted!.impersonation!)).toEqual({ session: session.id, by: staff });
      });

      /**
       * The other half of "module code can neither supply it nor suppress it".
       * The SAME operation through the ordinary door writes a null stamp — so a
       * stamp is evidence of a session, never a default an adapter fills in.
       */
      it('writes no stamp when nobody is impersonating', async () => {
        const scope = await freshScope();
        const stub = await host.getScope(anna, t1, scope);
        await stub.invoke('perm/authorized-emit', { permission: PERM_USE });
        const outbox = await stub.invoke<OutboxRow[]>('perm/read-outbox');
        expect(outbox.find((e) => e.type === 'perm.acted')!.impersonation).toBeNull();
      });

      /**
       * The stamp is written by `ctx.emit` and read back by whatever turns a stored
       * outbox row into a `DomainEvent`. Those are two different pieces of code in
       * both adapters, and the tests above only exercise the first: they read the
       * row with SQL. An adapter that stores the column and drops it on the way out
       * passes every one of them while handing its consumers — and its executors,
       * which is how an outbound effect gets made — an event with no administrative
       * actor on it at all.
       */
      it('keeps the stamp on the event a CONSUMER receives, not only on the row', async () => {
        const scope = await freshScope();
        const session = await openSession(scope, { mode: 'write' });
        const stub = await host.getImpersonatedScope(session.id, t1, scope);
        await stub.invoke('perm/authorized-emit', { permission: PERM_USE });

        const asAnna = await host.getScope(anna, t1, scope);
        const seen = await asAnna.invoke<EchoRow[]>('imp-echo/seen');
        expect(seen).toHaveLength(1);
        expect(JSON.parse(seen[0]!.impersonation!)).toEqual({ session: session.id, by: staff });
      });

      /** And the null half, on the same reasoning as `writes no stamp when nobody is
       *  impersonating`: a stamp on the delivered event is evidence of a session. */
      it('delivers no stamp to a consumer when nobody is impersonating', async () => {
        const scope = await freshScope();
        const stub = await host.getScope(anna, t1, scope);
        await stub.invoke('perm/authorized-emit', { permission: PERM_USE });
        const seen = await stub.invoke<EchoRow[]>('imp-echo/seen');
        expect(seen).toHaveLength(1);
        expect(seen[0]!.impersonation).toBeNull();
      });

      it('stamps a platform intent the session raised', async () => {
        const scope = await freshScope();
        const session = await openSession(scope, { mode: 'write' });
        const stub = await host.getImpersonatedScope(session.id, t1, scope);
        await stub.invoke('perm/request-intent', { kind: 'test.impersonated' });

        const asAnna = await host.getScope(anna, t1, scope);
        const intents = await asAnna.invoke<IntentRow[]>('perm/read-intents');
        expect(intents).toHaveLength(1);
        // `requested_by` is the principal, as it always was; the staff actor is
        // the fact a drain operator could not otherwise recover.
        expect(JSON.parse(intents[0]!.requested_by)).toBe(anna);
        expect(JSON.parse(intents[0]!.impersonation!)).toEqual({ session: session.id, by: staff });
      });
    });

    // -- read-only ------------------------------------------------------------

    describe('a read-only session cannot write, mechanically', () => {
      it('refuses the effecting verbs by name', async () => {
        const scope = await freshScope();
        const session = await openSession(scope);
        const stub = await host.getImpersonatedScope(session.id, t1, scope);
        await expect(stub.invoke('perm/authorized-emit', { permission: PERM_USE })).rejects.toThrow(
          /read-only impersonation session/,
        );
        await expect(
          stub.invoke('perm/request-intent', { kind: 'test.refused' }),
        ).rejects.toThrow(/read-only impersonation session/);
      });

      /**
       * THE test. The handler calls no effecting verb at all — it writes a row
       * with plain `ctx.sql.exec`, which is what most of a vertical's code does.
       * An adapter that enforced read-only by refusing `ctx.emit` alone passes
       * every other case in this suite and commits this row.
       */
      it('discards a row written with plain SQL — the transaction never commits', async () => {
        const scope = await freshScope();
        const session = await openSession(scope);
        const stub = await host.getImpersonatedScope(session.id, t1, scope);
        // It SUCCEEDS: the operation ran, the read it performed is the answer, and
        // the caller gets it back. What does not survive is the write.
        await expect(stub.invoke('perm/write-note', { note: 'support was here' })).resolves.toEqual({
          wrote: 'support was here',
        });
        const asAnna = await host.getScope(anna, t1, scope);
        await expect(asAnna.invoke<string[]>('perm/read-notes')).resolves.toEqual([]);
      });

      it('still answers reads', async () => {
        const scope = await freshScope();
        const asAnna = await host.getScope(anna, t1, scope);
        await asAnna.invoke('perm/write-note', { note: 'annas own note' });

        const session = await openSession(scope);
        const stub = await host.getImpersonatedScope(session.id, t1, scope);
        await expect(stub.invoke<string[]>('perm/read-notes')).resolves.toEqual(['annas own note']);
      });

      /** A `write` session is an ordinary operation again — and still stamped. */
      it('commits under a write session', async () => {
        const scope = await freshScope();
        const session = await openSession(scope, { mode: 'write' });
        const stub = await host.getImpersonatedScope(session.id, t1, scope);
        await stub.invoke('perm/write-note', { note: 'a fix, on purpose' });
        const asAnna = await host.getScope(anna, t1, scope);
        await expect(asAnna.invoke<string[]>('perm/read-notes')).resolves.toEqual([
          'a fix, on purpose',
        ]);
      });
    });

    // -- the time box ---------------------------------------------------------

    describe('the session is checked on every invoke, not once at the door', () => {
      it('refuses a stub minted before the session was ended', async () => {
        const scope = await freshScope();
        const session = await openSession(scope, { mode: 'write' });
        const stub = await host.getImpersonatedScope(session.id, t1, scope);
        // It works…
        await expect(stub.invoke('perm/whoami')).resolves.toBe(anna);
        await host.admin.endImpersonation(staff, session.id);
        // …and then it does not. Nothing took the stub away; the session is what
        // was withdrawn, and that has to be enough.
        await expect(stub.invoke('perm/whoami')).rejects.toThrow(/was ended/);
      });

      it('refuses a session pointed at another scope', async () => {
        const scope = await freshScope();
        const other = await freshScope();
        const session = await openSession(scope);
        await expect(host.getImpersonatedScope(session.id, t1, other)).rejects.toThrow(
          /is for \(/,
        );
      });

      it('refuses a session nobody opened', async () => {
        const scope = await freshScope();
        await expect(
          host.getImpersonatedScope(ulid() as ImpersonationSession['id'], t1, scope),
        ).rejects.toThrow(/unknown impersonation session/);
      });
    });
  });
}
