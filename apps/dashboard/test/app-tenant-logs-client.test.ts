import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../web/src/lib/api.js';

/**
 * The browser client's half of the invocation filter (#1525): `api.appTenantLogs` is where
 * an id becomes a query string, and the one place a truthiness check would turn an empty
 * id — a caller bug the plane answers with a 400 — into the app's whole, unfiltered log.
 */
describe('api.appTenantLogs invocationId (#1525)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const spy = () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return new Response('[]', { status: 200 });
      }),
    );
    return urls;
  };
  const CALL = '01J8Z3KX0Q5R7T9V1W2Y4A6B8C';
  const paramsOf = (url: string) => new URL(url, 'http://x').searchParams;

  it('sends the id', async () => {
    const urls = spy();
    await api.appTenantLogs('S', { invocationId: CALL, limit: 100 });
    expect(paramsOf(urls[0]!).get('invocationId')).toBe(CALL);
  });

  it('sends an EMPTY id as present, so the plane can refuse it rather than answer unfiltered', async () => {
    const urls = spy();
    await api.appTenantLogs('S', { invocationId: '' });
    expect(paramsOf(urls[0]!).has('invocationId')).toBe(true);
    expect(paramsOf(urls[0]!).get('invocationId')).toBe('');
  });

  it('sends no param at all when there is no id', async () => {
    const urls = spy();
    await api.appTenantLogs('S', { hours: 24 });
    expect(paramsOf(urls[0]!).has('invocationId')).toBe(false);
  });
});
