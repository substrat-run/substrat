/**
 * The wire projection of a page (#829).
 *
 * `Page<T>` stays the kernel-side shape — an in-process caller has no HTTP
 * response to read headers off — so these cover the pure half the HTTP mount
 * uses: what the next link says, and what counts as page-shaped at all.
 */
import { describe, expect, it } from 'vitest';
import { isPage, nextPageLink, pageOf, countedPageOf } from '../src/pagination.js';

describe('nextPageLink', () => {
  it('is RFC 8288 and points at the same route', () => {
    expect(nextPageLink('https://api.test/api/customers?limit=20', 'C9')).toBe(
      '<https://api.test/api/customers?limit=20&cursor=C9>; rel="next"',
    );
  });

  it("carries the request's own filters, so a walk stays filtered", () => {
    const link = nextPageLink('https://api.test/api/customers?status=active&limit=20', 'C9')!;
    expect(link).toContain('status=active');
    expect(link).toContain('limit=20');
  });

  it('replaces an existing cursor rather than appending a second', () => {
    const link = nextPageLink('https://api.test/api/customers?cursor=OLD&limit=20', 'C9')!;
    expect(link).toContain('cursor=C9');
    expect(link).not.toContain('OLD');
  });

  /** The absence of a link is how a walk ends — no trailing empty request. */
  it('is null when there is no next page', () => {
    expect(nextPageLink('https://api.test/api/customers', null)).toBeNull();
  });

  it('escapes nothing by hand — a cursor with URL syntax survives the round trip', () => {
    const link = nextPageLink('https://api.test/api/customers', 'a&b=c d')!;
    const url = new URL(link.slice(1, link.indexOf('>')));
    expect(url.searchParams.get('cursor')).toBe('a&b=c d');
  });
});

describe('isPage', () => {
  it('recognises what pageOf and countedPageOf build', () => {
    expect(isPage(pageOf([{ id: 'a' }], 1, (e) => e.id))).toBe(true);
    expect(isPage(countedPageOf([{ id: 'a' }], 1, (e) => e.id, 7))).toBe(true);
  });

  /**
   * Checked rather than assumed: a declaration whose handler has not adopted
   * `pageOf` yet must reach the client unchanged, not be projected into a body
   * of `undefined`.
   */
  it('rejects anything else, including near-misses', () => {
    expect(isPage(null)).toBe(false);
    expect(isPage([{ id: 'a' }])).toBe(false);
    expect(isPage({ entries: [] })).toBe(false); // no nextCursor
    expect(isPage({ nextCursor: null })).toBe(false); // no entries
    expect(isPage({ entries: 'nope', nextCursor: null })).toBe(false);
  });
});
