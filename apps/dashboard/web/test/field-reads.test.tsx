import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, type AppRow, type FieldReadsView } from '../src/lib/api';
import { Data } from '../src/views/AppDetail';
import { FieldReads } from '../src/views/FieldReads';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const window = { since: '2026-10-01T00:00:00.000Z', until: '2026-10-02T00:00:00.000Z' };
const answer: FieldReadsView = {
  available: true, source: 'vertical-asserted', window,
  groups: [{ sampleRate: 0.1, armedRequests: 2, refused: 0,
    operations: [{ operation: 'acme/get', responses: 2, fields: [
      { field: 'id', present: 2, empty: 0, absent: 0, eligible: 2, sampleRate: 0.1, window },
      { field: 'optional', present: 0, empty: 0, absent: 2, eligible: 0, sampleRate: 0.1, window },
    ] }], notObservedReturned: [{ operation: 'acme/get', field: 'optional' }] }],
};

it('shows vertical assertion, rate and window beside sampled counts', async () => {
  vi.spyOn(api, 'appFieldReads').mockResolvedValue(answer);
  await act(async () => root.render(<FieldReads scopeId="scope-a" />));
  expect(container.textContent).toContain('Vertical-asserted');
  expect(container.textContent).toContain('10.0% router sample');
  expect(container.textContent).toContain(window.since);
  expect(container.textContent).toContain('acme/get.optional');
  expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
});

it('uses the unarmed empty state only when there are no router arms', async () => {
  vi.spyOn(api, 'appFieldReads').mockResolvedValue({ ...answer, groups: [] });
  await act(async () => root.render(<FieldReads scopeId="scope-a" />));
  expect(container.textContent).toContain('No requests were armed');
});

it('shows an unknown rate without guessing for older router lines', async () => {
  vi.spyOn(api, 'appFieldReads').mockResolvedValue({ ...answer, groups: [{ ...answer.groups[0]!, sampleRate: null }] });
  await act(async () => root.render(<FieldReads scopeId="scope-a" />));
  expect(container.textContent).toContain('rate unknown');
});

it('sits beside the declared Field coverage card on the app page, for that app only', async () => {
  vi.spyOn(api, 'appFieldCoverage').mockResolvedValue({
    available: true, entities: [], declared: 2, returned: 2, neverReturnedErasable: 0, operations: 1 });
  const reads = vi.spyOn(api, 'appFieldReads').mockResolvedValue(answer);
  vi.spyOn(api, 'appModel').mockReturnValue(new Promise(() => {}));
  const app = { app_scope_id: 'scope-a', name: 'Acme', vertical_slug: 'acme/widgets', status: 'active' } as AppRow;
  await act(async () => root.render(<Data app={app} section="schema" onSection={() => {}} />));
  const headings = [...container.querySelectorAll('h3')].map((h) => h.textContent);
  expect(headings.slice(0, 2)).toEqual(['Field coverage', 'Sampled field counts']);
  expect(reads).toHaveBeenCalledWith('scope-a', 24);
  expect(container.textContent).toContain('acme/get.optional');
});
