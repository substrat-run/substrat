// @vitest-environment jsdom
/**
 * The gestures, on the real element: what reaches a screen through properties and events.
 * jsdom lays nothing out and has no drag events, so a drag is a MouseEvent given a
 * `dataTransfer`; whether a browser agrees is checked in one, not here.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SubEntityTable } from '../src/entity-table.js';
import type { Page, TableSource } from '../src/entity-table-model.js';

type Row = { id: string };
type Table = SubEntityTable<Row>;

const page = (ids: string[], next: string | null = null): Page<Row> => ({ entries: ids.map((id) => ({ id })), next, total: null });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let intersect: (() => void)[] = [];

beforeAll(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private readonly callback: (seen: { isIntersecting: boolean }[]) => void) {}
      observe() {
        intersect.push(() => this.callback([{ isIntersecting: true }]));
      }
      disconnect() {
        intersect = [];
      }
    },
  );
  vi.stubGlobal('CSS', { escape: (s: string) => s.replace(/:/g, '\\:') });
  await import('../src/entity-table.js');
});

afterEach(() => {
  document.body.replaceChildren();
  intersect = [];
});

const SOURCE: TableSource<Row> = { read: async () => page(['a', 'b', 'c']), follow: async () => page([]) };

/** A table on the page, its first read landed, with every event of interest recorded. */
async function tableWith(set: Partial<Table> & { attrs?: string[]; source?: TableSource<Row> } = {}) {
  const { attrs = [], source = SOURCE, ...props } = set;
  const table = document.createElement('sub-entity-table') as Table;
  for (const a of attrs) table.setAttribute(a, '');
  Object.assign(table, { columns: [{ key: 'id', label: 'Id' }], source, ...props });
  const events: { type: string; detail: Record<string, unknown> }[] = [];
  for (const type of ['sub-row-click', 'sub-row-open', 'sub-selection-change', 'sub-row-contextmenu', 'sub-row-dragstart', 'sub-row-drop', 'sub-row-toggle']) {
    table.addEventListener(type, (e) => events.push({ type, detail: (e as CustomEvent).detail }));
  }
  document.body.append(table);
  await settle(table);
  return { table, events, of: (type: string) => events.filter((e) => e.type === type) };
}

async function settle(table: Table) {
  for (let i = 0; i < 3; i++) {
    await flush();
    await table.updateComplete;
  }
}

const row = (table: Table, key: string) => table.shadowRoot!.querySelector<HTMLElement>(`tr[data-entry="row:${key}"]`)!;
const plainRows = (table: Table) => [...table.shadowRoot!.querySelectorAll<HTMLElement>('tbody tr')];
const click = (el: Element, init: MouseEventInit = {}) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, ...init }));
const doubleClick = (el: Element) => {
  click(el, { detail: 1 });
  click(el, { detail: 2 });
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
};
const key = (el: Element, name: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: name, bubbles: true, composed: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
};
const drag = (el: Element, type: string) => {
  const e = new MouseEvent(type, { bubbles: true, composed: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: { setData: vi.fn(), setDragImage: vi.fn() } });
  el.dispatchEvent(e);
  return e;
};
const press = (el: Element, type: string, init: { x?: number; y?: number; id?: number; pointerType?: string } = {}) => {
  const e = new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, clientX: init.x ?? 0, clientY: init.y ?? 0 });
  Object.defineProperties(e, { pointerId: { value: init.id ?? 1 }, pointerType: { value: init.pointerType ?? 'touch' } });
  el.dispatchEvent(e);
};
const ids = (e?: { detail: Record<string, unknown> }) => (e?.detail['rows'] as Row[]).map((r) => r.id);

describe('<sub-entity-table> with nothing opted in', () => {
  it('draws no grid, takes no focus and no drag, and a row click is still immediate', async () => {
    const { table, of } = await tableWith({ attrs: ['row-click'] });
    const tableEl = table.shadowRoot!.querySelector('table')!;
    expect(tableEl.hasAttribute('role')).toBe(false);
    const tr = plainRows(table)[0]!;
    for (const attr of ['tabindex', 'draggable', 'aria-selected', 'aria-rowindex', 'data-entry']) expect(tr.hasAttribute(attr)).toBe(false);
    click(tr);
    expect(of('sub-row-click')).toHaveLength(1);
    expect(table.shadowRoot!.querySelector('.sentinel')).toBeNull();
  });
});

