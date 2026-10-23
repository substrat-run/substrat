import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { connectionId, platformActorId, scopeId, tenantId, type DomainEvent } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox, type ConnectorResponse, type FetchLike } from '@substrat-run/kernel';
import { workerdSha256 } from '../src/r2.js';
import { CloudflareScopeHost } from './test-host.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * The hosted twin of the pure adapter's suite of the same name (#2498): on workerd, a sized
 * stream body sent through a connection's `fetch` reaches the `fetch` the host was given as its
 * bytes, because the host passes it through `fetchLikeOf`. The stand-in builds a `Request` from
 * the init it is handed, as the runtime's `fetch` does; one handed the sized body as it is sends
 * its string form, which the twin shows.
 */
describe("a sized body through a connection's fetch, hosted (#2498)", () => {
  beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

  const staff = platformActorId.parse(ulid());
  const CHUNK = 64 * 1024;
  const chunkOf = (i: number): Uint8Array => new Uint8Array(CHUNK).fill(i % 251);
  const stream = (chunks: number) => {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i === chunks) return controller.close();
        controller.enqueue(chunkOf(i++));
      },
    });
  };
  const sha256Of = async (bytes: Uint8Array[]) => {
    const digest = workerdSha256();
    for (const b of bytes) await digest.update(b);
    return digest.hex();
  };

  /** A runtime-shaped `fetch`: it builds a `Request` from the init it is handed, as `fetch` does. */
  const runtimeStandIn = (sent: { size: number; sha256: string }[]): FetchLike =>
    (async (input: string, init?: RequestInit) => {
      const bytes = new Uint8Array(await new Request(input, init).arrayBuffer());
      sent.push({ size: bytes.byteLength, sha256: await sha256Of([bytes]) });
      return new Response('{}', { status: 200 }) as unknown as ConnectorResponse;
    }) as unknown as FetchLike;

  it('reaches an injected runtime fetch as its bytes, at its declared length', async () => {
    const sent: { size: number; sha256: string }[] = [];
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      fetch: runtimeStandIn(sent),
    });
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.createConnection(staff, {
      id: connectionId.parse(ulid()),
      tenantId: t,
      vertical: 'docs',
      provider: 'drive',
      label: 'drive',
      secret: { apiToken: 'tok' },
    });
    await host.dispatchConnector(
      t,
      s,
      async (ctx) => {
        const conn = await ctx.connection('drive');
        await conn.fetch('https://provider.invalid/upload', {
          method: 'PUT',
          body: { stream: stream(16), length: 16 * CHUNK },
        });
      },
      { id: ulid(), type: 'doc.send-requested', payload: {} } as unknown as DomainEvent,
    );
    const expected = await sha256Of(Array.from({ length: 16 }, (_, i) => chunkOf(i)));
    expect(sent).toEqual([{ size: 16 * CHUNK, sha256: expected }]);
  });

  it('the twin: the same runtime fetch handed the sized body as it is sends "[object Object]"', async () => {
    const sent: { size: number; sha256: string }[] = [];
    await runtimeStandIn(sent)('https://provider.invalid/upload', {
      method: 'PUT',
      body: { stream: stream(1), length: CHUNK },
    });
    expect(sent[0]!.size).toBe('[object Object]'.length);
  });
});
