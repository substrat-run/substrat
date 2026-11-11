/**
 * The live `@substrat-run/elements` demos on the elements reference page: each one the real
 * element, fed by in-memory data instead of a vertical's API, with what it reports written
 * to the demo's event log.
 *
 * Browser-only — Lit elements do not render during VitePress's server build — so
 * `ElementDemo.vue` imports this from `onMounted`. The elements resolve to their source
 * (the alias in config.mts), because the docs deploy builds no workspace package first.
 */
import '@substrat-run/elements/themes/base.css';
import '@substrat-run/elements/themes/ledger.css';
import '@substrat-run/elements/themes/atelier.css';
import '@substrat-run/elements/themes/native.css';
import '@substrat-run/elements/kanban';
import '@substrat-run/elements/entity-table';
import '@substrat-run/elements/avatar';
import '@substrat-run/elements/user-menu';
import '@substrat-run/elements/assistant';
import { AssistantModel, scriptedSource, type AssistantEvent } from '@substrat-run/elements/assistant-model';
import type { Column, RowAction, TableFilter, TableQuery, TableSource, TableView } from '@substrat-run/elements';
import type { Session } from '@substrat-run/elements/session';

export type DemoName = 'kanban' | 'entity-table' | 'avatar' | 'user-menu' | 'assistant';

/** Mount one demo into `host`; the returned function takes it down again. */
export function mountDemo(name: DemoName, host: HTMLElement, log: (line: string) => void): () => void {
  const el = DEMOS[name](host, log);
  return () => el.remove();
}

const DEMOS: Record<DemoName, (host: HTMLElement, log: (line: string) => void) => HTMLElement> = {
  kanban: kanbanDemo,
  'entity-table': tableDemo,
  avatar: avatarDemo,
  'user-menu': userMenuDemo,
  assistant: assistantDemo,
};

/** An event's detail as one log line, with the card or row objects reduced to their ids. */
const brief = (type: string, detail: unknown) =>
  `${type} ${JSON.stringify(detail, (key, value) => (['card', 'row'].includes(key) && value && typeof value === 'object' ? value.id : value))}`;

function listen(el: HTMLElement, types: string[], log: (line: string) => void) {
  for (const type of types) el.addEventListener(type, (e) => log(brief(type, (e as CustomEvent).detail)));
}

// ── <sub-kanban> ────────────────────────────────────────────────────────────────────────

type Ticket = { id: string; title: string; status: string; tag: 'bug' | 'feature' | 'chore' };

const TICKETS: Ticket[] = [
  ['Login page 500s on Safari', 'backlog', 'bug'],
  ['Rate limit the public API', 'backlog', 'chore'],
  ['Permission diff table', 'backlog', 'feature'],
  ['Invoice PDF missing VAT line', 'todo', 'bug'],
  ['Migrate cron to schedules', 'todo', 'chore'],
  ['Onboarding checklist copy', 'todo', 'feature'],
  ['Add CSV export to reports', 'doing', 'feature'],
  ['Typo on pricing page', 'doing', 'bug'],
  ['Booking reminder sent twice', 'review', 'bug'],
  ['Search ignores diacritics', 'review', 'chore'],
  ['Dark mode contrast on badges', 'done', 'feature'],
  ['Attachment upload stalls at 99%', 'done', 'bug'],
].map(([title, status, tag], i) => ({ id: `T-${101 + i}`, title: title!, status: status!, tag: tag as Ticket['tag'] }));

/** The lifecycle the board enforces: nothing skips review, and done is final. */
const NEXT: Record<string, string[]> = {
  backlog: ['todo'],
  todo: ['backlog', 'doing'],
  doing: ['todo', 'review'],
  review: ['doing', 'done'],
  done: [],
};

const TAG_TONE = { bug: 'danger', feature: 'brand', chore: 'neutral' } as const;

