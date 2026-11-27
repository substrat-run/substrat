// @vitest-environment jsdom
/**
 * The table's words: every one of them replaceable, and layered on Web Awesome's translation
 * registry (the table's own `labels`, then the registered language, then English). Its own file
 * because a registered translation is page-wide and would leak into the other suites.
 */
import { LocalizeController } from '@awesome.me/webawesome/dist/utilities/localize.js';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EntityTableLabels, SubEntityTable } from '../src/entity-table.js';
import type { Page, RowAction, TableSource } from '../src/entity-table-model.js';

type Row = { id: string; flag: number; amount: number };
type Table = SubEntityTable<Row>;

let entityTable: typeof import('../src/entity-table.js');
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('CSS', { escape: (s: string) => s });
  entityTable = await import('../src/entity-table.js');
});

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('lang');
});

class Refusal extends Error {
  constructor(readonly status: number) {
    super('«d:server»');
  }
}

/** Data is marked `«d:…»`, so it is told apart from a word and taken out with the words. */
const rowOf = (id: string): Row => ({ id: `«d:${id}»`, flag: id === 'c' ? 0 : 1, amount: 1234.5 });
const page = (ids: string[], next: string | null = null, total: number | null = null): Page<Row> => ({ entries: ids.map((id) => rowOf(id)), next, total });
const COLUMNS = [
  { key: 'id', label: '«d:name»' },
  { key: 'flag', label: '«d:flag»', kind: 'boolean' as const },
  { key: 'amount', label: '«d:amount»', kind: 'number' as const },
];

async function settle(table: Table) {
  for (let i = 0; i < 4; i++) {
    await flush();
    await table.updateComplete;
  }
}

async function tableIn(parent: HTMLElement, props: Partial<Table> & { attrs?: string[] } = {}) {
  const { attrs = [], ...rest } = props;
  const table = document.createElement('sub-entity-table') as Table;
  for (const a of attrs) table.setAttribute(a, '');
  Object.assign(table, { columns: COLUMNS, source: { read: async () => page(['a', 'b', 'c']), follow: async () => page([]) }, ...rest });
  parent.append(table);
  await settle(table);
  return table;
}

const root = (table: Table) => table.shadowRoot!;
const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
const change = (el: Element) => el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

/** Everything a person sees or hears in the table: its text (no CSS), and the attributes a screen reader reads. */
function spoken(table: Table): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root(table), NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest('style')) continue;
    out.push(node.textContent ?? '');
  }
  for (const el of root(table).querySelectorAll('*')) {
    // The attributes that carry words; the other `aria-*` carry tokens (`true`, `polite`).
    for (const attr of ['aria-label', 'aria-roledescription', 'aria-description', 'aria-valuetext', 'aria-placeholder', 'title', 'placeholder', 'label']) {
      const value = el.getAttribute(attr);
      if (value) out.push(value);
    }
  }
  return out;
}

/** Every word replaced by `«key»`; what was said is collected, and anything else in a letter is a leak. */
function placeholders() {
  const labels = Object.fromEntries(
    Object.entries(entityTable.ENTITY_TABLE_LABELS).map(([key, value]) => [key, typeof value === 'function' ? () => `«${key}»` : `«${key}»`]),
  ) as unknown as EntityTableLabels;
  const seen = new Set<string>();
  const leaks: string[] = [];
  const hear = (step: string, text: string) => {
    for (const [, key] of text.matchAll(/«(\w+)»/g)) seen.add(key!);
    const left = text.replace(/«[^»]*»/g, ' ').replace(/[^\p{L}]+/gu, ' ').trim();
    if (left) leaks.push(`${step}: ${left}`);
  };
  const check = (step: string, table: Table) => hear(step, spoken(table).join(' '));
  return { labels, seen, leaks, hear, check };
}

