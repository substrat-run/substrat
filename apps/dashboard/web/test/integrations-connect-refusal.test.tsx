import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppIntegrations } from '../src/views/Integrations';
import type { AppRow } from '../src/lib/api';

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

async function submitConnection(response: Response) {
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    requests.push(path);
    if (path === '/api/teams/team-a/apps/app-a/integrations') {
      return Response.json({ providers: [{
        provider: 'acme.docbox', name: 'Docbox', description: 'Archive', monogram: 'D', fields: [],
        connectFlow: null, multiAccount: false, required: true, connection: null, connections: [],
      }] });
    }
    return response;
  }));
  await act(async () => root.render(<AppIntegrations teamId="team-a" app={{ app_scope_id: 'app-a' } as AppRow} />));
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Connect')!;
  await act(async () => button.click());
  const dialog = container.querySelector('[role="dialog"]')!;
  const confirm = [...dialog.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Connect')!;
  await act(async () => confirm.click());
  expect(requests).toContain('/api/teams/team-a/apps/app-a/integrations/acme.docbox');
  return dialog;
}

it('shows the provider refusal and probe facts from the generated client error', async () => {
  const dialog = await submitConnection(Response.json({
    error: 'Provider rejected the credential',
    probe: { ok: false, refused: true, accountRef: null, accountLabel: null, facts: [{ label: 'Reason', value: 'Invalid' }], error: 'Invalid' },
  }, { status: 422 }));
  expect(dialog.textContent).toContain('rejected these credentials — nothing was saved');
  expect(dialog.textContent).toContain('Provider rejected the credential');
  expect(dialog.textContent).toContain('Reason');
  expect(dialog.textContent).toContain('Invalid');
});

it('keeps a deployment refusal separate from a provider rejection', async () => {
  const dialog = await submitConnection(Response.json({ detail: 'Connection store unavailable' }, { status: 503 }));
  expect(dialog.textContent).toContain('This deployment can’t store credentials right now');
  expect(dialog.textContent).toContain('Connection store unavailable');
  expect(dialog.textContent).not.toContain('rejected these credentials');
});
