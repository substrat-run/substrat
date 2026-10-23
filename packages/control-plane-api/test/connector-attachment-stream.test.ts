import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { mountPlatformSurface, type VerticalScopeHost } from '@substrat-run/vertical-host';
import { connectionId as connectionIdOf, scopeId as scopeIdOf, substratError, tenantId as tenantIdOf } from '@substrat-run/contracts';
import { isSizedByteStream, ulid, type ByteBody, type SizedByteStream } from '@substrat-run/kernel';
import { VerticalClient, ControlPlaneError } from '../src/index.js';

/**
 * The streamed connector upload END TO END (#2498): the real `VerticalClient` against the real
 * `mountPlatformSurface` route, as `connector-writeback.test.ts` does for the multipart one.
 *
 * What it holds is that neither end collects the body: the producer below makes each chunk only
 * when it is asked for, and the host at the far end reads the stream it was handed and records
 * how far the producer ever got ahead of it. Anything in between that buffered the body (a
 * `formData()`, an `arrayBuffer()`, a `Blob`) would drain the producer before the host read its
 * first byte, and the lead would be the whole body.
 */

type Env = { PLATFORM_SECRET: string };
const SECRET = 'sekret';
const ENV: Env = { PLATFORM_SECRET: SECRET };

const t = tenantIdOf.parse(ulid());
const s = scopeIdOf.parse(ulid());
const conn = connectionIdOf.parse(ulid());

const CHUNK = 256 * 1024;
const CHUNKS = 64; // 16 MiB

/** Chunk `i` of the generated body: its bytes depend on `i`, so a lost or reordered chunk shows in the hash. */
const chunkOf = (i: number): Uint8Array => new Uint8Array(CHUNK).fill(i % 251);

function expectedSha256(chunks: number): string {
  const hash = createHash('sha256');
  for (let i = 0; i < chunks; i++) hash.update(chunkOf(i));
  return hash.digest('hex');
}

/**
 * How far a body's producer has got ahead of its consumer. The producer measures it each time it
 * is asked for a chunk, so a hop that drains the producer before the consumer reads (a buffer)
 * shows as a lead of the whole body, however the bytes are later handed on.
 */
interface Flow {
  produced: number;
  consumed: number;
  maxLead: number;
}

/** A body made one chunk at a time, on demand, measuring its lead over `flow.consumed`. */
function producer(chunks: number) {
  const state: Flow = { produced: 0, consumed: 0, maxLead: 0 };
  let i = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (i === chunks) {
          controller.close();
          return;
        }
        const chunk = chunkOf(i++);
        state.produced += chunk.byteLength;
        state.maxLead = Math.max(state.maxLead, state.produced - state.consumed);
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  return { state, stream };
}

/** What the far end's host was handed, read chunk by chunk. */
interface Landed {
  streamed: boolean;
  declared: number;
  size: number;
  sha256: string;
  maxLead: number;
  filename: string;
}

function world(flow: Flow = { produced: 0, consumed: 0, maxLead: 0 }, overrides: Partial<VerticalScopeHost> = {}) {
  const landed: Landed[] = [];
  const host = {
    connectorAttachmentUploadLocal: async (...args: unknown[]) => {
      const upload = args[3] as { filename: string; body: ByteBody };
      const hash = createHash('sha256');
      let size = 0;
      if (isSizedByteStream(upload.body)) {
        const reader = upload.body.stream.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          size += value.byteLength;
          flow.consumed = size;
          hash.update(value);
          // A slow sink, as R2 is: a hop that pulled ahead of its reader would queue the body here.
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      } else {
        size = upload.body.byteLength;
        hash.update(upload.body);
      }
      landed.push({
        streamed: isSizedByteStream(upload.body),
        declared: isSizedByteStream(upload.body) ? upload.body.length : upload.body.byteLength,
        size,
        sha256: hash.digest('hex'),
        maxLead: flow.maxLead,
        filename: upload.filename,
      });
      return { id: 'att1', filename: upload.filename, size };
    },
    ...overrides,
  } as unknown as VerticalScopeHost;
  const app = new Hono<{ Bindings: Env }>();
  mountPlatformSurface<Env>(app, {
    platformSecret: (env) => env.PLATFORM_SECRET,
    hostFor: () => host,
    roles: [],
    ownerRoleKey: 'admin',
  });
  const client = new VerticalClient({
    fetch: ((input: RequestInfo, init?: RequestInit) => app.request(input, init, ENV)) as typeof fetch,
    platformSecret: SECRET,
  });
  return { client, landed };
}