describe('<sub-entity-table> labels', () => {
  it('says nothing in English once every label is replaced, across every state that shows text', async () => {
    const { labels, seen, leaks, hear, check } = placeholders();

    // A table with every control: views, search, a filter, the columns menu, a selection and actions.
    let outcome: Record<string, () => Promise<unknown>> = {};
    const run = (row: Row) => (outcome[row.id] ?? (async () => undefined))();
    const actions: RowAction<Row>[] = [
      { id: 'open', label: '«d:open»', icon: 'eye', run },
      { id: 'archive', label: '«d:archive»', bulk: true, run },
      { id: 'delete', label: '«d:delete»', menu: true, run },
    ];
    const full = await tableIn(document.body, {
      labels,
      attrs: ['selectable', 'column-picker'],
      views: [{ id: 'all', label: '«d:all»' }, { id: 'mine', label: '«d:mine»' }],
      filters: [{ key: 'flag', label: '«d:flag»', options: [{ value: '1', label: '«d:one»' }] }],
      actions,
      source: {
        read: async () => page(['a', 'b', 'c'], 'next', 30),
        follow: async () => page([]),
        search: async () => ({ results: [], capped: false }),
      },
    });
    check('first render', full);

    const moves = (key: string) => root(full).querySelectorAll(`li[data-key="${key}"] .moves wa-button`);
    click(moves('flag')[1]!);
    await settle(full);
    check('a column moved', full);
    change(root(full).querySelector('li[data-key="flag"] wa-checkbox')!);
    await settle(full);
    check('a column hidden', full);
    change(root(full).querySelector('li[data-key="flag"] wa-checkbox')!);
    await settle(full);
    check('a column shown', full);
    click(root(full).querySelector('.picker-foot wa-button')!);
    await settle(full);
    check('columns reset', full);

    for (const pick of root(full).querySelectorAll('td.pick wa-checkbox')) change(pick);
    await settle(full);
    check('a selection', full);
    outcome = {
      '«d:a»': () => Promise.reject(new Refusal(403)),
      '«d:b»': () => Promise.reject(new Refusal(409)),
      '«d:c»': () => Promise.reject(new Error('«d:server»')),
    };
    click(root(full).querySelector('.bulk wa-button')!);
    await settle(full);
    check('a bulk action partly done', full);

    for (const [status, step] of [[409, 'changed somewhere else'], [403, 'refused'], [500, 'failed']] as const) {
      outcome = { '«d:a»': () => Promise.reject(status === 500 ? new Error('«d:server»') : new Refusal(status)) };
      click(root(full).querySelector('td.actions wa-button')!);
      await settle(full);
      check(`an action ${step}`, full);
    }

    const drag = new MouseEvent('dragstart', { bubbles: true, composed: true, cancelable: true });
    const setDragImage = vi.fn();
    Object.defineProperty(drag, 'dataTransfer', { value: { setData: vi.fn(), setDragImage } });
    const dragged = await tableIn(document.body, { labels, attrs: ['row-select', 'row-draggable'], selection: ['«d:a»', '«d:b»'] });
    root(dragged).querySelector('tbody tr')!.dispatchEvent(drag);
    hear('a drag of two rows', (setDragImage.mock.calls[0]![0] as HTMLElement).textContent ?? '');

    const states: [string, Partial<Table>][] = [
      ['empty', { source: { read: async () => page([]), follow: async () => page([]) } }],
      ['forbidden', { source: { read: () => Promise.reject(new Refusal(403)), follow: async () => page([]) } }],
      ['a read that failed', { source: { read: () => Promise.reject(new Error('«d:server»')), follow: async () => page([]) } }],
      [
        'filters that match nothing',
        {
          filters: [{ key: 'flag', label: '«d:flag»', options: [{ value: '1', label: '«d:one»' }] }],
          query: { filters: { flag: '1' } },
          source: { read: async () => page([]), follow: async () => page([]) },
        },
      ],
      [
        'a search that matches nothing',
        { query: { q: '«d:term»' }, source: { read: async () => page([]), follow: async () => page([]), search: async () => ({ results: [], capped: false }) } },
      ],
      [
        'a search that matched',
        { filters: [{ key: 'flag', label: '«d:flag»', options: [{ value: '1', label: '«d:one»' }] }], query: { q: '«d:term»' }, source: { read: async () => page([]), follow: async () => page([]), search: async () => ({ results: [rowOf('a')], capped: false }) } },
      ],
      [
        'a capped search',
        { query: { q: '«d:term»' }, source: { read: async () => page([]), follow: async () => page([]), search: async () => ({ results: [rowOf('a')], capped: true }) } },
      ],
      ['load more, no total', { paging: 'more', source: { read: async () => page(['a'], 'next'), follow: async () => page([]) } }],
      ['load more, with a total', { paging: 'more', source: { read: async () => page(['a'], 'next', 9), follow: async () => page([]) } }],
      ['one short page', { source: { read: async () => page(['a'], null, 1), follow: async () => page([]) } }],
      [
        'open rows, each level in another state',
        {
          paging: 'scroll',
          open: ['«d:a»', '«d:b»', '«d:c»', '«d:d»', '«d:e»'],
          canExpand: () => true,
          childrenOf: (row: Row): TableSource<Row> => ({
            read: {
              '«d:a»': () => new Promise<Page<Row>>(() => {}),
              '«d:b»': async () => page([]),
              '«d:c»': () => Promise.reject(new Refusal(403)),
              '«d:d»': () => Promise.reject(new Error('«d:server»')),
              '«d:e»': async () => page(['e1'], 'next'),
            }[row.id]!,
            follow: async () => page([]),
          }),
          source: { read: async () => page(['a', 'b', 'c', 'd', 'e'], 'next'), follow: async () => page([]) },
        },
      ],
    ];
    for (const [step, props] of states) check(step, await tableIn(document.body, { labels, ...props }));

    expect(leaks).toEqual([]);
    // Only a laid-out page reaches this: a column the table drops while it is too narrow.
    const layoutOnly = ['hiddenWhileNarrow'];
    expect(Object.keys(entityTable.ENTITY_TABLE_LABELS).filter((key) => !seen.has(key) && !layoutOnly.includes(key))).toEqual([]);
  });

  it("registers its own English in Web Awesome's registry and reuses Web Awesome's words, by the nearest lang", async () => {
    await import('@awesome.me/webawesome/dist/translations/sv.js');
    entityTable.registerEntityTableLabels('sv', { clear: 'Rensa', selected: (n) => `${n} valda` });
    const section = document.createElement('section');
    section.lang = 'sv-FI';
    document.body.append(section);
    const table = await tableIn(section, { attrs: ['selectable', 'column-picker'] });
    // From Web Awesome's own Swedish, which the table registered nothing for.
    expect(root(table).querySelector('.picker-body')!.getAttribute('aria-label')).toBe('Kolumner');
    table.selection = ['«d:a»'];
    await settle(table);

    const registry = new LocalizeController(table);
    const has = (key: string) => registry.exists(key as never, { lang: 'en', includeFallback: false });
    expect(has('sub-entity-table.clear')).toBe(true);
    // A word Web Awesome has is read from its key, never registered again under the table's.
    expect(has('sub-entity-table.columns')).toBe(false);

    expect(root(table).querySelector('.bulk strong')!.textContent).toBe('1 valda');
    expect(root(table).querySelector('.bulk wa-button')!.textContent!.trim()).toBe('Rensa');
    // A word Swedish does not register is English.
    expect(root(table).querySelector('.bulk')!.getAttribute('aria-label')).toBe('Selection');

    // Web Awesome's components read only their own lang or the page's: the table hands them its own.
    const langs = new Set([...root(table).querySelectorAll('*')].filter((el) => el.localName.startsWith('wa-')).map((el) => el.getAttribute('lang')));
    expect(langs).toEqual(new Set(['sv-FI']));
    table.lang = 'de';
    await settle(table);
    const own = new Set([...root(table).querySelectorAll('*')].filter((el) => el.localName.startsWith('wa-')).map((el) => el.getAttribute('lang')));
    expect(own).toEqual(new Set(['de']));
  });

  it('lets a set `empty` win over `labels`, and formats a cell in its language', async () => {
    document.documentElement.lang = 'sv';
    const empty = await tableIn(document.body, { labels: { empty: 'Inget' }, source: { read: async () => page([]), follow: async () => page([]) } });
    expect(root(empty).querySelector('[part="empty"]')!.textContent!.trim()).toBe('Inget');
    empty.empty = 'Här är tomt.';
    await settle(empty);
    expect(root(empty).querySelector('[part="empty"]')!.textContent!.trim()).toBe('Här är tomt.');

    const rows = await tableIn(document.body);
    expect(root(rows).querySelector('tbody tr td:nth-child(3)')!.textContent!.trim()).toMatch(/^1\s234,5$/);
  });

  it('draws in the browser language when the page carries a malformed lang', async () => {
    document.documentElement.lang = 'en_US';
    const table = await tableIn(document.body, { attrs: ['selectable'] });
    expect(root(table).querySelectorAll('tbody tr')).toHaveLength(3);
    expect(root(table).querySelector('wa-checkbox')!.getAttribute('lang')).toBe(navigator.language);
  });
});
