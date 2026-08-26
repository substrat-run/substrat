/**
 * Contract suite for impersonation — acting as a principal with the real actor
 * preserved (K-42, #868).
 *
 * Two rules, and every assertion below is one of them:
 *
 * 1. **The permission model sees the IMPERSONATED principal.** A session acting
 *    as someone who holds a key passes; acting as someone who does not is denied,
 *    and the staff actor's own standing changes neither answer. This is the half
 *    that makes "see what Anna sees" an honest answer rather than a privileged
 *    one, and the denial case is the half that stops a support session becoming a
 *    skeleton key.
 * 2. **Every record keeps BOTH.** The outbox, the denial log and the platform
 *    intent journal all carry the session beside the actor. That is stamped
 *    kernel-side like K-34's `authorization`, so the suite also asserts the thing
 *    a convention cannot: a module that hands `impersonation` to `ctx.emit`
 *    changes nothing, because the field is not on `DomainEventInput` and the door
 *    is the only writer.
 *
 * The bound is tested too, and against a REAL expiry rather than a mocked one:
 * a session is minted with a window a millisecond wide, and the invoke after it
 * is refused. A time-box that is only checked at the door would pass a test that
 * mints and immediately invokes, which is why the check lives per-invoke and why
 * this suite drives it that way.
 *
 * Runs against both adapters (D-14). The pure adapter stamps in-process; the
 * Cloudflare one has to carry the session across the coordinator→DO RPC and
 * acknowledge that it recorded it, so "both adapters agree" is a much stronger
 * statement here than the shared code makes it look.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  IMPERSONATION_MAX_MINUTES,
  instant,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type Impersonation,
  type PermissionKey,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { permMod } from './modules.js';

const PERM_READ = permissionKey.parse('perm:read');
const PERM_USE = permissionKey.parse('perm:use');

/** The outbox shape `perm/read-outbox` returns — raw columns, JSON still text. */
interface OutboxRow {
  id: string;
  type: string;
  entity_id: string;
  actor: string;
  authorization: string | null;
  impersonation: string | null;
}

interface DenialRow {
  actor: string;
  permission: string;
  operation: string | null;
  impersonation: string | null;
}