const upload = (body: ByteBody, filename = 'drawing-set.pdf') => ({
  connectionId: conn,
  tenantId: t,
  scopeId: s,
  entity: { entityType: 'document', entityId: 'd1' },
  filename,
  contentType: 'application/pdf',
  visibility: 'internal' as const,
  body,
});

describe('VerticalClient ↔ mountPlatformSurface — streamed connector upload (#2498)', () => {
  it('a stream reaches the far host as a stream, chunk by chunk, never collected on the way', async () => {
    const source = producer(CHUNKS);
    const { client, landed } = world(source.state);
    const body: SizedByteStream = { stream: source.stream, length: CHUNK * CHUNKS };
    await client.connectorUploadAttachment(upload(body));
    expect(landed).toHaveLength(1);
    const [got] = landed;
    expect(got!.streamed).toBe(true);
    expect(got!.declared).toBe(CHUNK * CHUNKS);
    expect(got!.size).toBe(CHUNK * CHUNKS);
    expect(got!.sha256).toBe(expectedSha256(CHUNKS));
    // A buffered hop would have drained all 16 MiB before the host's first read.
    expect(got!.maxLead).toBeLessThanOrEqual(4 * CHUNK);
  });

  it('the positive twin: a buffer still takes the multipart route and arrives as a buffer', async () => {
    const { client, landed } = world();
    const bytes = new TextEncoder().encode('the sealed pdf bytes');
    await client.connectorUploadAttachment(upload(bytes));
    expect(landed[0]).toMatchObject({ streamed: false, size: bytes.byteLength });
    expect(landed[0]!.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('a filename outside ASCII survives the metadata header', async () => {
    const source = producer(1);
    const { client, landed } = world(source.state);
    await client.connectorUploadAttachment(upload({ stream: source.stream, length: CHUNK }, 'Årsredovisning – utkast.pdf'));
    expect(landed[0]!.filename).toBe('Årsredovisning – utkast.pdf');
  });

  it('a stream carrying more than it declared is refused, and nothing lands', async () => {
    const source = producer(2);
    const { client, landed } = world(source.state);
    await expect(client.connectorUploadAttachment(upload({ stream: source.stream, length: CHUNK }))).rejects.toThrow();
    expect(landed).toEqual([]);
  });

  it('a deployment without the route is told to re-push, not handed a parser error', async () => {
    const client = new VerticalClient({
      fetch: (async () => new Response('404 Not Found', { status: 404 })) as typeof fetch,
      platformSecret: SECRET,
    });
    const source = producer(1);
    const err = await client
      .connectorUploadAttachment(upload({ stream: source.stream, length: CHUNK }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect((err as ControlPlaneError).status).toBe(501);
    expect((err as ControlPlaneError).message).toMatch(/predates streamed connector uploads.*re-push/);
  });

  it("the route's own 404 (an unknown scope) stays a 404 refusal, not a re-push", async () => {
    const { client } = world(undefined, {
      connectorAttachmentUploadLocal: async () => {
        throw substratError('not_found', `unknown scope ${s}`);
      },
    });
    const source = producer(1);
    const err = await client
      .connectorUploadAttachment(upload({ stream: source.stream, length: CHUNK }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect((err as ControlPlaneError).status).toBe(404);
    expect((err as ControlPlaneError).message).not.toMatch(/re-push/);
  });

  it('a stream route call without the platform secret reaches no host', async () => {
    const app = new Hono<{ Bindings: Env }>();
    mountPlatformSurface<Env>(app, {
      platformSecret: (env) => env.PLATFORM_SECRET,
      hostFor: () => {
        throw new Error('host must never be reached');
      },
      roles: [],
      ownerRoleKey: 'admin',
    });
    const wrong = new VerticalClient({
      fetch: ((input: RequestInfo, init?: RequestInit) => app.request(input, init, ENV)) as typeof fetch,
      platformSecret: 'not-the-secret',
    });
    const source = producer(1);
    const err = await wrong
      .connectorUploadAttachment(upload({ stream: source.stream, length: CHUNK }))
      .catch((e: unknown) => e);
    expect((err as ControlPlaneError).status).toBe(403);
  });
});
