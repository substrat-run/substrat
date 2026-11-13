import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AttachmentRecord } from '@substrat-run/contracts';
import {
  bytesStream,
  openAttachmentByteStream,
  resolveByteRange,
  type ByteStream,
  type IncrementalSha256,
  type TenantBlobStore,
} from '../src/index.js';

/**
 * A ranged attachment open (#3139): the span is resolved against the record once, an unsatisfiable
 * one reads nothing, a whole-file one is the verified stream, and any other is the store's slice,
 * held to the record's size. A store that cannot read a slice serves the whole file and says so.
 */

const nodeSha256 = (): IncrementalSha256 => {
  const hash = createHash('sha256');
  return { update: (chunk) => void hash.update(chunk), hex: async () => hash.digest('hex') };
};

const BYTES = Uint8Array.from({ length: 10 }, (_, i) => i);
const KEY = 'scope/s/att/a';
const record: AttachmentRecord = {
  id: 'a',
  entity: { entityType: 'item', entityId: 'i1' },
  filename: 'clip.mp3',
  contentType: 'audio/mpeg',
  visibility: 'internal',
  createdBy: 'p1',
  createdAt: '2026-11-13T00:00:00.000Z',
  size: BYTES.byteLength,
  sha256: createHash('sha256').update(BYTES).digest('hex'),
} as AttachmentRecord;

/** A store over `stored`, recording which reads it was asked for; `ranged: false` has no `getRangeStream`. */
function store(stored: Uint8Array, ranged = true) {
  const asked: string[] = [];
  const s: TenantBlobStore = {
    put: async () => {},
    get: async () => null,
    getStream: async () => {
      asked.push('whole');
      return { stream: bytesStream(stored).stream, size: stored.byteLength };
    },
    delete: async () => {},
    list: async () => [],
  };
  if (ranged) {
    s.getRangeStream = async (_key, { offset, length }) => {
      asked.push(`${offset}+${length}`);
      return { stream: bytesStream(stored.slice(offset, offset + length)).stream, size: stored.byteLength };
    };
  }
  return { store: s, asked };
}

async function bytesOf(stream: ByteStream): Promise<number[]> {
  const reader = stream.getReader();
  const out: number[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(...value!);
  }
}

describe('resolveByteRange', () => {
  it.each([
    [{ start: 0 }, 10, { start: 0, end: 9 }],
    [{ start: 3, end: 5 }, 10, { start: 3, end: 5 }],
    [{ start: 8, end: 100 }, 10, { start: 8, end: 9 }],
    [{ suffix: 4 }, 10, { start: 6, end: 9 }],
    [{ suffix: 20 }, 10, { start: 0, end: 9 }],
    [{ start: 10 }, 10, null],
    [{ suffix: 0 }, 10, null],
    [{ start: 0 }, 0, null],
    [{ suffix: 1 }, 0, null],
  ] as const)('%o of %i bytes → %o', (spec, size, span) => {
    expect(resolveByteRange(spec, size)).toEqual(span);
  });

  it.each([[{ start: 5, end: 4 }], [{ start: -1 }], [{ start: 1.5 }], [{ suffix: -2 }]])('%o is a caller mistake and throws', (spec) => {
    expect(() => resolveByteRange(spec, 10)).toThrow(/byte range/);
  });
});

describe('openAttachmentByteStream with a range', () => {
  it('a slice is read from the store as a slice, and says which bytes it holds', async () => {
    const { store: s, asked } = store(BYTES);
    const opened = await openAttachmentByteStream(s, KEY, record, nodeSha256, { start: 3, end: 5 });
    expect(opened.range).toEqual({ start: 3, end: 5 });
    expect(opened.body.length).toBe(3);
    expect(await bytesOf(opened.body.stream)).toEqual([3, 4, 5]);
    expect(asked).toEqual(['3+3']);
  });

  it('a range of the whole file is the verified stream, and a replaced object errors it', async () => {
    const opened = await openAttachmentByteStream(store(BYTES).store, KEY, record, nodeSha256, { start: 0 });
    expect(opened.range).toEqual({ start: 0, end: 9 });
    expect(await bytesOf(opened.body.stream)).toEqual([...BYTES]);
    const tampered = await openAttachmentByteStream(store(new Uint8Array(10)).store, KEY, record, nodeSha256, { start: 0 });
    await expect(bytesOf(tampered.body.stream)).rejects.toThrow(/sha256/);
  });

  it('an unsatisfiable range reads nothing and answers an empty body', async () => {
    const { store: s, asked } = store(BYTES);
    const opened = await openAttachmentByteStream(s, KEY, record, nodeSha256, { start: 10 });
    expect(opened.range).toBe('unsatisfiable');
    expect(opened.body.length).toBe(0);
    expect(asked).toEqual([]);
  });

  it('a store that cannot read a slice serves the whole file, and the answer carries no range', async () => {
    const opened = await openAttachmentByteStream(store(BYTES, false).store, KEY, record, nodeSha256, { start: 3, end: 5 });
    expect(opened.range).toBeUndefined();
    expect(await bytesOf(opened.body.stream)).toEqual([...BYTES]);
  });

  it('an object that is not the recorded size is refused before a slice is handed on', async () => {
    await expect(openAttachmentByteStream(store(BYTES.slice(0, 8)).store, KEY, record, nodeSha256, { start: 2, end: 3 })).rejects.toThrow(
      /the stored object is 8 bytes; its record says 10/,
    );
  });
});
