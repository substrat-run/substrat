import { describe, expect, it } from 'vitest';
import { contentOf, type GraphClient } from '../src/graph.js';

/** The download cap (#2101 r1): a body over it is refused, on its declared length or on its bytes. */
function client(body: Uint8Array, contentLength: string | null) {
  const read = { arrayBuffer: 0 };
  const c: GraphClient = {
    accessToken: 'TOKEN',
    graphBase: 'https://graph.example',
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === 'content-length' ? contentLength : null) },
      json: async () => ({}),
      arrayBuffer: async () => {
        read.arrayBuffer += 1;
        return body.slice().buffer;
      },
    }),
  };
  return { c, read };
}

describe('contentOf', () => {
  it('refuses on the declared length before reading the body', async () => {
    const { c, read } = client(new Uint8Array(1), '11');
    await expect(contentOf(c, 'd', 'i', 10)).rejects.toMatchObject({ status: 413 });
    expect(read.arrayBuffer).toBe(0);
  });
  it('refuses on the bytes when no length is declared', async () => {
    const { c } = client(new Uint8Array(11), null);
    await expect(contentOf(c, 'd', 'i', 10)).rejects.toMatchObject({ status: 413 });
  });
  it('returns a body at the cap (the positive twin)', async () => {
    const { c } = client(new Uint8Array(10).fill(3), '10');
    expect(await contentOf(c, 'd', 'i', 10)).toEqual(new Uint8Array(10).fill(3));
  });
});
