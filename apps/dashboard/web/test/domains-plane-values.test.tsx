import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainRow } from '../src/lib/api';
import { Domains } from '../src/views/Domains';

// The team client the view reaches through `teamApi(teamId)`; the wire is the worker suite's.
const client = vi.hoisted(() => ({ listDomains: vi.fn(), listApps: vi.fn() }));
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  teamApi: () => client,
}));

/**
 * #2401: the control plane owns a domain's issuance status and the types of the DNS records it
 * asks for. A newer plane can name one this page does not know: it is shown as the plane named
 * it, and the rest of the list still renders.
 */

const domain = (over: Partial<DomainRow>): DomainRow => ({
  hostname: 'shop.acme.example',
  appScopeId: 'S1',
  app: 'Shop',
  surface: 'app',
  status: 'verifying',
  statusNote: null,
  primary: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  validationRecords: [],
  ...over,
});

describe('Domains: values from a newer plane (#2401)', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    for (const fn of Object.values(client)) fn.mockReset();
    client.listApps.mockResolvedValue({ entries: [], nextCursor: null });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows a status and a record type it does not know as the plane named them, beside the ones it does', async () => {
    client.listDomains.mockResolvedValue({
      entries: [
        domain({ status: 'quarantined', validationRecords: [{ type: 'cname-flattened', name: '_x.shop.acme.example', value: 'edge.example', status: null }] }),
        domain({ hostname: 'ok.acme.example', status: 'active' }),
      ],
      nextCursor: null,
    });
    await act(async () => root.render(<Domains teamId="T" />));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.textContent).toContain('quarantined');
    expect(container.textContent).toContain('Active');
    const show = container.querySelector('button[aria-label="Show DNS records"]');
    expect(show).toBeTruthy();
    await act(async () => {
      show!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('cname-flattened');
    expect(container.textContent).toContain('_x.shop.acme.example');
  });
});
