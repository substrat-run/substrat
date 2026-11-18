import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppIntegrations, Integrations } from '../src/views/Integrations';
import type { AppRow } from '../src/lib/api';
import { button, buttons, choose, disabled } from './wa';

/**
 * #3281: a private key read from a file is never drawn — not when it is read, and not after the
 * field it sits in is hidden by another sign-in method and shown again. The key here is a stand-in
 * string, built at run time; nothing in it is a key.
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

const KEY = ['-----BEGIN ', 'PRIVATE KEY-----\n', 'stand-in-for-a-key-', 'x'.repeat(40), '\n-----END ', 'PRIVATE KEY-----\n'].join('');

const fields = [
  {
    key: 'signInWith',
    label: 'Sign in with',
    secret: false,
    optional: true,
    choices: [
      { value: 'client-secret', label: 'Client secret' },
      { value: 'own-certificate', label: 'Your own certificate' },
    ],
  },
  { key: 'clientSecret', label: 'Client secret', secret: true, optional: true, showWhen: { field: 'signInWith', values: ['client-secret'] }, requiredWhen: ['client-secret'] },
  {
    key: 'ownPrivateKey',
    label: 'Private key',
    secret: true,
    optional: true,
    showWhen: { field: 'signInWith', values: ['own-certificate'] },
    requiredWhen: ['own-certificate'],
    file: { accept: '.pem' },
  },
];

it('a key read from a file is not drawn, even after switching method and back, and is what is sent', async () => {
  const sent: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/teams/team-a/apps/app-a/integrations') {
      return Response.json({ providers: [{
        provider: 'microsoft365', name: 'Microsoft 365', description: 'Mail', monogram: 'M3', fields,
        connectFlow: null, multiAccount: false, required: true, connection: null, connections: [],
      }] });
    }
    if (path === '/api/teams/team-a/apps/app-a/mail-in') return Response.json({ address: null, landing: null, receiving: true });
    if (path === '/api/teams/team-a/apps/app-a/integrations/microsoft365') {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ connectionId: 'c', created: true });
    }
    return Response.json({});
  }));
  await act(async () => root.render(<AppIntegrations teamId="team-a" app={{ app_scope_id: 'app-a' } as AppRow} />));
  await act(async () => buttons(container).find((b) => b.textContent?.trim() === 'Connect')!.click());
  const dialog = container.querySelector('wa-dialog')!;
  const method = () => dialog.querySelector('wa-radio-group')!;
  const drawn = () => [dialog.innerHTML, ...[...dialog.querySelectorAll('wa-textarea')].map((t) => (t as HTMLElement & { value?: string }).value ?? '')];

  await act(async () => choose(method(), 'own-certificate'));
  const picker = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
  // jsdom's File has no arrayBuffer(); the field reads only the name, the size and the bytes.
  const bytes = new TextEncoder().encode(KEY);
  const file = { name: 'key.pem', size: bytes.length, arrayBuffer: async () => bytes.buffer };
  Object.defineProperty(picker, 'files', { value: [file] });
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })));
  await act(async () => {});
  expect(dialog.textContent).toContain('Read from key.pem');
  for (const d of drawn()) expect(d).not.toContain('stand-in-for-a-key');

  await act(async () => choose(method(), 'client-secret'));
  await act(async () => choose(method(), 'own-certificate'));
  expect(dialog.textContent).toContain('Read from key.pem');
  for (const d of drawn()) expect(d).not.toContain('stand-in-for-a-key');

  await act(async () => buttons(dialog).find((b) => b.textContent?.trim() === 'Connect')!.click());
  expect(sent).toEqual([expect.objectContaining({ secret: { signInWith: 'own-certificate', ownPrivateKey: KEY.trim() } })]);
});

const fieldsWithCertificate = [
  ...fields,
  {
    key: 'ownCertificate',
    label: 'Certificate',
    secret: false,
    optional: true,
    showWhen: { field: 'signInWith', values: ['own-certificate'] },
    requiredWhen: ['own-certificate'],
    file: { accept: '.cer' },
  },
];
fieldsWithCertificate[0] = {
  ...fields[0]!,
  choices: [
    { value: 'client-secret', label: 'Client secret', heldWhen: ['clientSecret'] },
    { value: 'own-certificate', label: 'Your own certificate', heldWhen: ['certificateSupplied'] },
  ],
} as (typeof fields)[number];

/** The team page over one client-secret Microsoft 365 connection serving one app; records what is saved. */
function stubTeamPlane() {
  const sent: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0]!;
    const connection = {
      id: 'conn-m', label: 'Microsoft 365', status: 'active', externalAccountRef: null, ownerScopeId: null,
      expiresAt: null, lastOkAt: null, lastError: null, lastErrorAt: null, createdAt: '2026-11-01T09:00:00.000Z',
    };
    if (path === '/api/teams/team-a/integrations') {
      return Response.json({ providers: [{
        provider: 'microsoft365', name: 'Microsoft 365', description: 'Mail', monogram: 'M3', fields: fieldsWithCertificate,
        connectFlow: null, multiAccount: false, sendsMail: false,
        connections: [{ ...connection, vertical: 'acme/books', apps: [{ scopeId: 'app-a', name: 'Books' }], sweepRuns: [] }],
        connectTargets: [{ scopeId: 'app-a', name: 'Books', vertical: 'acme/books', connected: true }],
      }] });
    }
    if (path.endsWith('/activity')) {
      return Response.json({
        source: 'ledger', live: false, entries: [], grants: [], intents: [], unreadableIntents: [], sweepRuns: [],
        mailSenders: [], certificate: null, connection,
        credential: [{ key: 'clientSecret', label: 'Client secret', value: '••••••••abcd', masked: true }],
      });
    }
    if (path === '/api/teams/team-a/apps/app-a/integrations/microsoft365' && init?.method === 'POST') {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ connectionId: 'conn-m', created: false });
    }
    return Response.json({});
  }));
  return sent;
}

it('rotating from the team page starts on the method held and keeps a secret left empty; a switch needs its files', async () => {
  const sent = stubTeamPlane();
  await act(async () => root.render(<Integrations teamId="team-a" />));
  await act(async () => button('Manage', container)!.click());
  await act(async () => {});
  await act(async () => button('Rotate', container)!.click());
  const dialog = [...container.querySelectorAll('wa-dialog')].find((d) => d.getAttribute('label') === 'Rotate Microsoft 365')!;
  const confirm = () => buttons(dialog).find((b) => b.textContent?.trim() === 'Rotate credentials')!;
  expect((dialog.querySelector('wa-radio-group') as HTMLElement & { value: string }).value).toBe('client-secret');
  expect([...dialog.querySelectorAll('wa-input')].map((i) => i.getAttribute('label'))).toContain('Client secret (empty keeps the one stored)');

  // Switching to a certificate of yours on a connection that holds none: both files, or no save.
  await act(async () => choose(dialog.querySelector('wa-radio-group')!, 'own-certificate'));
  expect(disabled(confirm())).toBe(true);

  await act(async () => choose(dialog.querySelector('wa-radio-group')!, 'client-secret'));
  expect(disabled(confirm())).toBe(false);
  await act(async () => confirm().click());
  expect(sent).toEqual([expect.objectContaining({ secret: { signInWith: 'client-secret' } })]);
});
