import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #119: your lists in three views, each its own read, and the moves between them.
 *
 * The client is stubbed at the module seam, so what is pinned is the screen's half:
 * which read each view makes, which move each button sends for which list, that a
 * move re-reads the view, and that a refused move is a sentence above the rows, not
 * a wall in place of them. What the server does with the moves is the scenario
 * suite's (`demos/todo/test/archive-trash.test.ts`).
 */
const client = vi.hoisted(() => ({
  myLists: vi.fn(),
  trashedLists: vi.fn(),
  archiveList: vi.fn(),
  unarchiveList: vi.fn(),
  trashList: vi.fn(),
  restoreList: vi.fn(),
  deleteList: vi.fn(),
  listShares: vi.fn(),
  createList: vi.fn(),
}));

vi.mock('../src/api.js', async (original) => ({
  ...(await original<typeof import('../src/api.js')>()),
  api: client,
}));

const { Lists } = await import('../src/App.js');
const { ApiError } = await import('../src/api.js');

const list = (id: string, name: string) => ({ id, owner_id: 'o1', name, created_at: '2026-10-01T00:00:00.000Z' });
const page = (...entries: ReturnType<typeof list>[]) => ({ entries, next: null, total: null });
const moved = (id: string, state: string) => ({ id, state });

describe('Lists — active, archived and trash (#119)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    for (const fn of Object.values(client)) fn.mockReset();
    client.listShares.mockResolvedValue({ entries: [] });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const draw = (shown?: 'active' | 'archived' | 'trash') =>
    act(async () => root.render(<Lists shown={shown} />));
  const button = (label: string) => {
    const found = [...container.querySelectorAll('button')].find((b) => b.textContent === label);
    if (!found) throw new Error(`no '${label}' button in: ${container.textContent}`);
    return found;
  };
  const press = (label: string) => act(async () => button(label).click());
  const labels = () => [...container.querySelectorAll('button')].map((b) => b.textContent);

  it('the active view reads my-lists with no view, and offers archive and trash', async () => {
    client.myLists.mockResolvedValue(page(list('l1', 'Groceries')));
    await draw();
    expect(client.myLists).toHaveBeenCalledWith({});
    expect(container.textContent).toContain('Groceries');
    expect(labels()).toEqual(expect.arrayContaining(['archive', 'trash', 'Create']));
    expect(labels()).not.toContain('restore');
  });

  it('archive sends that list, and the view is read again', async () => {
    client.myLists.mockResolvedValueOnce(page(list('l1', 'Groceries'))).mockResolvedValue(page());
    client.archiveList.mockResolvedValue(moved('l1', 'archived'));
    await draw('active');
    await press('archive');
    expect(client.archiveList).toHaveBeenCalledWith({ listId: 'l1' });
    expect(client.myLists).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('Groceries');
  });

  it('the archived view reads my-lists?view=archived, and offers unarchive and trash', async () => {
    client.myLists.mockResolvedValue(page(list('l2', 'Old trip')));
    client.unarchiveList.mockResolvedValue(moved('l2', 'active'));
    client.trashList.mockResolvedValue(moved('l2', 'trashed'));
    await draw('archived');
    expect(client.myLists).toHaveBeenCalledWith({ view: 'archived' });
    expect(labels()).not.toContain('archive');
    expect(labels()).not.toContain('Create');
    await press('unarchive');
    expect(client.unarchiveList).toHaveBeenCalledWith({ listId: 'l2' });
    await press('trash');
    expect(client.trashList).toHaveBeenCalledWith({ listId: 'l2' });
  });

  it('the trash reads trashed-lists, offers restore and delete for good, and links nowhere', async () => {
    client.trashedLists.mockResolvedValue(page(list('l3', 'Binned')));
    client.restoreList.mockResolvedValue(moved('l3', 'active'));
    client.deleteList.mockResolvedValue({ id: 'l3', deleted: true });
    await draw('trash');
    expect(client.trashedLists).toHaveBeenCalled();
    expect(client.myLists).not.toHaveBeenCalled();
    // A binned list answers not_found to everything but restore, so it is no link.
    expect(container.querySelector('a[href="#/list/l3"]')).toBeNull();
    expect(labels()).not.toContain('trash');
    await press('restore');
    expect(client.restoreList).toHaveBeenCalledWith({ listId: 'l3' });
    await press('delete for good');
    expect(client.deleteList).toHaveBeenCalledWith({ listId: 'l3' });
  });

  it('a refused move is said above the rows, which stay', async () => {
    client.myLists.mockResolvedValue(page(list('l4', 'Shared with me')));
    client.trashList.mockRejectedValue(new ApiError(403, 'list:trash denied', { error: 'denied' }));
    await draw('active');
    await press('trash');
    expect(container.textContent).toContain('Not allowed.');
    expect(container.textContent).toContain('Shared with me');
  });

  it('twin: a refused READ of the view is the wall — the rows go', async () => {
    client.myLists.mockRejectedValue(new ApiError(403, 'denied', { error: 'denied' }));
    await draw('active');
    expect(container.textContent).toContain('Not allowed.');
    expect(container.querySelectorAll('.card')).toHaveLength(0);
  });

  it('the switch links to the three views and marks the one shown', async () => {
    client.trashedLists.mockResolvedValue(page());
    await draw('trash');
    const links = [...container.querySelectorAll('nav.views a')];
    expect(links.map((a) => [a.getAttribute('href'), a.textContent])).toEqual([
      ['#/', 'Active'],
      ['#/archived', 'Archived'],
      ['#/trash', 'Trash'],
    ]);
    expect(links.filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.textContent)).toEqual(['Trash']);
    expect(container.textContent).toContain('The trash is empty.');
  });
});
