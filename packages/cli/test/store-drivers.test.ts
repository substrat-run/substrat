import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { push, storeDriversOfPlane } from '../src/push.js';

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

describe('push judges scope stores by the plane registry (#2813)', () => {
  const vertical = () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrat-store-drivers-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'helpdesk',
      substrat: { runtimeNeeds: { entry: 'src/worker.ts', scopeStores: [{ binding: 'GRAPH', driver: 'graph' }] } },
    }));
    return dir;
  };
  const opts = (dir: string) => ({ dir, slug: 'helpdesk', version: '1.0.0', controlPlaneUrl: 'https://cp.test', authHeader: {} });

  it("refuses before any upload when the plane's registry does not serve the vertical, and uploads when it does", async () => {
    const seen = plane(200, { drivers: [] });
    await expect(push(opts(vertical()))).rejects.toThrow("scope store 'GRAPH' declares driver 'graph', which is not registered.");
    expect(seen).toEqual(['https://cp.test/store-drivers?vertical=helpdesk']);
    // The built-in `graph` serves no vertical, so only the plane's own answer lets this one through.
    const served = plane(200, { drivers: [GRAPH], id: 'v1', admission: 'admitted', deploymentRef: 'r', verticalSlug: 'helpdesk', dataLoss: {} });
    await expect(push(opts(vertical()))).resolves.toMatchObject({ id: 'v1' });
    expect(served.map((u) => new URL(u).pathname)).toEqual(['/store-drivers', '/verticals/helpdesk/deploy']);
  });
});
