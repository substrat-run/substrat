import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionId, moduleManifest, permissionKey, platformActorId, scopeId, tenantId, type CommerceChange, type ConnectionId } from '@substrat-run/contracts';
import { assertAllowed, ulid, undeclaredOperations, webCryptoSecretBox, type ModuleRegistration, type OperationHandler } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { bindShopifyScope, listShopifyBindings, sweepShopify, type ShopifyConnectorOptions } from '../src/index.js';
import type { ShopifyMock } from '../src/mock.js';
import { NOW } from './fixture.js';

export const RECORD = permissionKey.parse('commerce:record');
export const OPERATION = 'shop/record-commerce';

/**
 * A host with one tenant, one `shop` scope, a Shopify connection to `mock`, and a stand-in for the
 * vertical's landing operation that records what it was handed. The sweep runs on `clock`, the same
 * clock the mock judges tokens and the 60-day window by; `onLand` runs inside the landing.
 */
export async function world(mock: ShopifyMock, opts: { grant?: boolean; onLand?: (c: CommerceChange) => void | Promise<void>; clock?: { now: number } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-shopify-'));
  const clock = opts.clock ?? { now: NOW };
  const landed: CommerceChange[] = [];
  const module: ModuleRegistration = {
    manifest: moduleManifest.parse({
      id: '@test/shop',
      version: '1.0.0',
      kernelContract: '^0.0.1',
      permissions: [{ key: RECORD, description: 'land a store record' }],
      events: { emits: [], consumes: [] },
      migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
      attachmentTargets: [],
      entitlementKey: 'shop',
    }),
    ...undeclaredOperations('a test fixture, built to drive the host rather than declared', {
      [OPERATION]: (async (ctx, input: CommerceChange) => {
        assertAllowed(await ctx.check(RECORD));
        await opts.onLand?.(input);
        landed.push(input);
        return { ok: true };
      }) as OperationHandler<never, unknown>,
    }),
  };
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const connId: ConnectionId = connectionId.parse(ulid());
  const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(7)), fetch: mock.fetch });
  host.registerModule(module);
  await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
  await host.admin.grantEntitlement(staff, t, 'shop');
  await host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu', vertical: 'shop' });
  await host.admin.activateScope(staff, t, s);
  await host.admin.createConnection(staff, { id: connId, tenantId: t, vertical: 'shop', provider: 'shopify', label: 'Acme shop', secret: mock.secret, externalAccountRef: mock.shop });
  if (opts.grant !== false) {
    await host.admin.grantToConnection(staff, { connectionId: connId, permission: RECORD, node: { tenantId: t, scopeId: s }, grantedBy: staff });
  }
  const waited: number[] = [];
  const options = (over: Partial<ShopifyConnectorOptions> = {}): ShopifyConnectorOptions => ({
    fetch: mock.fetch,
    now: () => clock.now,
    sleep: async (ms) => {
      waited.push(ms);
    },
    ...over,
  });
  return {
    host,
    connId,
    scopeId: s,
    landed,
    waited,
    clock,
    options,
    bind: () => bindShopifyScope(host, { connectionId: connId, tenantId: t, scopeId: s, vertical: 'shop', operation: OPERATION, permission: RECORD, externalAccountRef: mock.shop }),
    sweep: (over: Partial<ShopifyConnectorOptions> = {}) => sweepShopify(host, connId, options(over)),
    binding: async () => (await listShopifyBindings(host, connId))[0]!,
    close: () => {
      host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export type World = Awaited<ReturnType<typeof world>>;

/** A merchant saving a mock row at `updatedAt`. */
export function touch(row: Record<string, unknown>, updatedAt: string, over: Record<string, unknown> = {}): void {
  Object.assign(row, over, { updatedAt });
}
