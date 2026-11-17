import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppIntegrations } from '../src/views/Integrations';
import type { AppRow } from '../src/lib/api';
import { buttons } from './wa';

/**
 * #2422: a connection whose consent is short of what the platform asks for is shown as needing
 * a new consent — with the scopes named and the consent round one click away — never as "Refused".
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

const connection = {
  id: 'conn-1', label: 'Fortnox — Testbolaget AB', status: 'active', externalAccountRef: '123456', ownerScopeId: null,
  expiresAt: null, lastOkAt: '2026-11-17T10:00:00.000Z', lastError: null, lastErrorAt: null, createdAt: '2026-10-01T10:00:00.000Z',
};
const consent = { granted: ['bookkeeping', 'companyinformation'], missing: ['supplierinvoice', 'archive', 'connectfile'], checkedAt: '2026-11-17T10:00:00.000Z' };

it('shows a short consent as "Needs re-consent" and offers the consent round, not new keys', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/api/teams/team-a/apps/app-a/integrations') {
      return Response.json({ providers: [{
        provider: 'fortnox', name: 'Fortnox', description: 'Accounting', monogram: 'F', fields: [],
        connectFlow: 'redirect', multiAccount: false, required: true, connection, connections: [connection],
      }] });
    }
    if (path.startsWith('/api/teams/team-a/apps/app-a/integrations/fortnox/connections/conn-1/activity')) {
      return Response.json({
        source: 'ledger', entries: [], live: false, consent, grants: [], credential: [], certificate: null, mailSenders: [],
        connection, sweepRuns: [], intents: [], unreadableIntents: [],
      });
    }
    return Response.json({ error: `unexpected ${path}` }, { status: 500 });
  }));
  await act(async () => root.render(<AppIntegrations teamId="team-a" app={{ app_scope_id: 'app-a' } as AppRow} />));
  await act(async () => buttons(container).find((b) => b.textContent?.trim() === 'Details')!.click());

  const drawer = container.querySelector('wa-dialog')!;
  expect(drawer.textContent).toContain('Needs re-consent');
  expect(drawer.textContent).toContain('does not cover supplierinvoice, archive, connectfile');
  expect(drawer.textContent).not.toContain('Refused');

  await act(async () => buttons(drawer).find((b) => b.textContent?.trim() === 'Re-consent')!.click());
  // The same consent round Rotate starts: Fortnox's redirect, for the connection's own company.
  const opened = [...container.querySelectorAll('wa-dialog')].map((d) => d.getAttribute('label'));
  expect(opened).toContain('Rotate Fortnox');
});
