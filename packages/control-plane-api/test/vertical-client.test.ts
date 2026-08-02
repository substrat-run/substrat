import { describe, it, expect } from 'vitest';
import { tenantId, scopeId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { VerticalClient, ControlPlaneError } from '../src/index.js';

/**
 * The transport seam (#391): a dispatch/cold-start REJECTION (the fetch itself throws)
 * is not a vertical's answer — before the fix it propagated raw and the API boundary
 * collapsed it to the generic 500 "internal error". It must surface as a 502 naming the
 * verb and the runtime's own message, while a non-ok RESPONSE keeps passing through as
 * the vertical's own status.
 */

const t = tenantId.parse(ulid());
const s = scopeId.parse(ulid());

const rejecting = (message: string) =>
  new VerticalClient({
    fetch: (() => Promise.reject(new Error(message))) as unknown as typeof fetch,
    platformSecret: 'secret',
  });

describe('VerticalClient — transport rejections become diagnosable 502s (#391)', () => {
  it('configureInstance: a thrown fetch is a 502 naming the verb and the cause', async () => {
    const err = await rejecting('Worker threw exception')
      .configureInstance({ tenantId: t, scopeId: s, entries: [{ key: 'k', value: 'v' }] })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect((err as ControlPlaneError).status).toBe(502);
    expect((err as ControlPlaneError).message).toBe(
      'vertical unreachable during configure: Worker threw exception',
    );
  });

  it('provisionInstance and introspection reads wrap the same way', async () => {
    const client = rejecting('Durable Object reset');
    await expect(
      client.provisionInstance({ tenantId: t, scopeId: s, owner: 'o' as never, slug: 'x', name: 'X' }),
    ).rejects.toThrow(/vertical unreachable during provisioning: Durable Object reset/);
    await expect(client.listScopeTables(s)).rejects.toThrow(
      /vertical unreachable during introspection: Durable Object reset/,
    );
  });

  it("a non-ok RESPONSE is still the vertical's own answer, not a 502", async () => {
    const client = new VerticalClient({
      fetch: (async () =>
        new Response(JSON.stringify({ error: 'no live-config support' }), { status: 501 })) as unknown as typeof fetch,
      platformSecret: 'secret',
    });
    const err = await client
      .configureInstance({ tenantId: t, scopeId: s, entries: [] })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect((err as ControlPlaneError).status).toBe(501);
    expect((err as ControlPlaneError).message).toBe('no live-config support');
  });
});
