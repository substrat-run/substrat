import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionIntentView, UnreadableIntentView } from '../src/lib/api';
import { IntentLedger } from '../src/views/Integrations';

/** #1637: a dispatch record the platform could not read whole is shown, not dropped. */

const delivered: ConnectionIntentView = {
  id: '01JAAAAAAAAAAAAAAAAAAAAAAA',
  status: 'done',
  attempts: 1,
  lastError: null,
  requestedAt: '2026-09-01T00:00:00.000Z',
  settledAt: '2026-09-01T00:00:01.000Z',
  eventType: 'invoice.sent',
  failure: null,
};
const unreadable: UnreadableIntentView = {
  id: 'not-a-ulid',
  status: 'queued',
  requestedAt: null,
  decodeError: 'id: Invalid string; status: Invalid option',
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (intents: ConnectionIntentView[], unreadableIntents: UnreadableIntentView[]) =>
  act(() => root.render(<IntentLedger intents={intents} unreadable={unreadableIntents} providerName="Fortnox" grants={[]} />));

describe('IntentLedger — an unreadable record (#1637)', () => {
  it('is rendered as stored, with the columns that broke, beside the deliveries', () => {
    render([delivered], [unreadable]);
    expect(host.textContent).toContain('Unreadable');
    expect(host.textContent).toContain('stored as not-a-ulid · status queued · sent at an unknown time');
    expect(host.textContent).toContain('id: Invalid string; status: Invalid option');
    expect(host.textContent).toContain('Delivered');
  });

  it('is rendered even when it is the only record — the ledger does not read as empty', () => {
    render([], [unreadable]);
    expect(host.textContent).toContain('Unreadable');
  });

  it('a clean ledger says nothing about unreadable records (the positive twin)', () => {
    render([delivered], []);
    expect(host.textContent).not.toContain('Unreadable');
    expect(host.textContent).toContain('Delivered');
  });
});
