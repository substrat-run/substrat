import { describe, expect, it } from 'vitest';
import { pageWindow } from '../src/components/Pager';

describe('pageWindow', () => {
  it('counts pages, with at least one for an empty list', () => {
    expect(pageWindow(0, 25, 0).pageCount).toBe(1);
    expect(pageWindow(25, 25, 0).pageCount).toBe(1);
    expect(pageWindow(26, 25, 0).pageCount).toBe(2);
  });

  it('starts each page at a multiple of the page size', () => {
    expect(pageWindow(60, 25, 2)).toEqual({ pageCount: 3, page: 2, start: 50 });
  });

  it('clamps an index past the end (a filter shrank the list) to the last page', () => {
    expect(pageWindow(30, 25, 5)).toEqual({ pageCount: 2, page: 1, start: 25 });
  });

  it('clamps a negative index to the first page', () => {
    expect(pageWindow(30, 25, -1).page).toBe(0);
  });
});