function kanbanDemo(host: HTMLElement, log: (line: string) => void) {
  const wrap = document.createElement('div');
  wrap.className = 'demo-stack';
  const fail = document.createElement('wa-checkbox');
  fail.className = 'demo-option';
  fail.setAttribute('size', 'small');
  fail.textContent = 'Saving fails (the card goes back)';
  const failing = fail as HTMLElement & { checked: boolean };
  const board = document.createElement('sub-kanban');
  board.label = 'Tickets';
  board.addable = true;
  board.style.height = '30rem';
  board.style.setProperty('--sub-kanban-column-width', '15rem');
  board.columns = [
    { key: 'backlog', label: 'Backlog' },
    { key: 'todo', label: 'To do' },
    { key: 'doing', label: 'In progress', limit: 3 },
    { key: 'review', label: 'Review', limit: 2, strict: true },
    { key: 'done', label: 'Done' },
  ];
  board.canDrop = (_card, from, to) => NEXT[from]!.includes(to);
  // Drawn with `mount`, into a light-DOM element — the path a React or Vue app takes.
  board.mount = (el, t: Ticket) => {
    el.style.cssText = 'display: grid; gap: var(--wa-space-2xs)';
    const id = Object.assign(document.createElement('span'), { textContent: t.id });
    id.style.cssText = 'color: var(--wa-color-text-quiet); font-size: var(--wa-font-size-xs)';
    const title = Object.assign(document.createElement('span'), { textContent: t.title });
    const tag = Object.assign(document.createElement('wa-badge'), { textContent: t.tag });
    tag.setAttribute('variant', TAG_TONE[t.tag]);
    tag.setAttribute('pill', '');
    tag.style.justifySelf = 'start';
    el.append(id, title, tag);
  };
  board.move = () => new Promise((resolve, reject) => setTimeout(() => (failing.checked ? reject(new Error('Saving failed')) : resolve(undefined)), 600));
  board.cards = TICKETS;
  // The board reports a title; the screen makes the card (here, in memory) and hands it back.
  let next = 101 + TICKETS.length;
  board.addEventListener('sub-card-add', (e) => {
    const { column, title } = (e as CustomEvent<{ column: string; title: string }>).detail;
    board.cards = [...board.cards, { id: `T-${next++}`, title, status: column, tag: 'feature' }];
  });
  listen(board, ['sub-card-move', 'sub-move-failed', 'sub-card-open', 'sub-card-add'], log);
  wrap.append(fail, board);
  host.append(wrap);
  return wrap;
}

// ── <sub-entity-table> ──────────────────────────────────────────────────────────────────

type Row = { id: string; title: string; status: 'open' | 'pending' | 'closed'; owner: string; amount: string; updated: string };

const OWNERS = ['Ada', 'Grace', 'Linus', 'Margaret', 'Ken'];
const STATUSES: Row['status'][] = ['open', 'pending', 'closed'];
const NOW = Date.now();
let rows: Row[] = Array.from({ length: 47 }, (_, i) => ({
  id: `INV-${String(1001 + i)}`,
  title: TICKETS[i % TICKETS.length]!.title,
  status: STATUSES[(i * 7) % 3]!,
  owner: OWNERS[(i * 3) % OWNERS.length]!,
  amount: `${(((i * 7919) % 90000) / 100 + 25).toFixed(2)}`,
  updated: new Date(NOW - i * 5.3 * 3600_000).toISOString(),
}));

type Sort = 'title' | 'amount' | 'updated';

/** A paged read over the rows above, shaped like a generated client's: sort, filters, a cursor. */
function readRows(query: TableQuery<Sort>, offset = 0) {
  let found = rows.filter((r) => (query.view === 'closed' ? r.status === 'closed' : r.status !== 'closed'));
  for (const [key, value] of Object.entries(query.filters)) found = found.filter((r) => String(r[key as keyof Row]) === value);
  if (query.sort) {
    const by = query.sort;
    const dir = query.order === 'desc' ? -1 : 1;
    found = [...found].sort((a, b) => (by === 'amount' ? Number(a.amount) - Number(b.amount) : a[by].localeCompare(b[by])) * dir);
  }
  const limit = query.limit ?? 10;
  return {
    entries: found.slice(offset, offset + limit),
    next: offset + limit < found.length ? JSON.stringify({ query, offset: offset + limit }) : null,
    total: found.length,
  };
}

const ROWS: TableSource<Row, Sort> = {
  read: async (query) => readRows(query),
  follow: async (next) => {
    const { query, offset } = JSON.parse(next) as { query: TableQuery<Sort>; offset: number };
    return readRows(query, offset);
  },
  search: async (q) => ({ results: rows.filter((r) => `${r.id} ${r.title}`.toLowerCase().includes(q.toLowerCase())), capped: false }),
};

const COLUMNS: Column<Row, Sort>[] = [
  { key: 'id', label: 'Invoice', kind: 'code' },
  { key: 'title', label: 'Title', sort: 'title' },
  { key: 'status', label: 'Status', kind: 'badge', tones: { open: 'brand', pending: 'warning', closed: 'neutral' } },
  { key: 'owner', label: 'Owner', priority: 2 },
  { key: 'amount', label: 'Amount', kind: 'money', sort: 'amount' },
  { key: 'updated', label: 'Updated', kind: 'relative', sort: 'updated', priority: 3 },
];

const VIEWS: TableView[] = [
  { id: 'active', label: 'Active' },
  { id: 'closed', label: 'Closed' },
];

