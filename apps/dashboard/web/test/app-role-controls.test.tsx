import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { MOCK_APPS, MOCK_ME } from '../src/lib/mock';

vi.mock('../src/lib/version', () => ({ APP_VERSION: 'test', APP_SHA: 'test' }));

// The first roster page contains 20 other people. The signed-in member is on a
// later page; neither app control may infer their role from this visible page.
vi.mock('../src/lib/mock', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/mock')>();
  const other = original.MOCK_MEMBERS[1]!;
  return {
    ...original,
    DEV_MOCK: true,
    MOCK_MEMBERS: Array.from({ length: 20 }, (_, i) => ({
      ...other,
      id: `other-${i}`,
      principal: `other-principal-${i}`,
      email: `other-${i}@team.test`,
    })),
  };
});

// Keep this test at the App → AppDetail boundary: the child already renders these
// controls from its props, while this regression concerns where App gets the role.
vi.mock('../src/views/AppDetail', () => ({
  AppDetail: ({ canManageApp, canRestore }: { canManageApp: boolean; canRestore: boolean }) => (
    <div>
      {canManageApp && <button>Update, Bind, Back out</button>}
      {canRestore && <button>Import</button>}
    </div>
  ),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, '', `/acme/apps/${MOCK_APPS[0]!.app_scope_id}/deployments`);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  MOCK_ME.roleKey = 'owner';
  window.history.replaceState(null, '', '/');
});

it('uses the caller role beyond the first roster page for app lifecycle controls', async () => {
  MOCK_ME.roleKey = 'owner';
  await act(async () => root.render(<App />));
  expect(container.textContent).toContain('Update, Bind, Back out');
  expect(container.textContent).toContain('Import');

  act(() => root.unmount());
  root = createRoot(container);
  MOCK_ME.roleKey = 'viewer';
  await act(async () => root.render(<App />));
  expect(container.textContent).not.toContain('Update, Bind, Back out');
  expect(container.textContent).not.toContain('Import');
});
