import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectionCheckoutRequest,
  connectionId,
  moduleManifest,
  permissionKey,
  platformActorId,
  scopeId,
  tenantId,
  type ConnectionId,
  type PaymentChange,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  undeclaredOperations,
  webCryptoSecretBox,
  type FetchLike,
  type ModuleRegistration,
  type OperationHandler,
} from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import {
  bindStripeScope,
  createStripeCheckout,
  handleStripeCallback,
  prepareStripeCandidate,
  sweepStripe,
  type StripeConnectorOptions,
} from '../src/index.js';
import type { StripeMock } from '../src/mock.js';

export const RECORD = permissionKey.parse('payment:record');
export const OPERATION = 'shop/record-payment';
export const CALLBACK_BASE = 'https://cp.example.com';

/**
 * A host with one tenant, one `shop` scope, a Stripe connection to `mock`, and a stand-in for the
 * vertical's landing operation that records what it was handed. The clock is the test's, shared by
 * the connector and the mock, so a webhook's timestamp and the tolerance it is judged by agree.
 */
export async function world(mock: StripeMock, opts: { clock?: { ms: number }; callbackBase?: string | null; fetch?: FetchLike } = {}) {
  const fetch = opts.fetch ?? mock.fetch;
  const dir = mkdtempSync(join(tmpdir(), 'substrat-stripe-'));
  const landed: PaymentChange[] = [];
  const module: ModuleRegistration = {
    manifest: moduleManifest.parse({
      id: '@test/shop',
      version: '1.0.0',
      kernelContract: '^0.0.1',
      permissions: [{ key: RECORD, description: 'land a payment outcome' }],
      events: { emits: [], consumes: [] },
      migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
      attachmentTargets: [],
      entitlementKey: 'shop',
    }),
    ...undeclaredOperations('a test fixture, built to drive the host rather than declared', {
      [OPERATION]: (async (ctx, input: PaymentChange) => {
        assertAllowed(await ctx.check(RECORD));
        landed.push(input);
        return { ok: true };
      }) as OperationHandler<never, unknown>,
    }),
  };
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const connId: ConnectionId = connectionId.parse(ulid());
  const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(7)), fetch });
  host.registerModule(module);
  await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
  await host.admin.grantEntitlement(staff, t, 'shop');
  await host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu', vertical: 'shop' });
  await host.admin.activateScope(staff, t, s);
  await host.admin.createConnection(staff, { id: connId, tenantId: t, vertical: 'shop', provider: 'stripe', label: 'Acme Stripe', secret: mock.secret });
  await host.admin.grantToConnection(staff, { connectionId: connId, permission: RECORD, node: { tenantId: t, scopeId: s }, grantedBy: staff });

  const clock = opts.clock ?? { ms: Date.parse('2026-11-15T10:00:00Z') };
  mock.useClock(() => clock.ms);
  const callbackBase = opts.callbackBase === null ? undefined : (opts.callbackBase ?? CALLBACK_BASE);
  const options: StripeConnectorOptions = { fetch, now: () => clock.ms, sleep: async () => {}, ...(callbackBase ? { callbackBase } : {}) };
  const connection = { id: connId, tenantId: t, vertical: 'shop' };
  const order = (over: Record<string, unknown> = {}) =>
    connectionCheckoutRequest.parse({
      tenantId: t,
      scopeId: s,
      provider: 'stripe',
      reference: 'order-17',
      currency: 'SEK',
      lines: [
        { name: 'Mug', quantity: 2, unitAmount: '99.50' },
        { name: 'Postage', quantity: 1, unitAmount: '50' },
      ],
      successUrl: 'https://shop.example.com/paid',
      cancelUrl: 'https://shop.example.com/cart',
      ...over,
    });

  return {
    host,
    connId,
    tenantId: t,
    scopeId: s,
    clock,
    landed,
    options,
    order,
    bind: () => bindStripeScope(host, { connectionId: connId, tenantId: t, scopeId: s, vertical: 'shop', operation: OPERATION, permission: RECORD }),
    checkout: (over: Record<string, unknown> = {}) => createStripeCheckout(host, connection, s, order(over), options),
    sweep: () => sweepStripe(host, connId, options),
    /** The tenant re-pastes a key, as the platform takes one: judged against the stored key, then stored in its place. */
    repaste: async (secretKey: string) => {
      const previous = (await host.admin.openConnection(t, 'shop', 'stripe'))!.secret;
      const { secret } = await prepareStripeCandidate(options)({ secretKey }, previous);
      await host.admin.updateConnectionSecret(staff, connId, secret);
    },
    /** A credential written straight into the store, past the platform's judgement of a re-paste. */
    overwriteKey: (secret: Record<string, string>) => host.admin.updateConnectionSecret(staff, connId, secret),
    /** Deliver `event` to the connector the way the control plane's route would, with the path Stripe was given. */
    deliver: async (event: Record<string, unknown>, tamper: { token?: string; body?: string; at?: number } = {}) => {
      const d = await mock.delivery(event, tamper.at ?? Math.floor(clock.ms / 1000));
      const [, , , connection, token] = new URL(d.url).pathname.split('/');
      return handleStripeCallback(host, { connectionId: connection!, token: tamper.token ?? token! }, { body: tamper.body ?? d.body, signature: d.signature }, options);
    },
    close: () => {
      host.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export type World = Awaited<ReturnType<typeof world>>;
