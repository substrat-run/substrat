import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { mountPlatformSurface, type VerticalScopeHost } from '@substrat-run/vertical-host';
import {
  connectionId as connectionIdOf,
  scopeId as scopeIdOf,
  substratError,
  tenantId as tenantIdOf,
} from '@substrat-run/contracts';
import { ulid, verifiedStream, type IncrementalSha256 } from '@substrat-run/kernel';
import { ControlPlaneError, VerticalClient, type VerticalClientOptions } from '../src/index.js';

/**
 * The platform's streamed attachment read (#2514): `VerticalClient.connectorOpenAttachmentStream`
 * against the real `mountPlatformSurface` route. The bytes are handed on as they come off the
 * response, held to the record in its header, and bounded in time by `deadlineFetch`. Every bound on
 * memory is measured by the deployment's producer, against what the client's caller has read.
 */

type Env = { PLATFORM_SECRET: string };
const SECRET = 'sekret';
const ENV: Env = { PLATFORM_SECRET: SECRET };
const t = tenantIdOf.parse(ulid());
const s = scopeIdOf.parse(ulid());
const conn = connectionIdOf.parse(ulid());
const args = { connectionId: conn, tenantId: t, scopeId: s, attachmentId: 'att-1' };

const KiB = 1024;
const MiB = 1024 * KiB;

const nodeSha256 = (): IncrementalSha256 => {
  const hash = createHash('sha256');
  return { update: (c) => void hash.update(c), hex: async () => hash.digest('hex') };
};

interface Flow {
  produced: number;
  consumed: number;
  maxLead: number;
  cancelled: number;
}

/** The deployment's object: `chunks` chunks of `size`, each made only when asked for. */
function object(chunks: number, size: number) {
  const chunkOf = (i: number) => new Uint8Array(size).fill(i % 251);
  const hash = createHash('sha256');
  for (let i = 0; i < chunks; i++) hash.update(chunkOf(i));
  const sha256 = hash.digest('hex');
  const flow: Flow = { produced: 0, consumed: 0, maxLead: 0, cancelled: 0 };
  const stream = () => {
    let i = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (i === chunks) return controller.close();
          const chunk = chunkOf(i++);
          flow.produced += chunk.byteLength;
          flow.maxLead = Math.max(flow.maxLead, flow.produced - flow.consumed);
          controller.enqueue(chunk);
        },
        cancel() {
          flow.cancelled++;
        },
      },
      { highWaterMark: 0 },
    );
  };
  const whole = () => {
    const out = new Uint8Array(chunks * size);
    for (let i = 0; i < chunks; i++) out.set(chunkOf(i), i * size);
    return out;
  };
  return { flow, stream, whole, sha256, size: chunks * size };
}

const recordOf = (size: number, sha256: string) => ({
  id: 'att-1',
  entity: { entityType: 'protocol', entityId: 'p1' },
  filename: 'avtal.pdf',
  contentType: 'application/pdf',
  size,
  sha256,
  visibility: 'customer',
  createdBy: conn,
  createdAt: '2026-10-25T00:00:00.000Z',
});

/** The route over `host`, and a client reaching it in process. */
function world(host: Partial<VerticalScopeHost>, options: Partial<VerticalClientOptions> = {}) {
  const app = new Hono<{ Bindings: Env }>();
  mountPlatformSurface<Env>(app, {
    platformSecret: (env) => env.PLATFORM_SECRET,
    hostFor: () => host as VerticalScopeHost,
    roles: [],
    ownerRoleKey: 'admin',
  });
  const client = new VerticalClient({
    fetch: ((input: RequestInfo, init?: RequestInit) => app.request(input, init, ENV)) as typeof fetch,
    platformSecret: SECRET,
    attachmentStream: { sha256: nodeSha256 },
    ...options,
  });
  return { app, client };
}

/** A deployment that streams `o` against a record with `sha256` (the object's own by default). */
const streaming = (o: ReturnType<typeof object>, sha256 = o.sha256): Partial<VerticalScopeHost> => {
  const record = recordOf(o.size, sha256);
  return {
    connectorAttachmentOpenLocal: async () => {
      throw new Error('the buffered open was asked');
    },
    connectorAttachmentOpenStreamLocal: async () => ({
      record,
      body: verifiedStream({ stream: o.stream(), length: o.size }, record, nodeSha256()),
      contentType: 'application/pdf',
    }),
  };
};

/** A deployment from before #2514: the buffered open only, answering `body` against a record of `o`. */
const buffered = (o: ReturnType<typeof object>, body = o.whole()): Partial<VerticalScopeHost> => ({
  connectorAttachmentOpenLocal: async () => ({ record: recordOf(o.size, o.sha256), body, contentType: 'application/pdf' }),
});

