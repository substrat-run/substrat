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

const connection = (id: string, label: string, apps: { scopeId: string; name: string }[]) => ({
  id, label, status: 'active', externalAccountRef: null, ownerScopeId: null,
  expiresAt: null, lastOkAt: null, lastError: null, lastErrorAt: null, createdAt: '2026-11-01T09:00:00.000Z',
  vertical: 'acme/books', apps, sweepRuns: [],
});

/**
 * The team page over two cards: the orphaned docbox connection, and a Scrive one the disconnect
 * must leave alone. `revoke` decides what the DELETE does: revoke and answer, refuse, or revoke and
 * still fail the response (an answer lost after the plane acted).
 */
function stubPlane(revoke: 'ok' | 'refused' | 'lost') {
  let live = true;
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === '/api/teams/team-a/integrations') {
      return Response.json({ providers: [
        {
          provider: 'scrive', name: 'Scrive', description: 'E-signing.', monogram: 'Sc', fields: [{ key: 'k', label: 'K', secret: true }],
          connectFlow: null, multiAccount: false, sendsMail: false,
          connections: [connection('conn-s', 'Scrive main', [{ scopeId: 'app-a', name: 'Books' }])], connectTargets: [],
        },
        {
          provider: 'acme.docbox', name: 'acme.docbox', description: 'No longer declared by this app’s vertical.',
          monogram: 'AC', fields: [], connectFlow: null, multiAccount: false, sendsMail: false,
          // The app that served it was deleted: deleting an app revokes nothing.
          connections: live ? [connection('conn-1', 'Docbox', [])] : [],
          connectTargets: [],
        },
      ] });
    }
    if (path === '/api/teams/team-a/integrations/connections/conn-1' && init?.method === 'DELETE') {
      if (revoke !== 'refused') live = false;
      return revoke === 'ok'
        ? Response.json({ disconnected: 'conn-1' })
        : Response.json({ detail: 'Connection store unavailable' }, { status: 503 });
    }
    return Response.json({ error: `unexpected ${path}` }, { status: 500 });
  }));
  return requests;
}

async function disconnectDocbox() {
  await act(async () => root.render(<Integrations teamId="team-a" />));
  const card = [...container.querySelectorAll('div')].find((d) => d.textContent?.startsWith('ACacme.docbox'))!;
  await act(async () => button('Disconnect', card)!.click());
  const dialog = container.querySelector('wa-dialog')!;
  const asked = dialog.textContent ?? '';
  await act(async () => buttons(dialog).find((b) => b.textContent?.trim() === 'Disconnect')!.click());
  return { dialog, asked };
}

/** `Dialog` drives `open` as a property, as Web Awesome reads it. */
const isOpen = (dialog: Element) => (dialog as Element & { open?: boolean }).open === true;

it('disconnects an undeclared connection no app serves any more, from the team page', async () => {
  const requests = stubPlane('ok');
  await act(async () => root.render(<Integrations teamId="team-a" />));
  // Nothing on the orphan's card that would 404 for a provider with no declaration.
  expect(buttons(container).map((b) => b.textContent?.trim())).toEqual(['Details', 'Disconnect', 'Manage', 'Disconnect']);
  act(() => root.unmount());
  root = createRoot(container);

  const { dialog, asked } = await disconnectDocbox();
  expect(asked).toContain('No app of this team uses it any more.');
  expect(isOpen(dialog)).toBe(false);
  const del = requests.indexOf('DELETE /api/teams/team-a/integrations/connections/conn-1');
  expect(del).toBeGreaterThan(-1);
  // The list is read again after the revoke, and only the revoked row left it.
  expect(requests.slice(del + 1)).toContain('GET /api/teams/team-a/integrations');
  expect(container.textContent).not.toContain('Docbox');
  expect(container.textContent).toContain('Scrive main');
});

it('keeps the dialog open with the failure while the connection is still live', async () => {
  stubPlane('refused');
  const { dialog } = await disconnectDocbox();
  expect(isOpen(dialog)).toBe(true);
  expect(dialog.textContent).toContain('Couldn’t disconnect — the connection is still live: Connection store unavailable');
  expect(buttons(dialog).some((b) => b.textContent?.trim() === 'Try again')).toBe(true);
});

it('closes when the plane revoked it although its answer was lost', async () => {
  stubPlane('lost');
  const { dialog } = await disconnectDocbox();
  expect(isOpen(dialog)).toBe(false);
  expect(container.textContent).not.toContain('Docbox');
  expect(container.textContent).toContain('Scrive main');
});
