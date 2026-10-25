import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { mountPlatformSurface, type VerticalScopeHost } from '@substrat-run/vertical-host';
import {
  PLATFORM_SECRET_HEADER,
  connectionId as connectionIdOf,
  scopeId as scopeIdOf,
  tenantId as tenantIdOf,
} from '@substrat-run/contracts';
import { ulid, verifiedStream } from '@substrat-run/kernel';
import { ControlPlaneError, VerticalClient } from '../src/index.js';

/**
 * The streamed outbound read on the wire (#2514), over a real HTTP connection: the real
 * `mountPlatformSurface` route served by Node, read by the platform's `VerticalClient` as it stands
 * before its own streamed read. The deployment now sends the bytes as it reads them, at the record's
 * size, on the same path and in the same shape, so today's client reads it unchanged. A body whose
 * bytes do not match the record is cut before its last chunk, and because it was sent with that size
 * the reader sees a broken body, never a shorter file.
 */

type Env = { PLATFORM_SECRET: string };
const SECRET = 'sekret';
const t = tenantIdOf.parse(ulid());
const s = scopeIdOf.parse(ulid());
const conn = connectionIdOf.parse(ulid());

const CHUNK = 256 * 1024;
const chunkOf = (i: number): Uint8Array => new Uint8Array(CHUNK).fill(i % 251);
const sha256Of = (chunks: number) => {
  const hash = createHash('sha256');
  for (let i = 0; i < chunks; i++) hash.update(chunkOf(i));
  return hash.digest('hex');
};
const nodeSha256 = () => {
  const hash = createHash('sha256');
  return { update: (c: Uint8Array) => void hash.update(c), hex: async () => hash.digest('hex') };
};

const producer = (chunks: number) => {
  let i = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (i === chunks) return controller.close();
        controller.enqueue(chunkOf(i++));
      },
    },
    { highWaterMark: 0 },
  );
};

const servers: ServerType[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * The route on a real port, its host streaming `chunks` chunks against a record with `sha256`, or
 * with `buffered` answering from the buffered open with those bytes instead (a host before #2514).
 */
async function deployment(chunks: number, sha256 = sha256Of(chunks), buffered?: Uint8Array) {
  const record = {
    id: 'att-1',
    entity: { entityType: 'protocol', entityId: 'p1' },
    filename: 'avtal.pdf',
    contentType: 'application/pdf',
    size: chunks * CHUNK,
    sha256,
    visibility: 'customer',
    createdBy: conn,
    createdAt: '2026-10-25T00:00:00.000Z',
  };
  const host = (
    buffered
      ? { connectorAttachmentOpenLocal: async () => ({ record, body: buffered, contentType: 'application/pdf' }) }
      : {
          connectorAttachmentOpenLocal: async () => {
            throw new Error('the buffered open was asked');
          },
          connectorAttachmentOpenStreamLocal: async () => ({
            record,
            body: verifiedStream({ stream: producer(chunks), length: record.size }, record, nodeSha256()),
            contentType: 'application/pdf',
          }),
        }
  ) as unknown as VerticalScopeHost;
  const app = new Hono<{ Bindings: Env }>();
  mountPlatformSurface<Env>(app, {
    platformSecret: (env) => env.PLATFORM_SECRET,
    hostFor: () => host,
    roles: [],
    ownerRoleKey: 'admin',
  });
  const server = await new Promise<ServerType>((resolve) => {
    const started: ServerType = serve({ fetch: (req) => app.fetch(req, { PLATFORM_SECRET: SECRET }), port: 0 }, () =>
      resolve(started),
    );
  });
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new VerticalClient({ fetch: globalThis.fetch, platformSecret: SECRET, baseUrl });
  const url = `${baseUrl}/internal/connector-attachment/att-1?connectionId=${conn}&tenantId=${t}&scopeId=${s}`;
  return { client, record, url };
}

describe('the streamed connector-attachment read on the wire (#2514)', () => {
  it("today's buffered client reads the streamed answer whole, sent with the record's size", async () => {
    const { client, record, url } = await deployment(32); // 8 MiB
    const opened = await client.connectorOpenAttachment({ connectionId: conn, tenantId: t, scopeId: s, attachmentId: 'att-1' });
    expect(opened!.record).toEqual(record);
    expect(opened!.body.byteLength).toBe(record.size);
    expect(createHash('sha256').update(opened!.body).digest('hex')).toBe(record.sha256);
    const head = await fetch(url, { headers: { [PLATFORM_SECRET_HEADER]: SECRET } });
    expect(head.headers.get('content-length')).toBe(String(record.size));
    await head.body!.cancel();
  });

  const open = (client: VerticalClient) =>
    client.connectorOpenAttachment({ connectionId: conn, tenantId: t, scopeId: s, attachmentId: 'att-1' });
  const refusal = async (p: Promise<unknown>) => {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ControlPlaneError);
    return err as ControlPlaneError;
  };

  it('a body the deployment cuts on a mismatch is an integrity refusal, not a bare network error', async () => {
    const { client } = await deployment(16, 'b'.repeat(64));
    const err = await refusal(open(client));
    expect(err).toMatchObject({ status: 502, code: 'internal' });
    expect(err.message).toMatch(/attachment att-1 failed its integrity check: its body broke off before the 4194304 bytes/);
    // The transport's own error is kept as the cause, for whoever diagnoses it.
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('a whole body of another length than the record names is refused by the client itself', async () => {
    const short = new Uint8Array(3 * CHUNK).fill(1);
    const { client } = await deployment(4, sha256Of(4), short);
    const err = await refusal(open(client));
    expect(err).toMatchObject({ status: 502, code: 'internal' });
    expect(err.message).toMatch(/the deployment sent 786432 bytes; its record names 1048576/);
  });

  it('a whole body of the right length whose digest is not the record’s is refused by the client itself', async () => {
    const { client } = await deployment(4, sha256Of(4), new Uint8Array(4 * CHUNK).fill(9));
    const err = await refusal(open(client));
    expect(err).toMatchObject({ status: 502, code: 'internal' });
    expect(err.message).toMatch(/the bytes do not match the recorded sha256/);
  });

  it('its positive twin: a buffered deployment’s matching bytes are read as before', async () => {
    const whole = new Uint8Array(4 * CHUNK);
    for (let i = 0; i < 4; i++) whole.set(chunkOf(i), i * CHUNK);
    const { client } = await deployment(4, sha256Of(4), whole);
    expect((await open(client))!.body).toEqual(whole);
  });

  it('a reader counting bytes off the wire never reaches the size of a file that did not verify', async () => {
    const { url } = await deployment(16, 'b'.repeat(64));
    const res = await fetch(url, { headers: { [PLATFORM_SECRET_HEADER]: SECRET } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let size = 0;
    let failed = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
      }
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(size).toBeLessThan(16 * CHUNK);
  });
});
