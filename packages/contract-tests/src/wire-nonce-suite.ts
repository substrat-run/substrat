import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, scopeId as scopeIdSchema, tenantId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { WIRE_NONCE_CAP, ulid } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';

/**
 * The wire-signing nonce store (RFC wire-signing §4), through each host's `claimWireNonceLocal`:
 * the claim the platform's entry makes in the scope a verified envelope names, after every other
 * check passed. Held alike on both adapters: a nonce is spent once per scope, and the store is the
 * scope's own and no dump's, so a copy carries none and a restore empties it. The claim's own rules
 * (the window, the purge, the cap) are the kernel's, tested there.
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

    /** One provisioned scope the suite shares: each test spends nonces of its own. */
    const s = scopeIdSchema.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      await fixture.host.admin.createTenant(staff, { id: t, slug: `wire-nonce-${t.slice(-8).toLowerCase()}`, name: 'Wire nonces' });
      await fixture.host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'wire-nonce' });
      await fixture.host.admin.activateScope(staff, t, s);
    });
    afterAll(async () => fixture?.cleanup());

    const claim = (s: ScopeId, value: string) => fixture.claimWireNonceLocal(t, s, value, until);

    it('spends a nonce once per scope, a scope nothing has provisioned yet included', async () => {
      // The call that provisions a scope spends its nonce there too, so no provisioned check.
      const unprovisioned = scopeIdSchema.parse(ulid());
      const a = nonce();
      expect(await claim(s, a)).toBe(true);
      expect(await claim(unprovisioned, a)).toBe(true);
      expect(await claim(s, a)).toBe(false);
      expect(await claim(unprovisioned, a)).toBe(false);
    });

    // That the dump leaves the tables out is the shared host suite's export check.
    it('a copy and a restore start with no nonce spent', async () => {
      const a = nonce();
      expect(await claim(s, a)).toBe(true);
      const dump = await fixture.host.admin.exportScope(staff, t, s);
      // A copy of the scope starts with none spent…
      const fork = scopeIdSchema.parse(ulid());
      await fixture.host.importScope(staff, { tenantId: t, scopeId: fork, vertical: 'wire-nonce' }, dump);
      expect(await claim(fork, a)).toBe(true);
      // …and so does the scope itself once a restore has replaced its store (RFC §4: why the window is short).
      expect(await claim(s, a)).toBe(false);
      await fixture.host.restoreScope(staff, t, s, dump);
      expect(await claim(s, a)).toBe(true);
    });

    it('a dump that does carry the nonce tables (a full count, spent nonces) loads without them', async () => {
      const spent = nonce();
      const dump = await fixture.host.admin.exportScope(staff, t, s);
      dump.tables.push(
        {
          name: '_substrat_wire_nonce_count',
          ddl: 'CREATE TABLE _substrat_wire_nonce_count (slot TEXT PRIMARY KEY, live INTEGER NOT NULL) WITHOUT ROWID',
          columns: ['slot', 'live'],
          rows: [['live', WIRE_NONCE_CAP]],
        },
        {
          name: '_substrat_wire_nonces',
          ddl: 'CREATE TABLE _substrat_wire_nonces (nonce TEXT PRIMARY KEY, until_s INTEGER NOT NULL) WITHOUT ROWID',
          columns: ['nonce', 'until_s'],
          rows: [[spent, until]],
        },
      );
      await fixture.host.restoreScope(staff, t, s, dump);
      expect(await claim(s, spent)).toBe(true);
    });
  });
}
