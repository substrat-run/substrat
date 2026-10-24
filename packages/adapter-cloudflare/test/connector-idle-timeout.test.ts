import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { connectionId, platformActorId, scopeId, tenantId, type DomainEvent } from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox, type ByteStream, type ConnectorResponse, type FetchLike } from '@substrat-run/kernel';
import { CloudflareScopeHost } from './test-host.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * The hosted twin of the pure adapter's suite of the same name (#2518): on workerd, a streamed
 * connector response body is bounded by idleness, not by total transfer time. The provider is a
 * stand-in whose body trickles on a real timer, so the call's `timeoutMs` is shorter than the
 * transfer. Exact boundaries are held on a clock the test moves in the kernel's
 * `deadline-fetch.test.ts`; here the host's wiring is.
 */

const GAP_MS = 40;
const CHUNKS = 10;

/**
 * A body of `chunks` chunks, one every `GAP_MS`, then either its end or silence. It errors when the
 * call's signal aborts, as a runtime's response body does.
 */
function trickle(chunks: number, then: 'end' | 'silence', seen: { cancelled: boolean; signal?: AbortSignal }): ConnectorResponse {
  let sent = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      seen.signal?.addEventListener(
        'abort',
        () => {
          seen.cancelled = true; // released: the provider's side let go of the transfer
          clearInterval(timer);
          controller.error(seen.signal!.reason);
        },
        { once: true },
      );
      timer = setInterval(() => {
        if (sent < chunks) {
          controller.enqueue(new Uint8Array(10).fill(1));
          sent++;
        } else if (then === 'end') {
          clearInterval(timer);
          controller.close();
        }
      }, GAP_MS);
    },
    cancel() {
      seen.cancelled = true;
      clearInterval(timer);
    },
  });
  return new Response(body) as unknown as ConnectorResponse;
}

async function drain(stream: ByteStream): Promise<number> {
  const reader = stream.getReader();
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return size;
    size += value!.byteLength;
  }
}

describe("a streamed response body through a connection's fetch, hosted (#2518)", () => {
  beforeAll(() => warmControlPlane(env.CONTROL_PLANE));
  const staff = platformActorId.parse(ulid());

  /** Run `read` against the response the stand-in provider gives, as a connector would. */
  async function connectorRead(
    provider: (seen: { cancelled: boolean; signal?: AbortSignal }) => ConnectorResponse,
    bounds: { timeoutMs: number; streamIdleTimeoutMs: number },
    read: (res: ConnectorResponse) => Promise<number>,
  ) {
    const seen: { cancelled: boolean; signal?: AbortSignal } = { cancelled: false };
    const fetch: FetchLike = async (_input, init) => {
      seen.signal = init?.signal as AbortSignal;
      return provider(seen);
    };
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      fetch,
      streamIdleTimeoutMs: bounds.streamIdleTimeoutMs,
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
    let outcome: { size: number } | { error: Error } | undefined;
    await host.dispatchConnector(
      t,
      s,
      async (ctx) => {
        const conn = await ctx.connection('drive');
        try {
          outcome = { size: await read(await conn.fetch('https://provider.invalid/file')) };
        } catch (error) {
          outcome = { error: error as Error };
        }
      },
      { id: ulid(), type: 'doc.fetch-requested', payload: {} } as unknown as DomainEvent,
      { timeoutMs: bounds.timeoutMs },
    );
    return { outcome: outcome!, seen };
  }

  // 10 chunks 40 ms apart is ~400 ms of transfer: more than timeoutMs, never 300 ms of silence.
  const BOUNDS = { timeoutMs: 200, streamIdleTimeoutMs: 300 };

  it('a slow-but-steady stream outlasting timeoutMs completes', async () => {
    const { outcome, seen } = await connectorRead((s) => trickle(CHUNKS, 'end', s), BOUNDS, (res) => drain(res.body as ByteStream));
    expect(outcome).toEqual({ size: CHUNKS * 10 });
    expect(seen.signal?.aborted).toBe(false);
  });

  it('the twin: the same body read buffered is still cut at timeoutMs', async () => {
    const { outcome, seen } = await connectorRead(
      (s) => trickle(CHUNKS, 'end', s),
      BOUNDS,
      async (res) => (await res.arrayBuffer()).byteLength,
    );
    expect('error' in outcome && outcome.error.name).toBe('TimeoutError');
    expect(seen.signal?.aborted).toBe(true);
  });

  it('a stalled stream errors with a TimeoutError and the connection is released', async () => {
    const { outcome, seen } = await connectorRead(
      (s) => trickle(2, 'silence', s),
      { timeoutMs: 5_000, streamIdleTimeoutMs: 150 },
      (res) => drain(res.body as ByteStream),
    );
    expect('error' in outcome && outcome.error.name).toBe('TimeoutError');
    expect(seen.cancelled).toBe(true);
    expect(seen.signal?.aborted).toBe(true);
  });
});
