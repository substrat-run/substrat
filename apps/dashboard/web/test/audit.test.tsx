import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type AppRow, type AuditEntry } from '../src/lib/api';
import { adminAction } from '@substrat-run/contracts';
import { actionKeyWords, actionWords, actorOf, entryDiff, filterEntries, groupByDay } from '../src/lib/audit-activity';
import { actionWords as overviewActionWords, activityRows } from '../src/lib/overview-status';
import { AuditLog, DEEP_LINK_PAGES } from '../src/views/Audit';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();
const entry = (id: string, over: Partial<AuditEntry> = {}): AuditEntry => ({
  id,
  actor: 'dana@acme.com',
  action: 'assignRole',
  tenantId: null,
  scopeId: 'a',
  vertical: null,
  before: null,
  after: null,
  causedBy: null,
  at: new Date().toISOString(),
  ...over,
});
const appName = (s: string) => (s === 'a' ? 'Acme HR' : null);

describe('audit activity derivations (#1825)', () => {
  it('groups consecutive entries by local day, with Today and Yesterday named', () => {
    const now = new Date(2026, 8, 26, 15).getTime();
    const days = groupByDay([entry('1', { at: at(2026, 9, 26, 14) }), entry('2', { at: at(2026, 9, 26, 9) }), entry('3', { at: at(2026, 9, 25) }), entry('4', { at: at(2026, 9, 24) }), entry('5', { at: at(2025, 12, 31) })], now);
    expect(days.map((d) => [d.label, d.items.map((e) => e.id)])).toEqual([
      ['Today · Sat 26 Sep', ['1', '2']],
      ['Yesterday · Fri 25 Sep', ['3']],
      ['Thu 24 Sep', ['4']],
      ['Wed 31 Dec 2025', ['5']],
    ]);
  });

  it('files an actor as a person, a job, or neither', () => {
    expect(actorOf('dana@acme.com')).toMatchObject({ kind: 'person', name: 'dana@acme.com', initials: 'DA' });
    expect(actorOf('alex.ek@acme.com').initials).toBe('AE');
    expect(actorOf('service:control-plane')).toMatchObject({ kind: 'job', name: 'Substrat' });
    expect(actorOf('01JZ00000000000000000000SW')).toMatchObject({ kind: 'job', name: 'Scheduled sweep' });
    expect(actorOf('01JZ000000000000000000DASH')).toMatchObject({ kind: 'job', name: 'Dashboard' });
    // Any other id could be staff or a one-off provisioning id; it is filed under neither.
    expect(actorOf('01J2Q8Z3V9K4W7X2M5N6P7STF1')).toMatchObject({ kind: 'unknown', name: 'Actor 01J2…STF1' });
  });

  it('filters by kind and by text over actor, sentence and app', () => {
    const list = [entry('p'), entry('j', { actor: 'service:control-plane', action: 'bindScopeVersion' }), entry('u', { actor: '01J2Q8Z3V9K4W7X2M5N6P7STF1', scopeId: null })];
    expect(filterEntries(list, { kind: 'person', text: '', appName }).map((e) => e.id)).toEqual(['p']);
    expect(filterEntries(list, { kind: 'job', text: '', appName }).map((e) => e.id)).toEqual(['j']);
    expect(filterEntries(list, { kind: 'all', text: '', appName }).map((e) => e.id)).toEqual(['p', 'j', 'u']);
    expect(filterEntries(list, { kind: 'all', text: 'bound scope', appName }).map((e) => e.id)).toEqual(['j']);
    expect(filterEntries(list, { kind: 'all', text: 'acme hr', appName }).map((e) => e.id)).toEqual(['p', 'j']);
    expect(filterEntries(list, { kind: 'all', text: 'DANA', appName }).map((e) => e.id)).toEqual(['p']);
  });

  it('diffs the changed keys, and never reads an unrecorded side as a value', () => {
    expect(entryDiff({ role: 'agent', team: 'x' }, { role: 'lead', team: 'x' })).toEqual([{ key: 'role', before: 'agent', after: 'lead' }]);
    expect(entryDiff(null, { key: 'builder' })).toEqual([{ key: 'key', before: null, after: 'builder' }]);
    expect(entryDiff({ ids: [1] }, { ids: [1, 2] })).toEqual([{ key: 'ids', before: '[1]', after: '[1,2]' }]);
    expect(entryDiff(null, null)).toEqual([]);
    expect(entryDiff('a', 'b')).toEqual([{ key: 'value', before: 'a', after: 'b' }]);
  });

  it('shows a change of type, quoting the string, and skips a value that did not change', () => {
    expect(entryDiff({ n: '1' }, { n: 1 })).toEqual([{ key: 'n', before: '"1"', after: '1' }]);
    expect(entryDiff({ on: 'true' }, { on: true })).toEqual([{ key: 'on', before: '"true"', after: 'true' }]);
    expect(entryDiff({ n: 1, s: 'x' }, { n: 1, s: 'x' })).toEqual([]);
    expect(entryDiff('1', 1)).toEqual([{ key: 'value', before: '"1"', after: '1' }]);
  });

  it('puts every admin action into the past tense', () => {
    const same = new Set(['set', 'reset', 'put']);
    for (const v of adminAction.options) {
      const words = actionKeyWords(v);
      const out = actionWords(v);
      expect(out, v).not.toMatch(/^admin action:/);
      // No suffix stacked on a past tense ("endeded", "createded").
      expect(out, v).not.toMatch(/eded\b|eed\b/);
      if (!same.has(words[0]!)) expect(out.split(' ')[0], v).not.toBe(words[0]);
      expect(out.split(' ').slice(1), v).toEqual(words.slice(1));
    }
    expect([actionWords('admitVersion'), actionWords('shredSubject'), actionWords('beginImpersonation')]).toEqual(['admitted version', 'shredded subject', 'began impersonation']);
  });

  it('leaves an action it does not know untensed, and labelled', () => {
    expect(actionWords('frobnicateScope')).toBe('admin action: frobnicate scope');
  });

  it('is the same wording the Overview uses, and the Overview links to the entry', () => {
    expect(overviewActionWords).toBe(actionWords);
    const [row] = activityRows([entry('01X', { actor: 'service:control-plane' })], appName);
    expect(row).toMatchObject({ who: 'Substrat', text: 'assigned role on Acme HR', href: '/audit?app=a&entry=01X' });
    expect(activityRows([entry('01Y', { scopeId: null })], appName)[0]!.href).toBe('/audit?entry=01Y');
  });
});