describe('<sub-entity-table> selection', () => {
  it('a plain selectable table still drops its selection on a page turn, after it has reported one', async () => {
    const source = { read: async () => page(['a'], 'p2'), follow: async () => page(['b']) };
    const { table, of } = await tableWith({ attrs: ['selectable'], source });
    plainRows(table)[0]!.querySelector('wa-checkbox')!.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    await settle(table);
    expect(of('sub-selection-change').at(-1)!.detail['keys']).toEqual(['a']);
    click([...table.shadowRoot!.querySelectorAll('footer wa-button')].at(-1)!);
    await settle(table);
    expect(of('sub-selection-change').at(-1)!.detail['keys']).toEqual([]);
  });

  it('a screen that set `selection` keeps it across a page turn', async () => {
    const source = { read: async () => page(['a'], 'p2'), follow: async () => page(['b']) };
    const { table, of } = await tableWith({ attrs: ['selectable'], source, selection: ['a'] });
    click([...table.shadowRoot!.querySelectorAll('footer wa-button')].at(-1)!);
    await settle(table);
    expect(of('sub-selection-change')).toHaveLength(0);
    expect(table.selection).toEqual(['a']);
  });

  it('a click selects alone, cmd toggles, shift ranges from the anchor, all reported with their rows', async () => {
    const { table, of } = await tableWith({ attrs: ['row-select'] });
    click(row(table, 'a'));
    click(row(table, 'c'), { metaKey: true });
    expect(of('sub-selection-change').at(-1)!.detail['keys']).toEqual(['a', 'c']);
    click(row(table, 'b'), { shiftKey: true });
    expect(ids(of('sub-selection-change').at(-1))).toEqual(['b', 'c']);
    expect(table.selection).toEqual(['b', 'c']);
    await table.updateComplete;
    expect(row(table, 'b').getAttribute('part')).toBe('row selected');
    expect(row(table, 'b').getAttribute('aria-selected')).toBe('true');
    expect(row(table, 'a').getAttribute('aria-selected')).toBe('false');
  });

  it('a screen setting `selection` is drawn and not echoed back as an event', async () => {
    const { table, of } = await tableWith({ selection: ['a'] });
    expect(of('sub-selection-change')).toHaveLength(0);
    table.selection = ['b'];
    await table.updateComplete;
    expect(plainRows(table)[1]!.getAttribute('part')).toBe('row selected');
    expect(of('sub-selection-change')).toHaveLength(0);
  });

  it('a click on a control of the row selects nothing', async () => {
    const { table, of } = await tableWith({
      attrs: ['row-select', 'selectable'],
      actions: [{ id: 'x', label: 'X', run: async () => undefined }],
    });
    click(row(table, 'a').querySelector('wa-button')!);
    expect(of('sub-selection-change')).toHaveLength(0);
  });

  it('a shift-held checkbox ranges under row-select', async () => {
    const { table, of } = await tableWith({ attrs: ['row-select', 'selectable'] });
    click(row(table, 'a'));
    const box = row(table, 'c').querySelector('wa-checkbox')!;
    click(box, { shiftKey: true });
    box.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    expect(of('sub-selection-change').at(-1)!.detail['keys']).toEqual(['a', 'b', 'c']);
  });
});

