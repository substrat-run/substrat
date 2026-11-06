import { describe, expect, it, vi } from 'vitest';
import { SessionController } from '../src/internal/session-controller.js';
import { SessionStore, hueOf, initialsOf, parseSession, switchUserHref, type SessionState } from '../src/session.js';

const answer = (ok: boolean, body: unknown = {}) => async () => ({ ok, json: async () => body });

describe('initialsOf', () => {
  it.each([
    ['Ada Lovelace', 'AL'],
    ['María José García', 'MG'],
    ['Plato', 'P'],
    ['émile zola', 'ÉZ'],
    ['ada.lovelace@example.com', 'AL'],
    ['👩🏽‍💻 Dev', '👩🏽‍💻D'],
    ['   ', '?'],
  ])('%s → %s', (name, initials) => expect(initialsOf(name)).toBe(initials));
});

describe('parseSession', () => {
  it('needs a principal, and names it by display, then email, then principal', () => {
    expect(parseSession({ display: 'Ada' })).toBeNull();
    expect(parseSession({ principal: 'p1', email: 'a@x.se' })).toEqual({ principal: 'p1', display: 'a@x.se', email: 'a@x.se' });
    expect(parseSession({ principal: 'p1', display: '', picture: 7 })).toEqual({ principal: 'p1', display: 'p1' });
  });
});

it('hueOf follows the principal, not the name', () => {
  expect(hueOf('01J0PRINCIPAL')).toBe(hueOf('01J0PRINCIPAL'));
  const hues = new Set(Array.from({ length: 40 }, (_, i) => hueOf(`p${i}`)));
  expect(hues.size).toBeGreaterThan(4);
});

it('switchUserHref keeps a login URL that already has a query', () => {
  expect(switchUserHref({ login: '/api/auth/login?x=1', logout: '' }, '/#/list/1')).toBe(
    '/api/auth/login?x=1&prompt=select_account&returnTo=%2F%23%2Flist%2F1',
  );
});

describe('SessionStore', () => {
  it('starts loading, reads once for every subscriber, then answers', async () => {
    const fetch = vi.fn(answer(true, { principal: 'p1', display: 'Ada' }));
    const store = new SessionStore('/api/me', fetch);
    const seen: SessionState[] = [];
    store.subscribe((s) => seen.push(s));
    store.subscribe(() => {});
    await store.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(seen.map((s) => s.phase)).toEqual(['loading', 'signed-in']);
  });

  it('a 401 is signed out; a failed refresh after that keeps the last answer', async () => {
    let next: () => Promise<{ ok: boolean; json: () => Promise<unknown> }> = answer(false);
    const store = new SessionStore('/api/me', () => next());
    store.subscribe(() => {});
    await store.refresh();
    expect(store.state.phase).toBe('signed-out');

    next = answer(true, { principal: 'p1', display: 'Ada' });
    await store.refresh();
    next = () => Promise.reject(new TypeError('offline'));
    await store.refresh();
    expect(store.state).toEqual({ phase: 'signed-in', session: { principal: 'p1', display: 'Ada' } });
  });

  it('a first read that fails is signed out, not loading forever', async () => {
    const store = new SessionStore('/api/me', () => Promise.reject(new TypeError('offline')));
    store.subscribe(() => {});
    await store.refresh();
    expect(store.state.phase).toBe('signed-out');
  });
});

it('an empty session URL reads nothing, and stays loading until the host sets a session', async () => {
  const read = vi.fn(answer(false));
  vi.stubGlobal('fetch', read);
  const host = { sessionUrl: '', session: undefined, addController() {}, requestUpdate() {} } as never;
  const controller = new SessionController(host);
  controller.hostConnected();
  await controller.refresh();
  expect(read).not.toHaveBeenCalled();
  expect(controller.state).toEqual({ phase: 'loading' });
  vi.unstubAllGlobals();
});
