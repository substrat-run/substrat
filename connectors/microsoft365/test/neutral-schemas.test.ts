import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  FILE_SOURCE_MAX_FILES_PER_WRITE,
  FILE_SOURCE_MAX_FILE_BYTES,
  FILE_SOURCE_MAX_WRITE_BYTES,
  fileSourceChange,
  fileSourceWriteRequest,
  type FileSourceChange,
  type FileSourceWriteRequest,
} from '@substrat-run/contracts';
import {
  MAX_EVENT_BYTES,
  MAX_FILES_PER_EVENT,
  MAX_FILE_BYTES,
  microsoft365ChannelChange,
  microsoft365FilesRequested,
  type Microsoft365ChannelChange,
  type Microsoft365FilesRequested,
} from '../src/index.js';

/**
 * #2499: the connector's file vocabulary is the provider-neutral one in `@substrat-run/contracts`,
 * under the connector's old names. The names must stay the SAME schemas — not copies that agree
 * today — so a vertical coded against either is read identically by the dispatch and the sync.
 */
describe('the Microsoft 365 file vocabulary is the neutral one', () => {
  it('re-exports the very schemas, not copies', () => {
    expect(microsoft365FilesRequested).toBe(fileSourceWriteRequest);
    expect(microsoft365ChannelChange).toBe(fileSourceChange);
  });

  it('keeps the caps its callers import, at the neutral values', () => {
    expect(MAX_FILES_PER_EVENT).toBe(FILE_SOURCE_MAX_FILES_PER_WRITE);
    expect(MAX_FILE_BYTES).toBe(FILE_SOURCE_MAX_FILE_BYTES);
    expect(MAX_EVENT_BYTES).toBe(FILE_SOURCE_MAX_WRITE_BYTES);
    // The values the connector has always enforced.
    expect([MAX_FILES_PER_EVENT, MAX_FILE_BYTES, MAX_EVENT_BYTES]).toEqual([20, 50 * 1024 * 1024, 100 * 1024 * 1024]);
  });

  it('has the same types under both names', () => {
    expectTypeOf<Microsoft365FilesRequested>().toEqualTypeOf<FileSourceWriteRequest>();
    expectTypeOf<Microsoft365ChannelChange>().toEqualTypeOf<FileSourceChange>();
  });

  it('parses an event built against the old name with the new one, and the reverse', () => {
    const event = { files: [{ attachmentId: 'a1', size: 1 }], conflict: 'rename' } satisfies Microsoft365FilesRequested;
    expect(fileSourceWriteRequest.parse(event)).toEqual(microsoft365FilesRequested.parse(event));
    const neutral = { files: [{ attachmentId: 'a2', size: 2 }], conflict: 'replace', directory: 'x' } satisfies FileSourceWriteRequest;
    expect(microsoft365FilesRequested.parse(neutral)).toEqual(fileSourceWriteRequest.parse(neutral));
  });
});
