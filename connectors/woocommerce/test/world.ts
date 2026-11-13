import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectionId,
  moduleManifest,
  permissionKey,
  platformActorId,
  scopeId,
  tenantId,
  type CommerceChange,
  type ConnectionId,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  undeclaredOperations,
  webCryptoSecretBox,
  type ModuleRegistration,
  type OperationHandler,
} from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { bindWooCommerceScope, sweepWooCommerce, type WooCommerceConnectorOptions } from '../src/index.js';
import type { WooCommerceMock } from '../src/mock.js';

export const RECORD = permissionKey.parse('commerce:record');
export const OPERATION = 'shop/record-commerce';

/**
 * A host with one tenant, one `shop` scope, a WooCommerce connection to `mock`, and a stand-in for
 * the vertical's landing operation that records what it was handed. `onLand` runs inside the
 * landing, for a test that changes the store while a sweep is walking it.
 */
export async function world(mock: WooCommerceMock, opts: { grant?: boolean; onLand?: (c: CommerceChange) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-woocommerce-'));
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
        landed.push(input);
        opts.onLand?.(input);
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
  await host.admin.createConnection(staff, { id: connId, tenantId: t, vertical: 'shop', provider: 'woocommerce', label: 'Acme store', secret: mock.secret });
  if (opts.grant !== false) {
    await host.admin.grantToConnection(staff, { connectionId: connId, permission: RECORD, node: { tenantId: t, scopeId: s }, grantedBy: staff });
  }
  const waited: number[] = [];
  const options = (over: Partial<WooCommerceConnectorOptions> = {}): WooCommerceConnectorOptions => ({
    fetch: mock.fetch,
    sleep: async (ms) => {
      waited.push(ms);
    },
    ...over,
  });
  return {
    host,
    connId,
    tenantId: t,
    scopeId: s,
    landed,
    waited,
    options,
    bind: () => bindWooCommerceScope(host, { connectionId: connId, tenantId: t, scopeId: s, vertical: 'shop', operation: OPERATION, permission: RECORD }),
    sweep: (over: Partial<WooCommerceConnectorOptions> = {}) => sweepWooCommerce(host, connId, options(over)),
    close: () => {
      host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export type World = Awaited<ReturnType<typeof world>>;

/** Set a mock row's modified date (GMT and local) — a merchant saving it. */
export function touch(row: Record<string, unknown>, gmt: string, over: Record<string, unknown> = {}): void {
  Object.assign(row, over, { date_modified_gmt: gmt, date_modified: gmt });
}