describe('<sub-entity-table> one click and two', () => {
  it('holds a click while a double-click is still possible, and a double-click is only an open', async () => {
    const { table, of } = await tableWith({ attrs: ['row-click', 'row-open'], doubleClickMs: 5 });
    doubleClick(row(table, 'a'));
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(of('sub-row-click')).toHaveLength(0);
    expect(ids({ detail: { rows: [of('sub-row-open')[0]!.detail['row']] } })).toEqual(['a']);

    click(row(table, 'b'));
    expect(of('sub-row-click')).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(of('sub-row-click')).toHaveLength(1);
  });

  it('a click on a second row delivers the first at once rather than losing it', async () => {
    const { table, of } = await tableWith({ attrs: ['row-click', 'row-open'], doubleClickMs: 60_000 });
    click(row(table, 'a'));
    click(row(table, 'b'));
    expect(of('sub-row-click').map((e) => e.detail['row'])).toEqual([{ id: 'a' }]);
    table.remove();
  });

  it('a click that picks rows out under row-select is not a row click', async () => {
    const { table, of } = await tableWith({ attrs: ['row-select', 'row-click'] });
    click(row(table, 'a'), { metaKey: true });
    expect(of('sub-row-click')).toHaveLength(0);
    click(row(table, 'b'));
    expect(of('sub-row-click')).toHaveLength(1);
  });

  it('defaults the double-click window to 300 ms', async () => {
    const { table } = await tableWith();
    expect(table.doubleClickMs).toBe(300);
    expect(table.longPressMs).toBe(500);
  });
});

describe('<sub-entity-table> keyboard', () => {
  const tabStop = (table: Table) => table.shadowRoot!.querySelector('tr[tabindex="0"]')?.getAttribute('data-entry');

  it('one row is the Tab stop; arrows and Home/End move it, and Space and Shift+Down pick', async () => {
    const { table, of } = await tableWith({ attrs: ['row-select'] });
    expect(table.shadowRoot!.querySelector('table')!.getAttribute('role')).toBe('grid');
    expect(tabStop(table)).toBe('row:a');
    key(row(table, 'a'), 'ArrowDown');
    await table.updateComplete;
    expect(tabStop(table)).toBe('row:b');
    key(row(table, 'b'), 'End');
    await table.updateComplete;
    expect(tabStop(table)).toBe('row:c');
    key(row(table, 'c'), 'Home');
    await table.updateComplete;
    expect(tabStop(table)).toBe('row:a');
    expect(of('sub-selection-change')).toHaveLength(0);
    key(row(table, 'a'), ' ');
    key(row(table, 'a'), 'ArrowDown', { shiftKey: true });
    expect(of('sub-selection-change').at(-1)!.detail['keys']).toEqual(['a', 'b']);
  });

  it('Enter opens the row, Escape clears, cmd+A takes the loaded rows and stops the browser selecting the page', async () => {
    const { table, of } = await tableWith({ attrs: ['row-select', 'row-open'] });
    key(row(table, 'b'), 'Enter');
    expect(of('sub-row-open')[0]!.detail['row']).toEqual({ id: 'b' });
    expect(key(row(table, 'a'), 'a', { metaKey: true }).defaultPrevented).toBe(true);
    expect(table.selection).toEqual(['a', 'b', 'c']);
    key(row(table, 'a'), 'Escape');
    expect(table.selection).toEqual([]);
  });

  it('keeps focus nearby when a re-read removes the focused row', async () => {
    let rows = ['a', 'b', 'c'];
    const { table } = await tableWith({ attrs: ['row-select'], source: { read: async () => page(rows), follow: async () => page([]) } });
    row(table, 'b').focus();
    await table.updateComplete;
    rows = ['a', 'c'];
    await table.reload();
    await settle(table);
    expect((table.shadowRoot!.activeElement as HTMLElement | null)?.dataset['entry']).toBe('row:c');
  });

  it('leaves a key pressed on a control inside the row alone', async () => {
    const { table } = await tableWith({ attrs: ['row-select'], actions: [{ id: 'x', label: 'X', run: async () => undefined }] });
    expect(key(row(table, 'a').querySelector('wa-button')!, 'ArrowDown').defaultPrevented).toBe(false);
  });
});

