import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { AppRow } from '../src/lib/api';
import { Apps, Onboarding } from '../src/views/Apps';
import { setTeamSlug } from '../src/lib/router';

const app = { app_scope_id: 'scope-a', name: 'Example', vertical_slug: 'protocol', status: 'active', hostname: null, created_at: '2026-10-01T00:00:00Z' } as AppRow;
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
  setTeamSlug(null);
});

it('keeps a responsive grid and a compact Create App action', () => {
  act(() => root.render(<Apps teamId="team-a" apps={[app]} onCreate={() => undefined} onOpen={() => undefined} onRetry={() => undefined} />));
  act(() => [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Grid view')!.click());
  expect(container.querySelector('.apps-grid')).not.toBeNull();
  expect(container.querySelector('.apps-create-label')?.textContent).toBe('Create App');
});

it('shows a clearable no-match state without replacing first-app onboarding', () => {
  act(() => root.render(<Apps teamId="team-a" apps={[app]} onCreate={() => undefined} onOpen={() => undefined} onRetry={() => undefined} />));
  const search = container.querySelector('input[placeholder="Search apps…"]')!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { set.call(search, 'missing'); search.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(container.textContent).toContain('No apps match');
  act(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Clear filters')!.click());
  expect(container.textContent).not.toContain('No apps match');
  expect(container.textContent).not.toContain('Create your first app');
});

it('links the remaining onboarding steps to their real team pages', () => {
  setTeamSlug('example-team');
  act(() => root.render(<Onboarding onCreate={() => undefined} />));
  expect(container.querySelector('a[href="/example-team/team"]')?.textContent).toContain('Invite your team');
  expect(container.querySelector('a[href="/example-team/domains"]')?.textContent).toContain('Connect a domain');
});
