/**
 * #3176's `delegation` column on a Durable Object that predates it. A fresh DO gets the column
 * from KERNEL_DDL, so neither the contract suite nor `lint:spine-ddl` notices the ALTER in
 * `applySpineColumnAdditions` going missing — and without it every write on every existing scope
 * fails with "no column named delegation". So the columns are dropped, the DO is evicted
 * (`state.abort`, as `schedule-invocation-column.test.ts` does) so the next construction runs the
 * ALTERs, and a delegated call must record into them. A second eviction makes the same ALTERs meet
 * columns that are already there, which must be a no-op.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import { errorCodeOf, permissionKey, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { delegationCeilingMod } from '@substrat-run/contract-tests';
import { ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from './test-host.js';
import { warmControlPlane } from './do-warmup.js';

const delegation = { actor: 'client-todo', scope: ['ceiling:a'] };

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

it('a DO that predates the delegation column gets it on wake, records into it, and wakes again unchanged', async () => {
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const alice = principalId.parse(ulid());
  let provisioned = false;
  try {
    host.registerModule(delegationCeilingMod);
    await host.admin.createTenant(staff, { id: t, slug: `delegation-column-${ulid().toLowerCase()}`, name: 'Delegation column' });
    await host.admin.grantEntitlement(staff, t, 'delegation-ceiling');
    await host.admin.defineRole(staff, t, {
      key: 'ceiling-both',
      permissions: [permissionKey.parse('ceiling:a'), permissionKey.parse('ceiling:b')],
      source: 'vertical',
    });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'ceiling-both', node: { tenantId: t, scopeId: null } });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'ceiling-vertical' });
    provisioned = true;
    await host.admin.activateScope(staff, t, s);

    // A fresh stub each time: `state.abort()` poisons the one it was called through.
    const freshStub = () => env.SCOPE.get(env.SCOPE.idFromName(s));
    const evict = (why: string) =>
      runInDurableObject(freshStub(), (_instance, state) => {
        state.abort(why);
      }).catch(() => undefined);
    const hasColumn = () =>
      runInDurableObject(freshStub(), (_instance, state) =>
        ['_substrat_outbox', '_substrat_denials'].map((table) =>
          (state.storage.sql.exec(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, table).toArray()[0] as { sql: string }).sql.includes(
            'delegation',
          ),
        ),
      );

    // Back to how a pre-#3176 build left the scope: neither table has the column.
    await runInDurableObject(freshStub(), (_instance, state) => {
      state.storage.sql.exec('ALTER TABLE _substrat_outbox DROP COLUMN delegation');
      state.storage.sql.exec('ALTER TABLE _substrat_denials DROP COLUMN delegation');
    });
    expect(await hasColumn()).toEqual([false, false]);

    await evict('evicted for #3176 test — first wake');
    expect(await hasColumn()).toEqual([true, true]);

    const stub = await host.getScope(alice, t, s, { delegation });
    await stub.invoke('ceiling/note', { id: 'n1' });
    const invocationId = ulid();
    expect(await stub.invoke('ceiling/b', undefined, { invocationId }).then(() => 'answered', errorCodeOf)).toBe('permission_denied');
    const history = await host.admin.entityHistory(staff, t, s, { entityType: 'ceiling_note', entityId: 'n1' });
    expect(history.entries[0]?.delegation).toEqual({ actor: 'client-todo' });
    const denials = await host.admin.listDenials(staff, t, s, { operation: 'ceiling/b' });
    expect(denials.filter((d) => d.invocationId === invocationId).map((d) => d.delegation)).toEqual([{ actor: 'client-todo' }]);

    // The second wake re-runs the same ALTERs against columns already there: tolerated, rows kept.
    await evict('evicted for #3176 test — second wake');
    const after = await host.admin.entityHistory(staff, t, s, { entityType: 'ceiling_note', entityId: 'n1' });
    expect(after.entries.map((e) => e.delegation)).toEqual(history.entries.map((e) => e.delegation));
  } finally {
    // Archived so no later sweep over the shared CONTROL_PLANE finds it active.
    if (provisioned) await host.admin.archiveScope(staff, t, s);
    await host.close();
  }
});
