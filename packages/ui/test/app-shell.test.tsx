// @vitest-environment jsdom
/**
 * `AppShell` on a phone (dashboard-ui.md §5.1): below `drawerBelow` the sidebar is a drawer
 * behind a hamburger, and while it is open the page behind it is `inert`, so Tab stays in
 * the drawer the way a dialog's focus does (§5.2). Where `matchMedia` does not exist (jsdom,
 * some embedders) the shell keeps the wide layout rather than throwing.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AppShell } from '../src/components/AppShell';

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
  delete (window as { matchMedia?: unknown }).matchMedia;
});

function render() {
  act(() =>
    root.render(
      <AppShell
        brand={<span>brand</span>}
        groups={[{ items: [{ key: 'apps', label: 'Apps', icon: null, href: '/apps' }] }]}
        active="apps"
        onNav={() => {}}
        footer={null}
        crumbs={[{ label: 'Team' }, { label: 'Apps' }]}
        drawerBelow={767}
      >
        <p>content</p>
      </AppShell>,
    ),
  );
}

const hamburger = () => container.querySelector<HTMLButtonElement>('button[aria-label="Open navigation"]');
const page = () => container.querySelector('main')!.parentElement!;

it('opens a drawer that makes the page inert, and Escape gives the page and focus back', () => {
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as never;
  render();
  // A phone shows where you are, not the trail.
  expect(container.querySelector('header')!.textContent).not.toContain('Team');

  act(() => hamburger()!.click());
  expect(page().hasAttribute('inert')).toBe(true);
  expect(document.activeElement?.getAttribute('href')).toBe('/apps');

  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(page().hasAttribute('inert')).toBe(false);
  expect(document.activeElement).toBe(hamburger());
});

it('keeps the wide layout where matchMedia does not exist', () => {
  render();
  expect(hamburger()).toBeNull();
  expect(container.querySelector('header')!.textContent).toContain('Team');
});