export function impersonationContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`impersonation (K-42): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    /** Holds `perm:read` + `perm:use` through a role — the person support acts as. */
    const anna: PrincipalId = principalId.parse(ulid());
    /** Holds nothing at all — the person support acts as to prove the gate is real. */
    const mallory: PrincipalId = principalId.parse(ulid());
    /** A platform staff actor. Not a principal in this or any tenant (K-20). */
    const nadia = platformActorId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    const session = { by: { staff: nadia }, reason: 'ticket SUP-4711: invoice screen blank' };

    const outbox = async (): Promise<OutboxRow[]> => {
      const stub = await host.getScope(anna, t1, s1);
      return stub.invoke<OutboxRow[]>('perm/read-outbox');
    };
    const denials = async (): Promise<DenialRow[]> => {
      const stub = await host.getScope(anna, t1, s1);
      return stub.invoke<DenialRow[]>('perm/read-denials');
    };
    const decoded = (cell: string | null): Impersonation | null =>
      cell === null ? null : (JSON.parse(cell) as Impersonation);

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(permMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'imp-tenant', name: 'Imp Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'perm');
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'perm-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      await host.admin.defineRole(staff, t1, {
        key: 'member',
        permissions: [PERM_READ, PERM_USE],
        source: 'vertical',
      });
      await host.admin.assignRole(staff, {
        principalId: anna,
        roleKey: 'member',
        node: { tenantId: t1, scopeId: s1 },
      });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('answers the permission question as the IMPERSONATED principal', async () => {
      const stub = await host.getImpersonatedScope(session, anna, t1, s1);
      // Anna's role is what allows this. Nothing about `nadia` was consulted, and
      // nothing could have been: a platform actor holds no tuples in any tenant.
      await expect(
        stub.invoke('perm/authorized-emit', {
          permission: PERM_READ,
          entity: { entityType: 'test-thing', entityId: 'imp-allowed' },
        }),
      ).resolves.toBeUndefined();
    });

    it('is refused when the impersonated principal holds nothing', async () => {
      const stub = await host.getImpersonatedScope(session, mallory, t1, s1);
      // The direction that matters: a support session is not a skeleton key. It
      // reaches exactly what the person being helped reaches, including nothing.
      await expect(
        stub.invoke('perm/authorized-emit', {
          permission: PERM_READ,
          entity: { entityType: 'test-thing', entityId: 'imp-denied' },
        }),
      ).rejects.toThrow();
    });

    it('hands the operation both actors, and neither is guessable from the other', async () => {
      const stub = await host.getImpersonatedScope(session, anna, t1, s1);
      const seen = await stub.invoke<{ principal: string; impersonation: Impersonation | null }>(
        'perm/whoami',
      );
      expect(seen.principal).toBe(anna);
      expect(seen.impersonation?.by).toEqual({ staff: nadia });
      expect(seen.impersonation?.reason).toBe(session.reason);
    });

    it('leaves `ctx.impersonation` unset on an ordinary stub', async () => {
      const stub = await host.getScope(anna, t1, s1);
      const seen = await stub.invoke<{ principal: string; impersonation: Impersonation | null }>(
        'perm/whoami',
      );
      expect(seen).toEqual({ principal: anna, impersonation: null });
    });

    it('stamps the session onto the event, beside the actor it was acting as', async () => {
      const stub = await host.getImpersonatedScope(session, anna, t1, s1);
      await stub.invoke('perm/authorized-emit', {
        permission: PERM_USE,
        entity: { entityType: 'test-thing', entityId: 'imp-1' },
      });
      const row = (await outbox()).find((r) => r.entity_id === 'imp-1');
      expect(row, 'the emitted event carries no session').toBeDefined();
      // BOTH. The actor is the person whose authority the write ran under; the
      // session names who was really there. Either alone is a lie of a different kind.
      expect(JSON.parse(row!.actor)).toBe(anna);
      expect(decoded(row!.impersonation)?.by).toEqual({ staff: nadia });
      expect(decoded(row!.impersonation)?.reason).toBe(session.reason);
      // K-34 still holds alongside it — this adds a fact, it does not displace one.
      expect(JSON.parse(row!.authorization ?? '[]')).toEqual([{ permission: PERM_USE }]);
    });

    it('records nothing on an event emitted outside a session', async () => {
      const stub = await host.getScope(anna, t1, s1);
      await stub.invoke('perm/authorized-emit', {
        permission: PERM_USE,
        entity: { entityType: 'test-thing', entityId: 'plain-1' },
      });
      const rows = await outbox();
      const plain = rows.filter((r) => r.entity_id === 'plain-1' && r.impersonation === null);
      // The accumulator does not leak across stubs: one impersonated invoke earlier
      // must not colour an ordinary one after it.
      expect(plain.length).toBeGreaterThan(0);
    });

    it('refuses a session module code tried to supply itself', async () => {
      const stub = await host.getScope(anna, t1, s1);
      await stub.invoke('perm/forge-emit', { permission: PERM_USE });
      const forged = (await outbox()).filter((r) => r.entity_id === 'forged');
      // `impersonation` is not on `DomainEventInput`, so the parse drops it and the
      // door remains the only writer. A module cannot claim it was support, and —
      // the other half of the same property — cannot drop a session it IS in.
      expect(forged).toHaveLength(1);
      expect(forged[0]!.impersonation).toBeNull();
    });

    it('ignores forged metadata INSIDE a session, keeping the kernel-stamped one', async () => {
      const stub = await host.getImpersonatedScope(session, anna, t1, s1);
      await stub.invoke('perm/forge-emit', { permission: PERM_USE, entityId: 'forged-in-session' });
      const row = (await outbox()).find((r) => r.entity_id === 'forged-in-session');
      expect(row, 'the forged emit never landed').toBeDefined();
      const stamped = decoded(row!.impersonation);
      // The other direction of the same property, and the one that actually matters:
      // outside a session an adapter can pass by dropping untrusted metadata, while
      // inside one it could just as easily let that metadata REPLACE the session —
      // which is a module rewriting who was there and why. All three fields are the
      // door's, none are the handler's.
      expect(stamped?.by).toEqual({ staff: nadia });
      expect(stamped?.reason).toBe(session.reason);
      expect(stamped?.expiresAt).not.toBe('2099-01-01T00:00:00Z');
      expect(Date.parse(stamped!.expiresAt)).toBeLessThanOrEqual(
        Date.now() + IMPERSONATION_MAX_MINUTES * 60_000 + 5_000,
      );
    });

    it('records both actors on a DENIAL', async () => {
      const stub = await host.getImpersonatedScope(session, mallory, t1, s1);
      await expect(
        stub.invoke('perm/authorized-emit', {
          permission: PERM_READ,
          entity: { entityType: 'test-thing', entityId: 'imp-denied-2' },
        }),
      ).rejects.toThrow();
      const row = (await denials()).find((d) => JSON.parse(d.actor) === mallory);
      expect(row, 'the denial was not recorded').toBeDefined();
      // The denial log is where intent and the model visibly disagree (K-35). Under
      // impersonation it is also the first row an incident review asks for.
      expect(decoded(row!.impersonation)?.by).toEqual({ staff: nadia });
      expect(row!.operation).toBe('perm/authorized-emit');
    });

    it('records both actors on a platform intent', async () => {
      const stub = await host.getImpersonatedScope(session, anna, t1, s1);
      await stub.invoke('perm/request-platform', { permission: PERM_USE, kind: 'test.impersonated' });
      const reader = await host.getScope(anna, t1, s1);
      const journal = await reader.invoke<
        { kind: string; requestedBy: unknown; impersonation: Impersonation | null }[]
      >('perm/read-platform-requests');
      const intent = journal.find((r) => r.kind === 'test.impersonated');
      expect(intent, 'the intent was not journalled').toBeDefined();
      expect(intent!.requestedBy).toBe(anna);
      expect(intent!.impersonation?.by).toEqual({ staff: nadia });
    });

    it('surfaces the session on the timeline read, not just in the raw row', async () => {
      const stub = await host.getImpersonatedScope(session, anna, t1, s1);
      await stub.invoke('perm/authorized-emit', {
        permission: PERM_USE,
        entity: { entityType: 'test-thing', entityId: 'imp-timeline' },
      });
      const page = await stub.invoke<{
        entries: { actor: unknown; impersonation?: Impersonation }[];
      }>('perm/timeline', { entityType: 'test-thing', entityId: 'imp-timeline' });
      expect(page.entries).toHaveLength(1);
      // What a history strip renders. Without this the strip says "Anna changed
      // this" about a change support made, which is true about the authority and
      // false about the person.
      expect(page.entries[0]!.actor).toBe(anna);
      expect(page.entries[0]!.impersonation?.by).toEqual({ staff: nadia });
    });

    it('bounds the session, and enforces the bound per invoke', async () => {
      const soon = instant.parse(new Date(Date.now() + 40).toISOString());
      const stub = await host.getImpersonatedScope({ ...session, expiresAt: soon }, anna, t1, s1);
      await new Promise((resolve) => setTimeout(resolve, 60));
      // Minted fine, and now refused — which is the whole difference between a
      // session and a standing key. Checked here rather than at the mint, because a
      // stub is held for as long as its holder likes.
      await expect(
        stub.invoke('perm/authorized-emit', {
          permission: PERM_READ,
          entity: { entityType: 'test-thing', entityId: 'imp-expired' },
        }),
      ).rejects.toThrow(/expired/);
    });

    it('caps a window the caller asked to be longer than the platform allows', async () => {
      const tooLong = instant.parse(
        new Date(Date.now() + (IMPERSONATION_MAX_MINUTES + 60) * 60_000).toISOString(),
      );
      const stub = await host.getImpersonatedScope({ ...session, expiresAt: tooLong }, anna, t1, s1);
      const seen = await stub.invoke<{ impersonation: Impersonation | null }>('perm/whoami');
      const granted = Date.parse(seen.impersonation!.expiresAt);
      // A bound the caller chooses for itself is not a bound. The ceiling is the
      // host's, and what it hands back is what every record then carries.
      expect(granted).toBeLessThanOrEqual(Date.now() + IMPERSONATION_MAX_MINUTES * 60_000 + 5_000);
      expect(granted).toBeGreaterThan(Date.now());
    });

    it('refuses a window that has already closed rather than quietly clamping it', async () => {
      const past = instant.parse(new Date(Date.now() - 60_000).toISOString());
      // A caller whose clock disagrees with the host's gets an error, not a live
      // session it did not ask for.
      await expect(
        host.getImpersonatedScope({ ...session, expiresAt: past }, anna, t1, s1),
      ).rejects.toThrow();
    });

    it('records the staff session in the admin log BEFORE it can be used', async () => {
      const before = await host.admin.auditLog(staff, { action: 'impersonate' });
      await host.getImpersonatedScope(session, anna, t1, s1);
      const after = await host.admin.auditLog(staff, { action: 'impersonate' });
      expect(after.length).toBe(before.length + 1);
      const entry = after[after.length - 1]!;
      // K-33's ordering: the entry precedes the act. It is also the only record a
      // session that reads and writes nothing leaves behind at all.
      expect(entry.actor).toBe(nadia);
      expect(entry.after).toMatchObject({ principal: anna, reason: session.reason });
    });

    it('records a REFUSED staff mint as its own admin action', async () => {
      const rejected = async (): Promise<number> =>
        (await host.admin.auditLog(staff, { action: 'impersonateRejected' })).length;
      const before = await rejected();
      const past = instant.parse(new Date(Date.now() - 60_000).toISOString());
      await expect(
        host.getImpersonatedScope({ ...session, expiresAt: past }, anna, t1, s1),
      ).rejects.toThrow();
      // The attempt is the half a probe shows up in: validation runs before the
      // accepted entry can be written, so a log holding only the mints that succeeded
      // would show a clean history of exactly the sessions that worked.
      expect(await rejected()).toBe(before + 1);
      const entry = (await host.admin.auditLog(staff, { action: 'impersonateRejected' })).at(-1)!;
      expect(entry.actor).toBe(nadia);
      expect(entry.after).toMatchObject({ principal: anna });
    });

    it('refuses a reason that is only whitespace, and audits that attempt too', async () => {
      const rejected = async (): Promise<number> =>
        (await host.admin.auditLog(staff, { action: 'impersonateRejected' })).length;
      const before = await rejected();
      // A required field a single space satisfies is an optional field with extra
      // steps — and `reason` is the whole reviewability of the feature.
      await expect(
        host.getImpersonatedScope({ by: { staff: nadia }, reason: '   ' }, anna, t1, s1),
      ).rejects.toThrow();
      expect(await rejected()).toBe(before + 1);
    });

    it('lets a PRINCIPAL act as another principal, with no admin-log entry', async () => {
      const admin: PrincipalId = principalId.parse(ulid());
      const stub = await host.getImpersonatedScope(
        { by: admin, reason: 'reproducing a member report' },
        anna,
        t1,
        s1,
      );
      const seen = await stub.invoke<{ impersonation: Impersonation | null }>('perm/whoami');
      // A tenant's own act. The admin log is the PLATFORM's (control-plane §4.4), and
      // attributing this there would need a platform actor that does not exist — the
      // laundering this feature is here to avoid. The scope's own rows still carry it.
      expect(seen.impersonation?.by).toBe(admin);
    });
  });
}

/** The permissions this suite's roles hand out — exported for the fixture's benefit. */
export const IMPERSONATION_SUITE_PERMISSIONS: readonly PermissionKey[] = [PERM_READ, PERM_USE];