/** Read a stream, slowly when counting into `flow` (a macrotask per chunk): its size and digest, or the error. */
async function read(stream: ReadableStream<Uint8Array>, flow?: Flow) {
  const reader = stream.getReader();
  const hash = createHash('sha256');
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { ok: true as const, size, sha256: hash.digest('hex') };
      size += value.byteLength;
      hash.update(value);
      if (flow) {
        flow.consumed = size;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  } catch (error) {
    return { ok: false as const, size, error };
  }
}

const streamOf = async (client: VerticalClient) => {
  const opened = await client.connectorOpenAttachmentStream(args);
  expect(opened).not.toBeNull();
  return opened!;
};

describe('VerticalClient.connectorOpenAttachmentStream (#2514)', () => {
  it('hands the bytes on as they come off the response, held to the record, a chunk or two ahead', async () => {
    const o = object(64, 256 * KiB); // 16 MiB
    const { client } = world(streaming(o));
    const opened = await streamOf(client);
    expect(opened.record).toEqual(recordOf(o.size, o.sha256));
    expect(opened.contentType).toBe('application/pdf');
    expect(opened.body.length).toBe(o.size);
    expect(await read(opened.body.stream as ReadableStream<Uint8Array>, o.flow)).toEqual({ ok: true, size: o.size, sha256: o.sha256 });
    // Anything on the way that collected the body would lead by all 16 MiB.
    expect(o.flow.maxLead).toBeLessThanOrEqual(1 * MiB);
  });

  it('keeps about one chunk in memory however large the file (the GC pattern of #2551)', async () => {
    const v8 = await import('node:v8');
    const vm = await import('node:vm');
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const o = object(120, MiB);
    const { client } = world(streaming(o));
    const buffers = () => process.memoryUsage().arrayBuffers;
    for (let i = 0; i < 3; i++) gc();
    const before = buffers();
    const reader = (await streamOf(client)).body.stream.getReader();
    let size = 0;
    let peak = 0;
    for (let n = 1; ; n++) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value!.byteLength;
      // Measured while the stream is live: a chunk kept per read is unreachable again once it ends.
      if (n % 10 === 0) {
        gc();
        await new Promise((resolve) => setTimeout(resolve, 0));
        peak = Math.max(peak, buffers() - before);
      }
    }
    expect(size).toBe(120 * MiB);
    // 120 MiB went through; a body held at any hop would leave tens of MiB live at a sample.
    expect(peak).toBeLessThan(16 * MiB);
  }, 60_000);

  it('a deployment from before #2514 answers in full, and the bytes are still handed on, held to the record', async () => {
    const o = object(8, 256 * KiB);
    const { client } = world(buffered(o));
    expect(await read((await streamOf(client)).body.stream as ReadableStream<Uint8Array>)).toEqual({
      ok: true,
      size: o.size,
      sha256: o.sha256,
    });
  });

  describe('integrity: the stream errors with the buffered read’s refusal, never ends short', () => {
    const integrityError = (out: Awaited<ReturnType<typeof read>>) => {
      expect(out.ok).toBe(false);
      const err = (out as { error: unknown }).error;
      expect(err).toBeInstanceOf(ControlPlaneError);
      expect(err).toMatchObject({ status: 502, code: 'internal' });
      expect((err as Error).message).toMatch(/attachment att-1 failed its integrity check/);
      return err as ControlPlaneError;
    };

    it('a streaming deployment that cuts a mismatched body: refused, and the caller never has every byte', async () => {
      const o = object(8, 256 * KiB);
      const { client } = world(streaming(o, 'b'.repeat(64)));
      const out = await read((await streamOf(client)).body.stream as ReadableStream<Uint8Array>);
      integrityError(out);
      expect(out.size).toBeLessThan(o.size);
    });

    it('an old deployment’s whole body that does not match: refused before its last chunk', async () => {
      const o = object(8, 256 * KiB);
      const { client } = world(buffered(o, new Uint8Array(o.size).fill(9)));
      const out = await read((await streamOf(client)).body.stream as ReadableStream<Uint8Array>);
      expect((integrityError(out) as Error).message).toMatch(/do not match the recorded sha256/);
      expect(out.size).toBeLessThan(o.size);
    });

    it('a body shorter than the record: refused', async () => {
      const o = object(8, 256 * KiB);
      const { client } = world(buffered(o, new Uint8Array(3 * 256 * KiB)));
      const out = await read((await streamOf(client)).body.stream as ReadableStream<Uint8Array>);
      expect((integrityError(out) as Error).message).toMatch(/ended after 786432 bytes; its record says 2097152/);
    });

    it('over a real socket too: a cut body is the integrity refusal, not a bare network error', async () => {
      const o = object(16, 256 * KiB);
      const { app } = world(streaming(o, 'b'.repeat(64)));
      const server = await listen(app);
      const client = new VerticalClient({
        fetch: globalThis.fetch,
        platformSecret: SECRET,
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        attachmentStream: { sha256: nodeSha256 },
      });
      const out = await read((await streamOf(client)).body.stream as ReadableStream<Uint8Array>);
      integrityError(out);
      expect(out.size).toBeLessThan(o.size);
    });
  });

  it('a deployment that stalls mid-body: the idle window errors it as a 504, and the deployment’s read is let go', async () => {
    const o = object(64, 64 * KiB);
    let served = 0;
    const record = recordOf(o.size, o.sha256);
    const stalling: Partial<VerticalScopeHost> = {
      connectorAttachmentOpenStreamLocal: async () => {
        const source = o.stream().getReader();
        const stream = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              // Two chunks, then silence.
              if (served++ >= 2) return new Promise<void>(() => {});
              const { value } = await source.read();
              controller.enqueue(value!);
            },
            cancel: (reason) => source.cancel(reason),
          },
          { highWaterMark: 0 },
        );
        return { record, body: { stream, length: o.size }, contentType: 'application/pdf' };
      },
    };
    const { client } = world(stalling, { attachmentStream: { sha256: nodeSha256, idleMs: 100 } });
    const out = await read((await streamOf(client)).body.stream as ReadableStream<Uint8Array>);
    expect(out.ok).toBe(false);
    const err = (out as { error: unknown }).error;
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err).toMatchObject({ status: 504, code: 'unavailable' });
    expect((err as Error).message).toMatch(/timed out: The response body stalled: no bytes for 100 ms/);
    expect(out.size).toBe(2 * 64 * KiB);
  });

  it('its twin: a deployment that keeps sending outlasts the call timeout', async () => {
    const o = object(8, 64 * KiB);
    const record = recordOf(o.size, o.sha256);
    const trickle: Partial<VerticalScopeHost> = {
      connectorAttachmentOpenStreamLocal: async () => {
        const source = o.stream().getReader();
        const stream = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              await new Promise((resolve) => setTimeout(resolve, 40));
              const { done, value } = await source.read();
              if (done) controller.close();
              else controller.enqueue(value);
            },
          },
          { highWaterMark: 0 },
        );
        return { record, body: { stream, length: o.size }, contentType: 'application/pdf' };
      },
    };
    // 8 chunks 40 ms apart is ~320 ms, past the 100 ms call timeout, and never 200 ms of silence.
    const { client } = world(trickle, { attachmentStream: { sha256: nodeSha256, timeoutMs: 100, idleMs: 200 } });
    expect(await read((await streamOf(client)).body.stream as ReadableStream<Uint8Array>)).toEqual({
      ok: true,
      size: o.size,
      sha256: o.sha256,
    });
  });

  it('a caller that cancels lets the deployment’s object go', async () => {
    const o = object(64, 256 * KiB);
    const { client } = world(streaming(o));
    const reader = (await streamOf(client)).body.stream.getReader();
    await reader.read();
    await reader.cancel('done early');
    // The cancel crosses the in-process response; give its settlement a turn.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(o.flow.cancelled).toBe(1);
    expect(o.flow.produced).toBeLessThan(o.size);
  });

  it('an id the deployment does not know is null; a refusal is thrown before any byte, as the buffered read does', async () => {
    expect(await world({ connectorAttachmentOpenStreamLocal: async () => null }).client.connectorOpenAttachmentStream(args)).toBeNull();
    const refused = world({
      connectorAttachmentOpenStreamLocal: async () => {
        throw substratError('permission_denied', 'connection lacks protocol:read');
      },
    });
    await expect(refused.client.connectorOpenAttachmentStream(args)).rejects.toMatchObject({ status: 403 });
  });

  it('a runtime with no running sha256 and none passed is refused before anything is sent', async () => {
    let sent = 0;
    const client = new VerticalClient({
      fetch: (async () => {
        sent++;
        return new Response(null);
      }) as unknown as typeof fetch,
      platformSecret: SECRET,
    });
    await expect(client.connectorOpenAttachmentStream(args)).rejects.toMatchObject({ status: 500 });
    expect(sent).toBe(0);
  });
});

const servers: ServerType[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function listen(app: Hono<{ Bindings: Env }>): Promise<ServerType> {
  const server = await new Promise<ServerType>((resolve) => {
    const started: ServerType = serve({ fetch: (req) => app.fetch(req, ENV), port: 0 }, () => resolve(started));
  });
  servers.push(server);
  return server;
}
