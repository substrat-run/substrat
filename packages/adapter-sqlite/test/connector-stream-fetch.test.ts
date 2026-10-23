import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectionId, platformActorId, scopeId, tenantId, type DomainEvent } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox, type ConnectorResponse, type FetchLike } from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * A sized stream body sent through a connection's `fetch` reaches whatever `fetch` the host was
 * given converted (#2498): the host passes its injected `fetch` through `fetchLikeOf`, so it is
 * not only `globalFetch` that can send one. The stand-in below does what a runtime `fetch` does
 * with an init, builds a `Request` from it, and answers with what that request carried. A body
 * that reached it unconverted would be sent as its string form, which the twin shows.
 */

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
const sha256Of = (chunks: number) => {
  const hash = createHash('sha256');
  for (let i = 0; i < chunks; i++) hash.update(chunkOf(i));
  return hash.digest('hex');
};

/** What one request carried, as a runtime would send it. */
interface Sent {
  contentLength: string | null;
  size: number;
  sha256: string;
}

/** A runtime-shaped `fetch`: it builds a `Request` from the init it is handed, as `fetch` does. */
function runtimeStandIn(sent: Sent[]): FetchLike {
  return (async (input: string, init?: RequestInit) => {
    const request = new Request(input, init);
    const bytes = new Uint8Array(await request.arrayBuffer());
    sent.push({
      contentLength: request.headers.get('content-length'),
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    return new Response('{}', { status: 200 }) as unknown as ConnectorResponse;
  }) as unknown as FetchLike;
}

describe("a sized body through a connection's fetch, whatever fetch the host was given (#2498)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reaches an injected runtime fetch as its bytes, at its declared length', async () => {
    const sent: Sent[] = [];
    dir = mkdtempSync(join(tmpdir(), 'substrat-connector-stream-'));
    const host = new SqliteScopeHost({
      dir,
      secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(5)),
      fetch: runtimeStandIn(sent),
    });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
    await host.admin.createConnection(staff, {
      id: connectionId.parse(ulid()),
      tenantId: t,
      vertical: 'docs',
      provider: 'drive',
      label: 'drive',
      externalAccountRef: 'acct-1',
      scopes: [],
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
    expect(sent).toEqual([{ contentLength: String(16 * CHUNK), size: 16 * CHUNK, sha256: sha256Of(16) }]);
  });

  it('the twin: the same runtime fetch handed the sized body as it is sends "[object Object]"', async () => {
    const sent: Sent[] = [];
    await runtimeStandIn(sent)('https://provider.invalid/upload', {
      method: 'PUT',
      body: { stream: stream(1), length: CHUNK },
    });
    expect(sent[0]!.size).toBe('[object Object]'.length);
  });
});
