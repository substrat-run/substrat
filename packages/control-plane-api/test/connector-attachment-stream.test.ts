import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { mountPlatformSurface, type VerticalScopeHost } from '@substrat-run/vertical-host';
import {
  CONNECTOR_ATTACHMENT_META_HEADER,
  CONNECTOR_ATTACHMENT_META_MAX_BYTES,
  CONNECTOR_ATTACHMENT_STREAM_MAX_BYTES,
  PLATFORM_SECRET_HEADER,
  connectionId as connectionIdOf,
  connectorAttachmentMetaRefusal,
  connectorAttachmentSizeRefusal,
  scopeId as scopeIdOf,
  substratError,
  tenantId as tenantIdOf,
} from '@substrat-run/contracts';
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
  contentType: string;
}

function world(flow: Flow = { produced: 0, consumed: 0, maxLead: 0 }, overrides: Partial<VerticalScopeHost> = {}) {
  const landed: Landed[] = [];
  const host = {
    connectorAttachmentUploadLocal: async (...args: unknown[]) => {
      const upload = args[3] as { filename: string; contentType: string; body: ByteBody };
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
        contentType: upload.contentType,
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

const upload = (body: ByteBody, filename = 'drawing-set.pdf', contentType = 'application/pdf') => ({
  connectionId: conn,
  tenantId: t,
  scopeId: s,
  entity: { entityType: 'document', entityId: 'd1' },
  filename,
  contentType,
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

  it('a content type no header could carry still reaches the far host, inside the metadata', async () => {
    const source = producer(1);
    const { client, landed } = world(source.state);
    // The multipart route takes the same value; the stream route must not fail it in a header.
    await client.connectorUploadAttachment(upload({ stream: source.stream, length: CHUNK }, 'a.pdf', 'application/pdf\r\nx-evil: 1'));
    expect(landed[0]!.contentType).toBe('application/pdf\r\nx-evil: 1');
  });

  it('a filename no header could carry as it is (a lone surrogate) still reaches the far host', async () => {
    const source = producer(1);
    const { client, landed } = world(source.state);
    await client.connectorUploadAttachment(upload({ stream: source.stream, length: CHUNK }, 'lone-\uD800-surrogate.pdf'));
    expect(landed[0]!.filename).toBe('lone-\uD800-surrogate.pdf');
  });

  it('metadata over its named bound is a typed refusal before a byte is sent, not a server\'s bare 431', async () => {
    let sent = 0;
    const client = new VerticalClient({
      fetch: (async () => {
        sent += 1;
        return new Response('{}', { status: 201 });
      }) as typeof fetch,
      platformSecret: SECRET,
    });
    // 2000 CJK characters: 9 bytes each once encoded, an 18 KB header.
    const err = await client
      .connectorUploadAttachment(upload({ stream: producer(1).stream, length: CHUNK }, `${'報'.repeat(2000)}.pdf`))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect((err as ControlPlaneError).status).toBe(400);
    expect((err as ControlPlaneError).message).toMatch(
      new RegExp(`over the ${CONNECTOR_ATTACHMENT_META_MAX_BYTES}-byte bound.*Nothing was sent`),
    );
    expect(sent).toBe(0);
  });

  it('its twin: a long but realistic name (a 400-character path) is under the bound and lands', async () => {
    const source = producer(1);
    const { client, landed } = world(source.state);
    const name = `${'Projekt/Ritningar/'.repeat(22)}plan.pdf`.slice(0, 400);
    await client.connectorUploadAttachment(upload({ stream: source.stream, length: CHUNK }, name));
    expect(landed[0]!.filename).toBe(name);
  });

  it("the request's own content-type is octet-stream: the file's type travels only in the metadata", async () => {
    const seen: (string | null)[] = [];
    const client = new VerticalClient({
      fetch: (async (_input: RequestInfo, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('content-type'));
        return new Response('{}', { status: 201 });
      }) as typeof fetch,
      platformSecret: SECRET,
    });
    await client.connectorUploadAttachment(upload({ stream: producer(1).stream, length: CHUNK }));
    expect(seen).toEqual(['application/octet-stream']);
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

  it('a declared size over the bound is refused 413 before a byte is sent (#2516)', async () => {
    let sent = 0;
    const client = new VerticalClient({
      fetch: (async () => {
        sent += 1;
        return new Response('{}', { status: 201 });
      }) as typeof fetch,
      platformSecret: SECRET,
    });
    const source = producer(1);
    const err = await client
      .connectorUploadAttachment(upload({ stream: source.stream, length: CONNECTOR_ATTACHMENT_STREAM_MAX_BYTES + 1 }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect((err as ControlPlaneError).status).toBe(413);
    expect((err as ControlPlaneError).message).toContain(connectorAttachmentSizeRefusal(CONNECTOR_ATTACHMENT_STREAM_MAX_BYTES + 1));
    expect(sent).toBe(0);
    expect(source.state.produced).toBe(0);
  });

  it('a buffered upload\'s metadata over its bound is refused before a byte is sent, as a streamed one is (#2516)', async () => {
    let sent = 0;
    const client = new VerticalClient({
      fetch: (async () => {
        sent += 1;
        return new Response('{}', { status: 201 });
      }) as typeof fetch,
      platformSecret: SECRET,
    });
    const err = await client
      .connectorUploadAttachment(upload(new Uint8Array(8), `${'報'.repeat(2000)}.pdf`))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect((err as ControlPlaneError).status).toBe(400);
    expect((err as ControlPlaneError).message).toMatch(
      new RegExp(`over the ${CONNECTOR_ATTACHMENT_META_MAX_BYTES}-byte bound.*Nothing was sent`),
    );
    expect(sent).toBe(0);
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

/**
 * The routes' own answers (#2516), driven without the client, since the client refuses most of
 * these before it sends: what a caller that does not go through it meets. Neither route reaches
 * the host, nor reads a byte, for a request it refuses.
 */
describe('mountPlatformSurface — the bounds on a connector upload (#2516)', () => {
  const metaOf = (filename: string, size?: number) => ({
    connectionId: conn,
    tenantId: t,
    scopeId: s,
    entity: { entityType: 'document', entityId: 'd1' },
    filename,
    contentType: 'application/pdf',
    visibility: 'internal',
    ...(size === undefined ? {} : { size }),
  });
  const longName = `${'報'.repeat(2000)}.pdf`;

  function surface() {
    const reached: unknown[][] = [];
    const host = {
      connectorAttachmentUploadLocal: async (...args: unknown[]) => {
        reached.push(args);
        return { id: 'att1' };
      },
    } as unknown as VerticalScopeHost;
    const app = new Hono<{ Bindings: Env }>();
    mountPlatformSurface<Env>(app, {
      platformSecret: (env) => env.PLATFORM_SECRET,
      hostFor: () => host,
      roles: [],
      ownerRoleKey: 'admin',
    });
    return { app, reached };
  }

  const streamPost = (app: Hono<{ Bindings: Env }>, meta: unknown, body: ReadableStream<Uint8Array> | null) =>
    app.request(
      '/internal/connector-attachment-stream',
      {
        method: 'POST',
        headers: { [PLATFORM_SECRET_HEADER]: SECRET, [CONNECTOR_ATTACHMENT_META_HEADER]: encodeURIComponent(JSON.stringify(meta)) },
        body,
        ...(body ? { duplex: 'half' } : {}),
      } as RequestInit,
      ENV,
    );

  const multipartPost = (app: Hono<{ Bindings: Env }>, meta: unknown) => {
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    form.append('body', new Blob([new Uint8Array(8)]), 'x.pdf');
    return app.request(
      '/internal/connector-attachment',
      { method: 'POST', headers: { [PLATFORM_SECRET_HEADER]: SECRET }, body: form },
      ENV,
    );
  };

  it('a declared size over the bound is a 413, and the body is never read', async () => {
    const { app, reached } = surface();
    const source = producer(1);
    const res = await streamPost(app, metaOf('a.pdf', CONNECTOR_ATTACHMENT_STREAM_MAX_BYTES + 1), source.stream);
    expect(res.status).toBe(413);
    expect(await res.text()).toContain(connectorAttachmentSizeRefusal(CONNECTOR_ATTACHMENT_STREAM_MAX_BYTES + 1));
    expect(reached).toEqual([]);
    expect(source.state.produced).toBe(0);
  });

  it('its twin: a declared size exactly at the bound is let through to the host', async () => {
    const { app, reached } = surface();
    const res = await streamPost(app, metaOf('a.pdf', CONNECTOR_ATTACHMENT_STREAM_MAX_BYTES), producer(1).stream);
    expect(res.status).toBe(201);
    expect(reached).toHaveLength(1);
  });

  it('metadata over its bound is the same 400 on the stream route and on the multipart route', async () => {
    const { app, reached } = surface();
    const streamed = await streamPost(app, metaOf(longName, CHUNK), producer(1).stream);
    const buffered = await multipartPost(app, metaOf(longName));
    expect(streamed.status).toBe(400);
    expect(buffered.status).toBe(400);
    const sentence = (text: string) => /the attachment's metadata is \d+ bytes once encoded, over the 8192-byte bound[^"]*/.exec(text)?.[0];
    expect(sentence(await streamed.text())).toMatch(/shorten the filename$/);
    expect(sentence(await buffered.text())).toMatch(/shorten the filename$/);
    expect(reached).toEqual([]);
    // The sentence is the one the client uses, not a copy of it.
    expect(connectorAttachmentMetaRefusal(18_000)).toContain('over the 8192-byte bound');
  });

  it('its twin: a long but realistic name is accepted by both routes', async () => {
    const { app, reached } = surface();
    const name = `${'Projekt/Ritningar/'.repeat(22)}plan.pdf`.slice(0, 400);
    expect((await streamPost(app, metaOf(name, CHUNK), producer(1).stream)).status).toBe(201);
    expect((await multipartPost(app, metaOf(name))).status).toBe(201);
    expect(reached).toHaveLength(2);
  });
});