describe('<sub-entity-table> paging="scroll"', () => {
  const growing = () => {
    const follow = vi.fn(async (next: string) => (next === 'p2' ? page(['c'], 'p3') : page(['d'])));
    return { follow, source: { read: async () => page(['a', 'b'], 'p2'), follow } };
  };

  it('reads on when the end comes into view, watches the new end, and stops at the last page', async () => {
    const { source, follow } = growing();
    const { table } = await tableWith({ source, paging: 'scroll' });
    expect(table.shadowRoot!.querySelector('footer wa-button')!.textContent).toContain('Load more');
    intersect[0]!();
    await settle(table);
    expect(follow).toHaveBeenCalledTimes(1);
    expect(intersect).toHaveLength(1);
    intersect[0]!();
    await settle(table);
    expect(plainRows(table)).toHaveLength(4);
    expect(table.shadowRoot!.querySelector('.sentinel')).toBeNull();
    expect(table.shadowRoot!.querySelector('table')!.hasAttribute('aria-rowcount')).toBe(false);
  });

  it('a page that fails does not re-arm the observer, so it cannot spin; the button stays', async () => {
    const follow = vi.fn(() => Promise.reject(new Error('down')));
    const { table } = await tableWith({ source: { read: async () => page(['a'], 'p2'), follow }, paging: 'scroll' });
    intersect[0]!();
    await settle(table);
    expect(follow).toHaveBeenCalledTimes(1);
    expect(intersect).toHaveLength(1);
    expect(table.shadowRoot!.querySelector('footer wa-button')).not.toBeNull();
    expect(table.shadowRoot!.querySelector('wa-callout')!.textContent).toContain('down');
  });

  it('Down on the last row loads the next page, and aria-rowcount follows the loaded rows', async () => {
    const { source } = growing();
    const { table } = await tableWith({ source, paging: 'scroll', attrs: ['row-select'] });
    const grid = table.shadowRoot!.querySelector('table')!;
    expect(grid.getAttribute('aria-rowcount')).toBe('3');
    key(row(table, 'b'), 'ArrowDown');
    await settle(table);
    expect(row(table, 'c')).toBeTruthy();
    expect(grid.getAttribute('aria-rowcount')).toBe('4');
    expect(table.shadowRoot!.querySelector('tr[tabindex="0"]')?.getAttribute('data-entry')).toBe('row:c');
  });
});

describe('<sub-entity-table> right-click', () => {
  const rightClick = (el: Element) => {
    const e = new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 7, clientY: 9 });
    el.dispatchEvent(e);
    return e;
  };

  it('reports position; the browser menu stays unless the screen cancels the event', async () => {
    const { table, of } = await tableWith();
    expect(rightClick(plainRows(table)[0]!).defaultPrevented).toBe(false);
    expect(of('sub-row-contextmenu')[0]!.detail).toMatchObject({ row: { id: 'a' }, x: 7, y: 9 });
    table.addEventListener('sub-row-contextmenu', (e) => e.preventDefault());
    expect(rightClick(plainRows(table)[0]!).defaultPrevented).toBe(true);
  });

  it('under row-select a right-click selects an unselected row and leaves a selection it is part of', async () => {
    const { table } = await tableWith({ attrs: ['row-select'], selection: ['a', 'b'] });
    rightClick(row(table, 'a'));
    expect(table.selection).toEqual(['a', 'b']);
    rightClick(row(table, 'c'));
    expect(table.selection).toEqual(['c']);
  });
});