const FILTERS: TableFilter[] = [
  { key: 'owner', label: 'Owner', options: OWNERS.map((o) => ({ value: o, label: o })) },
  { key: 'status', label: 'Status', options: STATUSES.map((s) => ({ value: s, label: s })) },
];

const ACTIONS: RowAction<Row>[] = [
  {
    id: 'close',
    label: 'Close',
    views: ['active'],
    bulk: true,
    run: async (row) => {
      rows = rows.map((r) => (r.id === row.id ? { ...r, status: 'closed' } : r));
    },
  },
  {
    id: 'reopen',
    label: 'Reopen',
    views: ['closed'],
    bulk: true,
    run: async (row) => {
      rows = rows.map((r) => (r.id === row.id ? { ...r, status: 'open' } : r));
    },
  },
];

function tableDemo(host: HTMLElement, log: (line: string) => void) {
  const table = document.createElement('sub-entity-table') as HTMLElementTagNameMap['sub-entity-table'];
  table.label = 'Invoices';
  table.selectable = true;
  table.columnPicker = true;
  Object.assign(table, { columns: COLUMNS, views: VIEWS, filters: FILTERS, actions: ACTIONS, pageSizes: [5, 10, 25] });
  table.query = { view: 'active', sort: null, order: 'asc', filters: {}, q: '', limit: 10 };
  table.source = ROWS as never;
  listen(table, ['sub-query-change', 'sub-action-done', 'sub-selection-change'], log);
  host.append(table);
  return table;
}

// ── <sub-avatar> and <sub-user-menu> ────────────────────────────────────────────────────

const PEOPLE: Session[] = [
  { principal: 'p-ada', display: 'Ada Lovelace', email: 'ada@example.com', team: 'Analytical Engines' },
  { principal: 'p-grace', display: 'Grace Hopper', email: 'grace@example.com' },
  { principal: 'p-linus', display: 'Linus Torvalds', email: 'linus@example.com' },
  { principal: 'p-margaret', display: 'Margaret Hamilton', email: 'margaret@example.com' },
];

function avatarDemo(host: HTMLElement) {
  const row = document.createElement('div');
  row.className = 'demo-row';
  for (const [i, person] of PEOPLE.entries()) {
    const avatar = document.createElement('sub-avatar');
    avatar.session = person;
    avatar.show = (['avatar', 'name', 'email', 'name'] as const)[i]!;
    avatar.size = ['2rem', '2rem', '2rem', '2.75rem'][i]!;
    row.append(avatar);
  }
  host.append(row);
  return row;
}

function userMenuDemo(host: HTMLElement, log: (line: string) => void) {
  const row = document.createElement('div');
  row.className = 'demo-row demo-header';
  row.innerHTML = '<strong>Acme Support</strong>';
  const menu = document.createElement('sub-user-menu');
  menu.setAttribute('session-url', '');
  menu.show = 'name';
  menu.session = PEOPLE[0]!;
  menu.innerHTML = '<wa-dropdown-item value="settings">Settings</wa-dropdown-item><wa-dropdown-item value="billing">Billing</wa-dropdown-item>';
  // A docs page has no auth endpoints to go to, so the built-in items only report.
  for (const type of ['sub-sign-out', 'sub-switch-user']) {
    menu.addEventListener(type, (e) => {
      e.preventDefault();
      log(`${type} (cancelled here; in a vertical it goes to the auth endpoint)`);
    });
  }
  menu.addEventListener('wa-select', (e) => log(`wa-select ${(e as CustomEvent<{ item: { value: string } }>).detail.item.value}`));
  row.append(menu);
  host.append(row);
  return row;
}

// ── <sub-assistant> ─────────────────────────────────────────────────────────────────────

/** A scripted answer, streamed in small pieces so it reads the way a model's does. */
function answer(text: string): AssistantEvent[] {
  const words = text.split(/(?<= )/);
  return [
    { t: 'text-start', pid: 'a' },
    ...words.map((delta) => ({ t: 'text-delta' as const, pid: 'a', delta })),
    { t: 'text-end', pid: 'a' },
    { t: 'turn-finish', reason: 'done' },
  ];
}

function assistantDemo(host: HTMLElement) {
  const el = document.createElement('sub-assistant');
  el.style.height = '24rem';
  el.style.display = 'block';
  el.model = new AssistantModel({
    source: scriptedSource(
      ({ text }) =>
        answer(
          /kanban|board/i.test(text)
            ? 'The board is `<sub-kanban>`: give it `columns` and `cards`, and `canDrop` for which states a card may move to.'
            : `This demo answers from a script rather than a model. You asked: "${text}". In a vertical the source is the engine-assistant's stream.`,
        ),
      { delayMs: 25 },
    ),
  });
  host.append(el);
  return el;
}
