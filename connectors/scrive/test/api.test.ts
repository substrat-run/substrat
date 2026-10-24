import { describe, it, expect } from 'vitest';
import { SCRIVE_MAX_DOWNLOAD_BYTES, ScriveApi, ScriveFileTooLargeError, type ScriveSecret } from '../src/api.js';
import { ScriveMock } from '../src/mock.js';

/**
 * The typed client over {@link ScriveMock}. This proves OUR request/response
 * shapes hold together; the mock is the author's reading of Scrive on both sides,
 * so a green run here means "ready to check against the testbed", never
 * "verified" — that is what `live.test.ts` is for.
 */

const secret: ScriveSecret = {
  clientId: 'ci',
  clientSecret: 'cs',
  tokenId: 'ti',
  tokenSecret: 'ts',
};

/** A ConnectorConnection-shaped object over the mock's fetch. */
function conn(mock: ScriveMock) {
  return {
    id: 'mock' as never,
    tenantId: 't',
    vertical: 'test',
    provider: 'scrive',
    secret,
    expiresAt: null,
    fetch: mock.fetch,
  };
}

describe('ScriveApi.getMainFile', () => {
  it('pulls the sealed file bytes for a document that has one', async () => {
    const mock = new ScriveMock();
    const api = new ScriveApi(conn(mock) as never, 'https://api-testbed.scrive.test');

    const doc = await api.createDocument();
    await api.setFile(doc.id, 'doc.pdf', new Uint8Array([1, 2, 3, 4]));

    const bytes = await api.getMainFile(doc.id);
    expect(bytes).toBeInstanceOf(Uint8Array);
    // The mock encodes the id into the sealed bytes, so this proves the fetch hit
    // the right document — not just that *some* bytes came back.
    expect(new TextDecoder().decode(bytes)).toContain(doc.id);
  });

  it('surfaces the provider error when no sealed file exists yet', async () => {
    const mock = new ScriveMock();
    const api = new ScriveApi(conn(mock) as never, 'https://api-testbed.scrive.test');

    const doc = await api.createDocument(); // never given a file
    await expect(api.getMainFile(doc.id)).rejects.toThrow(/files\/main failed/);
  });
});

describe('ScriveApi.getMainFile size bound (#2552)', () => {
  const MAX = SCRIVE_MAX_DOWNLOAD_BYTES;

  async function sealed(declared: number | null, actual: number, encoded = false) {
    const mock = new ScriveMock();
    const api = new ScriveApi(conn(mock) as never, 'https://api-testbed.scrive.test');
    const doc = await api.createDocument();
    await api.setFile(doc.id, 'doc.pdf', new Uint8Array([1]));
    mock.setSealedFile(doc.id, { declared, actual, encoded });
    return { mock, api, doc };
  }

  it('refuses a declared length over the ceiling without reading the body', async () => {
    const { mock, api, doc } = await sealed(MAX + 1, 8);
    const err = await api.getMainFile(doc.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScriveFileTooLargeError);
    expect((err as ScriveFileTooLargeError).bytes).toBe(MAX + 1);
    expect(mock.sealedBytesServed.get(doc.id) ?? 0).toBe(0);
  });

  it('takes a declared length at the ceiling', async () => {
    // The body is short on purpose: the bound is judged on the declared length, and 95 MiB is not allocated here.
    const { api, doc } = await sealed(MAX, 8);
    expect((await api.getMainFile(doc.id)).byteLength).toBe(8);
  });

  it('counts a body that declares no length and cuts it off at the ceiling', async () => {
    const CHUNK = 1024 * 1024; // the mock serves in 1 MiB reads
    const total = 2 * MAX;
    const { mock, api, doc } = await sealed(null, total);
    const err = await api.getMainFile(doc.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScriveFileTooLargeError);
    expect((err as ScriveFileTooLargeError).bytes).toBeUndefined();
    // Cut off at the read that crossed the bound, never the whole file read to its end.
    expect(mock.sealedBytesServed.get(doc.id)).toBeLessThanOrEqual(MAX + CHUNK);
    expect(mock.sealedBytesServed.get(doc.id)).toBeLessThan(total);
    // The body was released, not left streaming.
    expect(mock.sealedCancelled.has(doc.id)).toBe(true);
  });

  it('takes a body that declares no length and is under the ceiling', async () => {
    const { api, doc } = await sealed(null, 3 * 1024 * 1024 + 5);
    expect((await api.getMainFile(doc.id)).byteLength).toBe(3 * 1024 * 1024 + 5);
  });

  it('still counts an encoded response whose header is small', async () => {
    const { api, doc } = await sealed(10, MAX + 1, true);
    await expect(api.getMainFile(doc.id)).rejects.toBeInstanceOf(ScriveFileTooLargeError);
  });

  it('releases a body refused on its declared length, and reads one that outruns its header', async () => {
    const big = await sealed(MAX + 1, 8);
    await big.api.getMainFile(big.doc.id).catch(() => {});
    expect(big.mock.sealedCancelled.has(big.doc.id)).toBe(true);
    // The header is a hint: a body longer than it declared is still read, to the bound.
    const longer = await sealed(10, 3 * 1024 * 1024);
    expect((await longer.api.getMainFile(longer.doc.id)).byteLength).toBe(3 * 1024 * 1024);
  });

  it('takes the bound as an argument', async () => {
    const { api, doc } = await sealed(100, 100);
    await expect(api.getMainFile(doc.id, 99)).rejects.toBeInstanceOf(ScriveFileTooLargeError);
    expect((await api.getMainFile(doc.id, 100)).byteLength).toBe(100);
  });
});
