import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, scopeId as scopeIdSchema, tenantId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { WIRE_NONCE_TABLE_NAMES, ulid } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';

/**
 * The wire-signing nonce store (RFC wire-signing §4), through each host's `claimWireNonceLocal`:
 * the claim the platform's entry makes in the scope a verified envelope names, after every other
 * check passed. Held alike on both adapters: a nonce is spent once per scope, scopes do not share
 * a store, a claim after its window answers `false`, nothing that is not a nonce reaches the store,
 * and the store is the scope's own and no dump's, so a copy carries none and a restore empties it.
 */
export function wireNonceContractSuite(
  adapterName: string,
  makeFixture: () => Promise<
    ScopeHostFixture & {
      claimWireNonceLocal(tenantId: TenantId, scopeId: ScopeId, nonce: string, until: number): Promise<boolean>;
    }
  >,
): void {
  describe(`the wire nonce store (RFC wire-signing §4): ${adapterName}`, () => {
    let fixture: Awaited<ReturnType<typeof makeFixture>>;
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    /** Far enough ahead that no run of this suite reaches it. */
    const until = Math.floor(Date.now() / 1000) + 3600;
    let n = 0;
    /** A fresh canonical nonce: 21 base64url characters and a last one with its trailing bits zero. */
    const nonce = () => `${(n++).toString(36).padStart(10, '0')}${ulid().slice(-11).toLowerCase()}A`;

    beforeAll(async () => {
      fixture = await makeFixture();
      await fixture.host.admin.createTenant(staff, { id: t, slug: `wire-nonce-${t.slice(-8).toLowerCase()}`, name: 'Wire nonces' });
    });
    afterAll(async () => fixture?.cleanup());

    const newScope = async (): Promise<ScopeId> => {
      const s = scopeIdSchema.parse(ulid());
      await fixture.host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'wire-nonce' });
      await fixture.host.admin.activateScope(staff, t, s);
      return s;
    };
    const claim = (s: ScopeId, value: string, at = until) => fixture.claimWireNonceLocal(t, s, value, at);

    it('spends a nonce once: true, then false for the same nonce, and true for another', async () => {
      const s = await newScope();
      const a = nonce();
      expect(await claim(s, a)).toBe(true);
      expect(await claim(s, a)).toBe(false);
      expect(await claim(s, a)).toBe(false);
      expect(await claim(s, nonce())).toBe(true);
    });

    it('keeps each scope its own store: one nonce is unspent in another scope', async () => {
      const [s1, s2] = [await newScope(), await newScope()];
      const a = nonce();
      expect(await claim(s1, a)).toBe(true);
      expect(await claim(s2, a)).toBe(true);
      expect(await claim(s1, a)).toBe(false);
      expect(await claim(s2, a)).toBe(false);
    });

    it('answers false for a claim made after its window, and does not spend the nonce', async () => {
      const s = await newScope();
      const a = nonce();
      expect(await claim(s, a, 1)).toBe(false);
      expect(await claim(s, a)).toBe(true);
    });

    it('claims in a scope nothing has provisioned yet: the call that provisions it spends its nonce there', async () => {
      const s = scopeIdSchema.parse(ulid());
      const a = nonce();
      expect(await claim(s, a)).toBe(true);
      expect(await claim(s, a)).toBe(false);
    });

    it('refuses what is not a nonce before anything is stored', async () => {
      const s = await newScope();
      for (const bad of ['', 'not-a-nonce', `${nonce().slice(0, 21)}B`]) {
        await expect(() => claim(s, bad)).rejects.toThrow();
      }
      await expect(() => claim(s, nonce(), -1)).rejects.toThrow();
    });

    it('no dump carries the store, and a restore from one leaves the scope with no nonce spent', async () => {
      const s = await newScope();
      const a = nonce();
      expect(await claim(s, a)).toBe(true);
      const dump = await fixture.host.admin.exportScope(staff, t, s);
      const names = dump.tables.map((table) => table.name.toLowerCase());
      for (const name of WIRE_NONCE_TABLE_NAMES) expect(names).not.toContain(name);
      // Its twin: the dump does carry the rest of the spine.
      expect(names).toContain('_substrat_outbox');
      // A copy of the scope starts with none spent…
      const fork = scopeIdSchema.parse(ulid());
      await fixture.host.importScope(staff, { tenantId: t, scopeId: fork, vertical: 'wire-nonce' }, dump);
      expect(await claim(fork, a)).toBe(true);
      // …and so does the scope itself once a restore has replaced its store (RFC §4: why the window is short).
      expect(await claim(s, a)).toBe(false);
      await fixture.host.restoreScope(staff, t, s, dump);
      expect(await claim(s, a)).toBe(true);
      expect(await claim(s, a)).toBe(false);
    });
  });
}
