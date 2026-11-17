import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MOCK_ME } from '../src/lib/mock';
import { App } from '../src/App';

/**
 * #3244: after sign-in App.tsx reads the team's apps, members, catalog and deployments. Each
 * read settles its own list — a rejected one is that page's error (it used to be swallowed
 * into an empty page), and one still in flight holds no other page back.
 */

// The build stamp is a Vite `define`; a suite has no build.
vi.mock('../src/lib/version', () => ({ APP_VERSION: 'test', APP_SHA: 'test', VERSION_LABEL: 'vtest' }));

const team = vi.hoisted(() => ({ reads: {} as Record<string, () => Promise<unknown>> }));
vi.mock('../src/lib/api', async (importOriginal) => {
  const pending = () => new Promise(() => {});
  const client = new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : (team.reads[String(key)] ?? pending)) });
  return {
    ...(await importOriginal<typeof import('../src/lib/api')>()),
    api: new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : key === 'me' ? async () => MOCK_ME : pending) }),
    teamApi: () => client,
  };
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('fetch', () => new Promise(() => {}));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  team.reads = {};
});

const open = async (path: string) => {
  window.history.replaceState(null, '', path);
  await act(async () => root.render(<App />));
  await act(async () => await new Promise((r) => setTimeout(r, 0)));
};

it.each([
  { page: 'Team', path: '/acme/team', read: 'listMembers', empty: 'No members yet.' },
  { page: 'Verticals', path: '/acme/verticals', read: 'listDeployments', empty: 'Nothing pushed yet' },
  { page: 'Create app', path: '/acme/apps/new', read: 'listCatalog', empty: 'Nothing is published to the marketplace yet.' },
])('$page: a rejected $read is an error with a retry, never the empty page', async ({ path, read, empty }) => {
  team.reads = { listApps: async () => ({ entries: [], nextCursor: null }), [read]: () => Promise.reject(new Error('read refused')) };
  await open(path);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('read refused');
  expect(container.textContent).not.toContain(empty);
});

it('a list still in flight holds no other page back: Team settles while deployments and the catalog never answer', async () => {
  team.reads = { listApps: async () => ({ entries: [], nextCursor: null }), listMembers: async () => ({ entries: [], nextCursor: null }) };
  await open('/acme/team');
  expect(container.textContent).toContain('No members yet.');
});
