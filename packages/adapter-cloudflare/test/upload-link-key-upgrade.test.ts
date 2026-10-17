import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import {
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type EntityRef,
  type MintedUploadLink,
} from '@substrat-run/contracts';
import { UPL_READ, UPL_WRITE, uploadLinkMod } from '@substrat-run/contract-tests';
import { UPLOAD_LINK_GONE, ulid, webCryptoSecretBox } from '@substrat-run/kernel';
import { CloudflareScopeHost } from './test-host.js';
import { warmControlPlane } from './do-warmup.js';

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

it('a scope DO from before #2315 gains redeemed_key_hash on its next wake, keeps its links, and a second wake is a no-op', async () => {
  const objs = new Map<string, Uint8Array>();
  const bucket = {
    put: async (key: string, value: Uint8Array) => {
      objs.set(key, new Uint8Array(value));
    },
    get: async (key: string) => {
      const o = objs.get(key);
      return o ? { arrayBuffer: async () => o.buffer.slice(o.byteOffset, o.byteOffset + o.byteLength) } : null;
    },
    delete: async (key: string) => {
      objs.delete(key);
    },
    list: async () => ({ objects: [...objs.keys()].map((key) => ({ key })), truncated: false as const }),
  };
  const host = new CloudflareScopeHost({
    scope: env.SCOPE,
    controlPlane: env.CONTROL_PLANE,
    blobStores: { create: async (name) => name, remove: async () => {} },
    attachmentBuckets: () => bucket,
    secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
  });
  host.registerModule(uploadLinkMod);
  const staff = platformActorId.parse(ulid());
  const alice = principalId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: `upl-key-${ulid().toLowerCase()}`, name: 'Upload key upgrade' });
  await host.admin.grantEntitlement(staff, t, 'upl');
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'upl-vertical' });
  try {
    await host.admin.activateScope(staff, t, s);
    await host.provisionBlobStore(staff, { tenantId: t, vertical: 'upl-vertical', binding: 'ATTACHMENTS' });
    await host.admin.defineRole(staff, t, { key: 'owner', permissions: [UPL_READ, UPL_WRITE], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: alice, roleKey: 'owner', node: { tenantId: t, scopeId: null } });
    const entity: EntityRef = { entityType: 'udoc', entityId: 'legacy' };
    const mint = async (): Promise<MintedUploadLink> => (await host.getScope(alice, t, s)).invoke<MintedUploadLink>('upl/mint', { entity });
    const redeem = (m: MintedUploadLink, idempotencyKey?: string) =>
      host.redeemUploadLink(t, s, m.secret, {
        entity,
        filename: 'a.txt',
        contentType: 'text/plain',
        body: bytes('hello'),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
    // One link spent and one pending, then the table put back to its pre-#2315 shape.
    const spent = await mint();
    await redeem(spent);
    const pending = await mint();
    const stub = () => env.SCOPE.get(env.SCOPE.idFromName(s));
    await runInDurableObject(stub(), (_instance, state) => {
      state.storage.sql.exec('ALTER TABLE _substrat_upload_links DROP COLUMN redeemed_key_hash');
    });
    const abortToWake = async () =>
      runInDurableObject(stub(), (_instance, state) => {
        state.abort('wake upload-link key column upgrade');
      }).catch(() => undefined);
    const columns = () =>
      runInDurableObject(stub(), (_instance, state) =>
        state.storage.sql.exec("SELECT name FROM pragma_table_info('_substrat_upload_links')").toArray(),
      );
    expect(await columns()).not.toContainEqual({ name: 'redeemed_key_hash' });

    await abortToWake();
    // The link spent before the column carries no key: a key never replays it.
    const legacy = await redeem(spent, `key-${ulid()}`).then(() => undefined, (e: unknown) => e);
    expect((legacy as { extensions?: { reason?: unknown } }).extensions?.reason).toBe(UPLOAD_LINK_GONE);
    expect(await columns()).toContainEqual({ name: 'redeemed_key_hash' });
    // The pending one, redeemed with a key after the upgrade, replays.
    const k = `key-${ulid()}`;
    const first = await redeem(pending, k);
    await abortToWake();
    expect(await columns()).toContainEqual({ name: 'redeemed_key_hash' });
    expect(await redeem(pending, k)).toEqual({ ...first, replayed: true });
  } finally {
    await host.admin.archiveScope(staff, t, s);
    await host.close();
  }
});
