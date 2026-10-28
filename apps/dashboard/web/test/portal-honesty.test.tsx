import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppRow } from '../src/lib/api';
import { Settings } from '../src/views/Settings';
import { NotificationsPopover } from '../src/components/NotificationsPopover';
import { Team } from '../src/views/Team';
import { AppDetail } from '../src/views/AppDetail';

vi.mock('../src/lib/version', () => ({ APP_VERSION: 'test', APP_SHA: 'test' }));
vi.mock('../src/lib/mock', async () => ({
  ...(await vi.importActual<typeof import('../src/lib/mock')>('../src/lib/mock')),
  DEV_MOCK: false,
}));

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
});

it('shows the selected team name and slug without offering a save that cannot act', () => {
  const slug = 'example-team-with-a-very-long-name-and-unique-suffix';
  act(() => root.render(<Settings org="Example Team" teamId="team-a" slug={slug} name="Avery" email="avery@example.test" />));
  expect(container.textContent).toContain('Example Team');
  const slugValue = [...container.querySelectorAll('span')].find((s) => s.textContent === slug)!;
  expect(slugValue.style.overflowWrap).toBe('anywhere');
  expect(slugValue.parentElement?.style.overflow).not.toBe('hidden');
  expect(container.textContent).not.toContain('Stockholm');
  expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Save')).toBe(false);
});

it('shows the signed-in identity on Profile without an inert save', () => {
  act(() => root.render(<Settings org="Example Team" teamId="team-a" slug="example-team-abc" name="Avery" email="avery@example.test" />));
  act(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Profile')!.click());
  expect(container.textContent).toContain('Avery');
  expect(container.textContent).toContain('avery@example.test');
  expect(container.textContent).not.toContain('Dana Vogel');
  expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Save')).toBe(false);
});

it('does not present fixture notifications as a live feed', () => {
  act(() => root.render(<NotificationsPopover onClose={() => undefined} onMarkRead={() => undefined} />));
  expect(container.textContent).toContain('Notifications are not available');
  expect(container.textContent).not.toContain('Mark all read');
});

it('does not offer the fixture permissions matrix', () => {
  act(() => root.render(<Team members={[]} meEmail="" canManage={false} onInvite={async () => undefined} onResend={() => undefined} onRevoke={() => undefined} onRemove={() => undefined} />));
  expect(container.textContent).not.toContain('Roles & permissions');
});

it('omits the inert app header action', () => {
  const app = { app_scope_id: 'scope-a', name: 'Example', vertical_slug: 'protocol', status: 'active', hostname: null } as AppRow;
  const html = renderToStaticMarkup(<AppDetail teamId="team-a" app={app} tab="settings/general" onTab={() => undefined} onDeleted={() => undefined} canRestore={false} canManageApp={false} />);
  expect(html).not.toContain('aria-label="More actions"');
});
