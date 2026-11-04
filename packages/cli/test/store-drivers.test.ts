import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { push, readStoreDriversFile, storeDriversOfPlane } from '../src/push.js';

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

  it('reads a registration carrying a key this CLI does not know, as a newer plane serves it', async () => {
    plane(200, { drivers: [{ ...GRAPH, addedLater: true }] });
    await expect(storeDriversOfPlane('https://cp.test', {}, 'helpdesk')).resolves.toEqual([GRAPH]);
  });

  it('sends the workspace the push is pinned to', async () => {
    const sent: Headers[] = [];
    vi.stubGlobal('fetch', async (_: unknown, init: RequestInit) => {
      sent.push(new Headers(init.headers));
      return new Response(JSON.stringify({ drivers: [] }), { status: 200 });
    });
    await storeDriversOfPlane('https://cp.test', {}, 'helpdesk', 'acme');
    expect(sent[0]!.get('x-substrat-tenant')).toBe('acme');
  });

  it('falls back to the built-in registry on a plane without the route (404, 403), and on nothing else', async () => {
    plane(404, { error: 'not found' });
    await expect(storeDriversOfPlane('https://cp.test', {}, 'helpdesk')).resolves.toBeUndefined();
    // A builder's routes are default-deny, so a plane without the route answers it 403.
    plane(403, { error: 'forbidden' });
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

  it("prefers --store-drivers to the plane's registry, and asks the plane nothing", async () => {
    const seen = plane(200, { drivers: [GRAPH], id: 'v1', admission: 'admitted', deploymentRef: 'r', verticalSlug: 'helpdesk', dataLoss: {} });
    await expect(push({ ...opts(vertical()), storeDrivers: [] })).rejects.toThrow('which is not registered');
    expect(seen).toEqual([]);
  });
});

describe('readStoreDriversFile', () => {
  it('names the flag and the file when it cannot be read as a registry', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'substrat-store-drivers-')), 'drivers.json');
    writeFileSync(file, '{ not json');
    expect(() => readStoreDriversFile(file)).toThrow(`--store-drivers ${file}:`);
  });
});
