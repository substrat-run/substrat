/**
 * The `Range` header a file route answers (#3139): one byte range is a range, and every other header
 * is ignored, which RFC 9110 §14.2 allows, so the whole file is served. What a range does to the
 * response is in `worker-door.test.ts`, through the door's own route.
 */
import { describe, expect, it } from 'vitest';
import { parseByteRange } from '../src/attachment-serve.js';

describe('parseByteRange', () => {
  it.each([
    ['bytes=0-', { start: 0 }],
    ['bytes=2-4', { start: 2, end: 4 }],
    ['bytes=-3', { suffix: 3 }],
    ['Bytes=2-4', { start: 2, end: 4 }],
    [undefined, undefined],
    ['bytes=4-2', undefined],
    ['bytes=-', undefined],
    ['bytes=0-1,4-5', undefined],
    ['items=0-1', undefined],
    ['bytes=99999999999999999999-', undefined],
  ])('%j → %j', (header, spec) => {
    expect(parseByteRange(header)).toEqual(spec);
  });
});
