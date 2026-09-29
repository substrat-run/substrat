import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeRequestInUrl, openRequestInUrl, requestInUrl } from '../src/lib/request-url';

/**
 * #1916: the request slide-over's address — one opener for every page, so a request opened
 * from anywhere (a record's transition card included) can be linked to, survives a reload,
 * and Back closes it.
 */
afterEach(() => {
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('requestInUrl', () => {
  it('reads the call, the instant and an optional scope', () => {
    expect(requestInUrl('?req=C1&reqAt=1790670962323')).toEqual({ invocationId: 'C1', atMs: 1790670962323, scopeId: null });
    expect(requestInUrl('?req=C1&reqAt=1790670962323&reqScope=S2')).toMatchObject({ scopeId: 'S2' });
  });

  it('opens nothing for a missing call or an instant no Date can hold', () => {
    expect(requestInUrl('?reqAt=1')).toBeNull();
    expect(requestInUrl('?req=C1&reqAt=soon')).toBeNull();
    expect(requestInUrl('?req=C1&reqAt=8640000000000001')).toBeNull();
  });
});

describe('opening and closing', () => {
  it('adds the request to the page it is on, keeping the page’s own keys, as a history step', () => {
    window.history.replaceState(null, '', '/acme/apps/A1/data?table=t');
    const heard = vi.fn();
    window.addEventListener('popstate', heard);
    const before = window.history.length;
    openRequestInUrl('C1', 1790670962323.4, 'S2');
    expect(window.location.pathname).toBe('/acme/apps/A1/data');
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({ table: 't', req: 'C1', reqAt: '1790670962323', reqScope: 'S2' });
    expect(window.history.length).toBe(before + 1);
    expect(heard).toHaveBeenCalled();
    window.removeEventListener('popstate', heard);
  });

  it('drops a scope left over from an earlier request, and closing removes all three keys', () => {
    window.history.replaceState(null, '', '/x?req=OLD&reqAt=1&reqScope=S2&view=logs');
    openRequestInUrl('C1', 5);
    expect(new URLSearchParams(window.location.search).get('reqScope')).toBeNull();
    closeRequestInUrl();
    expect(window.location.search).toBe('?view=logs');
  });
});

describe('a record by its address (#1921)', () => {
  it('reads the entity, the id — which may hold colons — and an optional scope', async () => {
    const { recordInUrl } = await import('../src/lib/request-url');
    expect(recordInUrl('?rec=contact:c:42&recScope=S2')).toEqual({ entityType: 'contact', entityId: 'c:42', scopeId: 'S2' });
    expect(recordInUrl('?rec=nocolon')).toBeNull();
    expect(recordInUrl('?rec=:id')).toBeNull();
  });

  it('opens and closes on the page it is on, as history steps', async () => {
    const { openRecordInUrl, closeRecordInUrl } = await import('../src/lib/request-url');
    window.history.replaceState(null, '', '/acme/observability?view=logs');
    openRecordInUrl('conversation', 'C1', 'S2');
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({ view: 'logs', rec: 'conversation:C1', recScope: 'S2' });
    closeRecordInUrl();
    expect(window.location.search).toBe('?view=logs');
  });
});