describe('<sub-entity-table> drag and drop', () => {
  it('drags the whole selection from a selected row, and only the row from any other', async () => {
    const { table, of } = await tableWith({ attrs: ['row-select', 'row-draggable'], selection: ['a', 'b'] });
    expect(row(table, 'a').getAttribute('draggable')).toBe('true');
    drag(row(table, 'a'), 'dragstart');
    expect(ids(of('sub-row-dragstart')[0])).toEqual(['a', 'b']);
    expect(of('sub-row-dragstart')[0]!.detail['dataTransfer']).toBeTruthy();
    drag(row(table, 'c'), 'dragstart');
    expect(ids(of('sub-row-dragstart')[1])).toEqual(['c']);
  });

  it('refuses a drop canDrop refuses, and on a dragged row; accepts, marks and reports the rest', async () => {
    const canDrop = vi.fn((r: Row) => r.id !== 'c');
    const { table, of } = await tableWith({ attrs: ['row-draggable'], canDrop, source: { read: async () => page(['a', 'b', 'c', 'd']), follow: async () => page([]) } });
    drag(row(table, 'a'), 'dragstart');

    expect(drag(row(table, 'a'), 'dragover').defaultPrevented).toBe(false);
    expect(drag(row(table, 'c'), 'dragover').defaultPrevented).toBe(false);
    expect(drag(row(table, 'c'), 'drop').defaultPrevented).toBe(false);
    expect(of('sub-row-drop')).toHaveLength(0);
    expect(canDrop).toHaveBeenCalledWith({ id: 'c' }, [{ id: 'a' }]);

    expect(drag(row(table, 'b'), 'dragover').defaultPrevented).toBe(true);
    await table.updateComplete;
    expect(row(table, 'b').getAttribute('part')).toBe('row drop-target');

    drag(row(table, 'b'), 'drop');
    expect(of('sub-row-drop')[0]!.detail).toMatchObject({ target: { id: 'b' }, dragged: [{ id: 'a' }] });
    await table.updateComplete;
    expect(row(table, 'b').getAttribute('part')).toBe('row');
  });

  it('without canDrop no row takes a drop, canDrag narrows what starts one, and a cancel refuses it', async () => {
    const { table } = await tableWith({ attrs: ['row-draggable'], canDrag: (r) => r.id !== 'b' });
    expect(row(table, 'b').hasAttribute('draggable')).toBe(false);
    drag(row(table, 'a'), 'dragstart');
    expect(drag(row(table, 'b'), 'dragover').defaultPrevented).toBe(false);
    table.addEventListener('sub-row-dragstart', (e) => e.preventDefault());
    expect(drag(row(table, 'a'), 'dragstart').defaultPrevented).toBe(true);
  });

  it('the preview counts what is moving', async () => {
    const { table } = await tableWith({ attrs: ['row-select', 'row-draggable'], selection: ['a', 'b'] });
    const e = drag(row(table, 'a'), 'dragstart') as DragEvent;
    const image = vi.mocked(e.dataTransfer!.setDragImage).mock.calls[0]![0] as HTMLElement;
    expect(image.textContent).toBe('2 items');
  });

  it('a long press starts the drag and a finger that moves first scrolls instead', async () => {
    const { table, of } = await tableWith({ attrs: ['row-draggable'], longPressMs: 5 });
    press(row(table, 'a'), 'pointerdown', { x: 10, y: 10 });
    press(window as unknown as Element, 'pointermove', { x: 10, y: 40 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(of('sub-row-dragstart')).toHaveLength(0);

    press(row(table, 'b'), 'pointerdown', { x: 10, y: 10 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(ids(of('sub-row-dragstart')[0])).toEqual(['b']);
    expect(of('sub-row-dragstart')[0]!.detail['dataTransfer']).toBeNull();

    const scroll = new Event('touchmove', { bubbles: true, cancelable: true });
    row(table, 'b').dispatchEvent(scroll);
    expect(scroll.defaultPrevented).toBe(true);
    press(window as unknown as Element, 'pointerup');
    await table.updateComplete;
  });

  it('a mouse press never starts a long-press drag', async () => {
    const { table, of } = await tableWith({ attrs: ['row-draggable'], longPressMs: 1 });
    press(row(table, 'a'), 'pointerdown', { pointerType: 'mouse' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(of('sub-row-dragstart')).toHaveLength(0);
  });
});

describe('<sub-entity-table> nested rows', () => {
  const tree = (reads: Record<string, () => Promise<Page<Row>>>) => ({
    attrs: ['row-select'],
    paging: 'scroll' as const,
    childrenOf: (r: Row): TableSource<Row> => ({ read: () => reads[r.id]!(), follow: async () => page([]) }),
    canExpand: (r: Row) => r.id in reads,
  });

  it('Right opens then steps in, Left steps out then closes, reported through sub-row-toggle', async () => {
    const { table, of } = await tableWith(tree({ a: async () => page(['a1']) }));
    expect(table.shadowRoot!.querySelector('table')!.getAttribute('role')).toBe('treegrid');
    expect(row(table, 'a').getAttribute('aria-expanded')).toBe('false');
    expect(row(table, 'b').hasAttribute('aria-expanded')).toBe(false);

    key(row(table, 'a'), 'ArrowRight');
    await settle(table);
    expect(of('sub-row-toggle')[0]!.detail).toMatchObject({ key: 'a', open: true, keys: ['a'] });
    expect(row(table, 'a1').getAttribute('aria-level')).toBe('2');
    expect(row(table, 'a1').querySelector<HTMLElement>('.nested')!.getAttribute('style')).toContain('--sub-level:1');

    key(row(table, 'a'), 'ArrowRight');
    await table.updateComplete;
    expect(table.shadowRoot!.querySelector('tr[tabindex="0"]')?.getAttribute('data-entry')).toBe('row:a1');

    key(row(table, 'a1'), 'ArrowLeft');
    await table.updateComplete;
    expect(table.shadowRoot!.querySelector('tr[tabindex="0"]')?.getAttribute('data-entry')).toBe('row:a');
    key(row(table, 'a'), 'ArrowLeft');
    await settle(table);
    expect(row(table, 'a1')).toBeNull();
    expect(table.open).toEqual([]);
  });

  it('opens what the screen set, draws a refused and a failed read inside their rows, and offers Try again', async () => {
    let failing = true;
    const { table } = await tableWith({
      ...tree({
        a: () => Promise.reject(Object.assign(new Error('no'), { status: 403 })),
        b: () => (failing ? Promise.reject(new Error('boom')) : Promise.resolve(page(['b1']))),
      }),
      open: ['a', 'b'],
      forbiddenText: 'Walled off',
    });
    const lines = [...table.shadowRoot!.querySelectorAll('tr.level-line')].map((tr) => tr.textContent!.replace(/\s+/g, ' ').trim());
    expect(lines[0]).toContain('Walled off');
    expect(lines[1]).toContain('boom');
    expect(table.shadowRoot!.querySelector('wa-callout')).toBeNull();
    failing = false;
    click(table.shadowRoot!.querySelector('tr.level-line wa-button')!);
    await settle(table);
    expect(row(table, 'b1')).toBeTruthy();
  });

  it('mounts a nested row’s cell, indented like any other', async () => {
    const mount = vi.fn((cell: HTMLElement, r: Row) => void (cell.textContent = r.id));
    const { table } = await tableWith({ ...tree({ a: async () => page(['a1']) }), open: ['a'], columns: [{ key: 'id', label: 'Id', mount }] });
    expect(mount.mock.calls.map((c) => c[1].id)).toEqual(expect.arrayContaining(['a', 'a1']));
    expect(row(table, 'a1').querySelector('.nested slot')).not.toBeNull();
  });

  it('reload(key) reads just that level again', async () => {
    let children = ['a1'];
    const { table } = await tableWith({ ...tree({ a: async () => page(children) }), open: ['a'] });
    children = ['a2'];
    await table.reload('a');
    await settle(table);
    expect(row(table, 'a2')).toBeTruthy();
  });
});

describe('<sub-entity-table> row actions', () => {
  it('draws an icon with the label as its name, and menu actions always go in More', async () => {
    const run = async () => undefined;
    const { table } = await tableWith({
      actions: [
        { id: 'star', label: 'Star', icon: 'star', run },
        { id: 'del', label: 'Delete', menu: true, icon: { src: 'data:image/svg+xml,x' }, run },
      ],
    });
    const cell = plainRows(table)[0]!.querySelector('td.actions')!;
    const star = cell.querySelector('wa-button')!;
    expect(star.getAttribute('title')).toBe('Star');
    expect(star.querySelector('wa-icon')!.getAttribute('name')).toBe('star');
    expect(star.textContent).toContain('Star');
    const item = cell.querySelector('wa-dropdown-item')!;
    expect(item.textContent).toContain('Delete');
    expect(item.querySelector('wa-icon')!.getAttribute('slot')).toBe('icon');
  });
});