describe('Audit page', () => {
  let container: HTMLDivElement, root: Root;
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

  const apps = [{ app_scope_id: 'a', name: 'Acme HR' } as AppRow];
  const render = (entryId: string | null = null) =>
    act(async () => root.render(<AuditLog apps={apps} appsComplete scopeId={null} entryId={entryId} onScope={() => {}} />));
  const rows = () => [...container.querySelectorAll('[data-entry-id]')].map((r) => r.getAttribute('data-entry-id'));
  const expanded = () => [...container.querySelectorAll('[aria-expanded="true"]')].map((r) => r.closest('[data-entry-id]')!.getAttribute('data-entry-id'));
  const click = (el: Element) => act(async () => el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

  it('renders sentences with the actor, the app tag and a count, and filters by kind', async () => {
    vi.spyOn(api, 'auditLogAll').mockResolvedValue({ entries: [entry('1'), entry('2', { actor: 'service:control-plane', action: 'bindScopeVersion', scopeId: null })], nextCursor: null });
    await render();
    expect(container.textContent).toContain('dana@acme.com assigned role on Acme HR');
    expect(container.textContent).toContain('Substrat bound scope version');
    expect(container.textContent).toContain('Team');
    expect(container.querySelector('[data-testid="audit-count"]')!.textContent).toBe('2 of 2 entries');
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Jobs & integrations')!);
    expect(rows()).toEqual(['2']);
    expect(container.querySelector('[data-testid="audit-count"]')!.textContent).toBe('1 of 2 entries');
  });

  it('expands an entry in place with its words, the app it touched and the diff', async () => {
    vi.spyOn(api, 'auditLogAll').mockResolvedValue({ entries: [entry('1', { before: { role: 'agent' }, after: { role: 'lead' } })], nextCursor: null });
    await render();
    await click(container.querySelector('[role="button"]')!);
    expect(expanded()).toEqual(['1']);
    expect(container.textContent).toContain('Assigned role');
    expect(container.querySelector('[data-diff-key="role"]')!.textContent).toBe('roleagent → lead');
    expect(container.querySelector('a[href="/apps/a"]')!.textContent).toBe('Acme HR');
  });

  it('opens a deep-linked entry, reading older pages until it is found', async () => {
    const read = vi
      .spyOn(api, 'auditLogAll')
      .mockResolvedValueOnce({ entries: [entry('3'), entry('2')], nextCursor: 'c1' })
      .mockResolvedValueOnce({ entries: [entry('1', { after: { role: 'lead' } })], nextCursor: 'c2' });
    await render('1');
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]![0]).toEqual({ cursor: 'c1' });
    expect(rows()).toEqual(['3', '2', '1']);
    expect(expanded()).toEqual(['1']);
    expect(container.textContent).toContain('Load older entries');
  });

  it('stops after a bounded walk and says the entry was not found', async () => {
    const read = vi.spyOn(api, 'auditLogAll').mockImplementation(async (o) => ({ entries: [entry(`e-${o?.cursor ?? 0}`)], nextCursor: `${Number(o?.cursor ?? 0) + 1}` }));
    await render('nope');
    expect(read).toHaveBeenCalledTimes(DEEP_LINK_PAGES);
    expect(container.querySelector('[role="status"]')!.textContent).toContain(`not in the latest ${DEEP_LINK_PAGES} pages`);
    expect(expanded()).toEqual([]);
  });

  it('opens the entry when Load older brings it in after the walk, and says so when the log ends without it', async () => {
    const pages = 2 * DEEP_LINK_PAGES;
    vi.spyOn(api, 'auditLogAll').mockImplementation(async (o) => {
      const i = Number(o?.cursor ?? 0);
      return { entries: [entry(`e-${i}`)], nextCursor: i + 1 < pages ? `${i + 1}` : null };
    });
    const loadOlder = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Load older entries');
    const notice = () => container.querySelector('[role="status"]')?.textContent ?? null;

    await render(`e-${DEEP_LINK_PAGES + 1}`);
    expect(notice()).toContain('Load older entries keeps reading');
    await click(loadOlder()!);
    expect(expanded()).toEqual([]);
    expect(notice()).toContain(`latest ${DEEP_LINK_PAGES + 1} pages`);
    await click(loadOlder()!);
    expect(expanded()).toEqual([`e-${DEEP_LINK_PAGES + 1}`]);
    expect(notice()).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    await render('nope');
    while (loadOlder()) await click(loadOlder()!);
    expect(notice()).toContain('The linked entry is not in this log.');
    expect(notice()).not.toContain('Load older');
  });
});
