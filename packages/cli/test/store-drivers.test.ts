import { describe, it, expect, vi, afterEach } from 'vitest';
import { storeDriversOfPlane } from '../src/push.js';

/** The registry a push reads from the control plane it talks to (#2813). */
const GRAPH = { driver: 'graph', isolationBasis: { kind: 'decisionRecord', decisionRecord: 'D-67' }, verticals: ['helpdesk'] };

function plane(status: number, body: unknown) {
  const seen: string[] = [];
  vi.stubGlobal('fetch', async (url: string | URL) => {
    seen.push(String(url));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe('storeDriversOfPlane', () => {
  it("reads the plane's registry for the slug the push deploys as", async () => {
    const seen = plane(200, { drivers: [GRAPH] });
    await expect(storeDriversOfPlane('https://cp.test', {}, 'helpdesk')).resolves.toEqual([GRAPH]);
    expect(seen).toEqual(['https://cp.test/store-drivers?vertical=helpdesk']);
  });

  it('falls back to the built-in registry on a plane without the route, and on nothing else', async () => {
    plane(404, { error: 'not found' });
    await expect(storeDriversOfPlane('https://cp.test', {}, 'helpdesk')).resolves.toBeUndefined();
    plane(500, { error: 'boom' });
    await expect(storeDriversOfPlane('https://cp.test', {}, 'helpdesk')).rejects.toThrow();
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    await expect(storeDriversOfPlane('https://cp.test', {}, 'helpdesk')).rejects.toThrow('fetch failed');
  });

  it('refuses a registry that is not one', async () => {
    plane(200, { drivers: [{ driver: 'sqlite' }] });
    await expect(storeDriversOfPlane('https://cp.test', {}, 'helpdesk')).rejects.toThrow();
  });
});
