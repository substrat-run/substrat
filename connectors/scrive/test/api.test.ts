import { describe, it, expect } from 'vitest';
import { ScriveApi, type ScriveSecret } from '../src/api.js';
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
