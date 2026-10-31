import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoundScopeRow, BoundScopesView, Deployment } from '../src/lib/api';
import { BoundScopes } from '../src/views/BoundScopes';

const client = vi.hoisted(() => ({ listBoundScopes: vi.fn() }));
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  teamApi: () => client,
}));

/**
 * A healthy vertical's installs are not a cleanup list: the section folds to one summary line
 * unless there is a reason to act, and a preview's snapshot forks fold again inside it, so a
 * vertical with busy previews does not read as a page of anonymous installs.
 */

const D: Deployment = {
  slug: 'acme/drive', displaySlug: 'drive', name: 'Drive', source: 'cli', owned: true,
  versions: [{ id: 'V1', version: '1.0.0', createdAt: '2026-10-01T00:00:00.000Z' } as Deployment['versions'][number]],
  channels: [{ channel: 'prod', versionId: 'V1' }],
};
const scope = (id: string, over: Partial<BoundScopeRow> = {}): BoundScopeRow => ({
  id, slug: id.toLowerCase(), name: id, status: 'active', fork: false, movable: true, verticalVersionId: 'V1', createdAt: '2026-10-01T00:00:00.000Z', hostnames: [], ...over,
});
const VIEW: BoundScopesView = {
  live: 3, archived: 0,
  scopes: [scope('Family'), scope('FORK1', { fork: true, movable: false }), scope('FORK2', { fork: true, movable: false })],
};

describe('Bound scopes — folded unless there is something to do', () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    client.listBoundScopes.mockReset().mockResolvedValue(VIEW);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const button = (name: RegExp) => [...container.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
  const render = (props: { expanded?: boolean; onExpand?: () => void }) =>
    act(async () => root.render(<BoundScopes teamId="T1" d={D} all={[D]} onChanged={() => {}} {...props} />));

  it('a vertical nobody is removing shows one summary line, and Manage asks to open it', async () => {
    const onExpand = vi.fn();
    await render({ onExpand });
    expect(container.textContent).toContain('1 install · 2 snapshot forks');
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    await act(async () => button(/^Manage/)!.click());
    expect(onExpand).toHaveBeenCalledOnce();
  });

  it('opened, it lists the installs and keeps the snapshot forks behind their own toggle', async () => {
    await render({ expanded: true });
    expect(container.textContent).toContain('Family');
    expect(container.textContent).not.toContain('FORK1');
    await act(async () => button(/^Show 2 snapshot forks$/)!.click());
    expect(container.textContent).toContain('FORK1');
  });
});
