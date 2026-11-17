import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MailInCard } from '../src/views/MailInCard';
import type { AppRow } from '../src/lib/api';
import { button, buttons } from './wa';

/**
 * The Inbound email card (#2611) when something goes wrong: a read that fails is shown with a way to
 * try again rather than hiding the card, and an act the server refuses keeps its message in the
 * dialog it came from, across the read that follows it.
 */
let container: HTMLDivElement;
let root: Root;

const PATH = '/api/teams/team-a/apps/app-a/mail-in';
const standing = {
  address: {
    address: 'mail+books-abcdefghijklmnop@in.example.test',
    connectionId: 'c1', tenantId: 'team-a', scopeId: 'app-a', vertical: 'books',
    operation: 'books/receive-mail', permission: 'books:receive-mail', allowlist: ['@supplier.example'],
    createdAt: '2026-11-17T09:00:00.000Z', createdBy: 'p1',
    stats: { received: 1, delivered: 1, rejected: 0, deadLettered: 0, pending: 0, lastReceivedAt: null, lastRejectedAt: null, lastRejectReason: null },
  },
  landing: { operation: 'books/receive-mail', permission: 'books:receive-mail' },
  receiving: true,
};

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

/** Answer the card's reads with `read()` and its acts with `write()`, counting each. */
function plane(read: () => Response, write: () => Response = () => Response.json({ address: standing.address })) {
  const seen = { reads: 0, writes: 0 };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== PATH) return Response.json({ detail: 'unexpected' }, { status: 500 });
    if ((init?.method ?? 'GET') === 'GET') {
      seen.reads += 1;
      return read();
    }
    seen.writes += 1;
    return write();
  }));
  return seen;
}

const render = () => act(async () => root.render(<MailInCard teamId="team-a" app={{ app_scope_id: 'app-a' } as AppRow} />));

it('shows a read that failed, with a retry that recovers it', async () => {
  let up = false;
  const seen = plane(() => (up ? Response.json(standing) : Response.json({ detail: 'control plane unavailable' }, { status: 503 })));
  await render();
  expect(container.textContent).toContain('Couldn’t load inbound email');
  expect(container.textContent).toContain('control plane unavailable');

  up = true;
  await act(async () => button('Retry', container)!.click());
  expect(seen.reads).toBe(2);
  expect(container.textContent).toContain('mail+books-abcdefghijklmnop@in.example.test');
  expect(container.textContent).not.toContain('Couldn’t load');
});

it('keeps a refused save in its dialog, across the read that follows it', async () => {
  const seen = plane(
    () => Response.json(standing),
    () => Response.json({ detail: 'allowlist.0 — an address, or @domain' }, { status: 400 }),
  );
  await render();
  await act(async () => button('Who may send', container)!.click());
  const dialog = [...container.querySelectorAll('wa-dialog')].find((d) => d.textContent?.includes('One per line'))!;
  await act(async () => buttons(dialog).find((b) => b.textContent?.trim() === 'Save')!.click());

  // The act was refused, the standing read again and answered fine, and the message is still there.
  expect(seen).toEqual({ reads: 2, writes: 1 });
  expect(dialog.textContent).toContain('an address, or @domain');
});
