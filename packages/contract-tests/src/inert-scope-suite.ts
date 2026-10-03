import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, principalId, scopeId, tenantId, type ScopeId } from '@substrat-run/contracts';
import { INERT_SCOPE_REASON, ulid, type ScopeHost } from '@substrat-run/kernel';
import { connectorMod, contractTestBareOps } from './modules.js';
import type { ScopeHostFixture } from './scope-host-suite.js';

/**
 * #2005: a scope that is not primary — a fork, a snapshot, a preview of either kind — causes
 * no outbound effects. This suite holds the in-scope doors to that on every adapter: the
 * executor and connector dispatch (the emitting call's post-commit tail, and `drainDue`), and
 * the route read that tells the egress worker which kind of scope a request is for.
 *
 * Every case has its twin on a primary scope, because "nothing ran" is also what a broken
 * fixture looks like. The fixture's checker must let the suite invoke the connector fixture's
 * operations (`connectorMod`) and the bare outbox read, which the suite registers — and which a
 * code-time module set (the Cloudflare ScopeDO's) must already carry.
 */
export function inertScopeContractSuite(adapterName: string, makeFixture: () => Promise<ScopeHostFixture>): void {
  describe(`inert scopes (#2005): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const staff = platformActorId.parse(ulid());
    const alice = principalId.parse(ulid());
    const t = tenantId.parse(ulid());
    const vertical = 'connector-vertical';
    /** What the executor and the connector were handed — the effect, observed. */
    const effected: string[] = [];
    const called: string[] = [];
    let primary: ScopeId;

    const scope = async (extra: Record<string, unknown> = {}): Promise<ScopeId> => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical, ...extra });
      await host.admin.activateScope(staff, t, s);
      return s;
    };

    /** Ask for one executor effect and one connector call on `s`, both tagged. */
    const ask = async (s: ScopeId, tag: string): Promise<void> => {
      const stub = await host.getScope(alice, t, s);
      await stub.invoke('connector/request-effect', { tag: `effect-${tag}` });
      await stub.invoke('connector/request-outbound', { tag: `outbound-${tag}` });
    };

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      // The connector fixture asks for the effects; a bare operation reads the outbox back.
      host.registerModule(connectorMod);
      host.defineOperation('test/read-outbox', contractTestBareOps['test/read-outbox']!);
      host.registerExecutor('inert-effector', 'effect.requested', async (_admin, event) => {
        effected.push((event.payload as { tag: string }).tag);
      });
      // No provider call: the handler being invoked at all is the effect this suite watches.
      host.registerConnector('inert-caller', 'outbound.requested', async (_ctx, event) => {
        called.push((event.payload as { tag: string }).tag);
      });
      await host.admin.createTenant(staff, { id: t, slug: `inert-${t.slice(-10).toLowerCase()}`, name: 'Inert' });
      await host.admin.grantEntitlement(staff, t, 'connector');
      primary = await scope();
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    it('twin: a primary scope runs its executor and its connector', async () => {
      await ask(primary, 'primary');
      expect(effected).toContain('effect-primary');
      expect(called).toContain('outbound-primary');
      expect(await host.executorDeadLetters(t, primary)).toEqual([]);
    });

    const nonPrimary: [string, () => Record<string, unknown>][] = [
      ['a clean-room preview (kind preview, no source)', () => ({ kind: 'preview' })],
      ['a preview fork', () => ({ kind: 'preview', forkedFrom: primary, forkedAt: new Date().toISOString() })],
      ['a fork', () => ({ forkedFrom: primary, forkedAt: new Date().toISOString() })],
      ['a snapshot (an archive copy)', () => ({ kind: 'archive', forkedFrom: primary, forkedAt: new Date().toISOString() })],
    ];

    for (const [name, shape] of nonPrimary) {
      it(`${name}: neither runs, and both are journaled terminal with the reason`, async () => {
        const s = await scope(shape());
        const tag = ulid().toLowerCase();
        await ask(s, tag);

        // The operation itself committed: the scope is a working copy, only inert.
        const stub = await host.getScope(alice, t, s);
        const outbox = await stub.invoke<{ type: string }[]>('test/read-outbox');
        expect(outbox.map((r) => r.type)).toEqual(expect.arrayContaining(['effect.requested', 'outbound.requested']));

        expect(effected).not.toContain(`effect-${tag}`);
        expect(called).not.toContain(`outbound-${tag}`);
        const dead = await host.executorDeadLetters(t, s);
        expect(dead.map((d) => [d.executorId, d.attempts, d.error]).sort()).toEqual([
          ['inert-caller', 1, INERT_SCOPE_REASON],
          ['inert-effector', 1, INERT_SCOPE_REASON],
        ]);

        // The retry driver neither runs them nor re-journals them: the settle is terminal.
        const report = await host.drainDue(t, s);
        expect(report.attempted).toBe(0);
        expect(effected).not.toContain(`effect-${tag}`);
        expect(called).not.toContain(`outbound-${tag}`);
      });
    }

    it('the next case along: a primary scope beside them still runs, after they were settled', async () => {
      await ask(primary, 'primary-after');
      expect(effected).toContain('effect-primary-after');
      expect(called).toContain('outbound-primary-after');
    });

    describe('the route read tells the egress worker what kind of scope a hostname serves', () => {
      const bound = async (s: ScopeId): Promise<string> => {
        const hostname = `inert-${ulid().toLowerCase()}.example.com`;
        await host.admin.bindHostname(staff, { hostname, tenantId: t, scopeId: s, surface: 'app', region: null, canonical: true });
        await host.admin.setHostnameStatus(staff, hostname, 'active');
        return hostname;
      };

      it('twin: a primary scope resolves primary', async () => {
        expect((await host.admin.resolveHostname(await bound(primary)))?.primary).toBe(true);
      });

      for (const [name, shape] of nonPrimary) {
        it(`${name} resolves not primary`, async () => {
          expect((await host.admin.resolveHostname(await bound(await scope(shape()))))?.primary).toBe(false);
        });
      }

      // The addresses a non-primary scope may still write to: every surface of the SAME scope.
      it("carries the scope's own hostnames — its sibling surfaces — and no other scope's", async () => {
        const preview = await scope({ kind: 'preview' });
        const app = await bound(preview);
        const admin = await bound(preview);
        const other = await bound(await scope({ kind: 'preview' }));
        const resolved = await host.admin.resolveHostname(app);
        expect([...(resolved?.hostnames ?? [])].sort()).toEqual([admin, app].sort());
        expect(resolved?.hostnames).not.toContain(other);
        // Only ACTIVE bindings count: one still validating is nobody's address yet.
        const pending = `inert-${ulid().toLowerCase()}.example.com`;
        await host.admin.bindHostname(staff, { hostname: pending, tenantId: t, scopeId: preview, surface: 'app', region: null, canonical: false });
        expect((await host.admin.resolveHostname(app))?.hostnames).not.toContain(pending);
        // A removed hostname stops counting at once — the read is per request.
        await host.admin.unbindHostname(staff, admin);
        expect((await host.admin.resolveHostname(app))?.hostnames).toEqual([app]);
      });
    });
  });
}
