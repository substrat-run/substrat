import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Integrations } from '../src/views/Integrations';
import { button, buttons } from './wa';

/**
 * A vertical-defined connection its vertical no longer declares, served by no app (#3278): the
 * team-wide page lists it formless, and the one act left on it — withdrawing it — has to be
 * reachable from that card, through the team's own door since there is no app to route through.
 * Details, Manage and Rotate would all answer 404 for a provider with no declaration, so the card
 * offers none of them.
 */
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('disconnects an undeclared connection no app serves any more, from the team page', async () => {
  let live = true;
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/api/teams/team-a/integrations') {
      return Response.json({ providers: [{
        provider: 'acme.docbox', name: 'acme.docbox', description: 'No longer declared by this app’s vertical.',
        monogram: 'AC', fields: [], connectFlow: null, multiAccount: false, sendsMail: false,
        connections: live ? [{
          id: 'conn-1', label: 'Docbox', status: 'active', externalAccountRef: null, ownerScopeId: null,
          expiresAt: null, lastOkAt: null, lastError: null, lastErrorAt: null, createdAt: '2026-11-01T09:00:00.000Z',
          // The app that served it was deleted: deleting an app revokes nothing.
          vertical: 'acme/books', apps: [], sweepRuns: [],
        }] : [],
        connectTargets: [],
      }] });
    }
    if (path === '/api/teams/team-a/integrations/connections/conn-1' && init?.method === 'DELETE') {
      live = false;
      return Response.json({ disconnected: true });
    }
    return Response.json({ error: `unexpected ${path}` }, { status: 500 });
  }));

  await act(async () => root.render(<Integrations teamId="team-a" />));
  expect(container.textContent).toContain('Docbox');
  // Nothing on the card that would 404 for a provider with no declaration.
  expect(button('Details', container)).toBeUndefined();
  expect(button('Manage', container)).toBeUndefined();
  expect(button('Connect', container)).toBeUndefined();

  await act(async () => button('Disconnect', container)!.click());
  const dialog = container.querySelector('wa-dialog')!;
  expect(dialog.textContent).toContain('No app of this team uses it any more.');
  await act(async () => buttons(dialog).find((b) => b.textContent?.trim() === 'Disconnect')!.click());

  expect(requests).toContain('DELETE /api/teams/team-a/integrations/connections/conn-1');
  expect(container.textContent).not.toContain('Docbox');
});
