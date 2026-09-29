import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type AppRow, type AuditEntry } from '../src/lib/api';
import { filterActivity, mergeActivity, refusalActorOf, refusalSentence, type Refusal } from '../src/lib/audit-activity';
import { AuditLog } from '../src/views/Audit';

/** #1828: refused permission checks beside the audited actions, with the Outcome filter. */

const T = (m: number) => new Date(Date.parse('2026-09-29T12:00:00.000Z') - m * 60_000).toISOString();
const action = (id: string, minutesAgo: number, over: Partial<AuditEntry> = {}): AuditEntry => ({
  id, actor: 'dana@acme.com', action: 'assignRole', tenantId: null, scopeId: 'a', vertical: null, before: null, after: null, causedBy: null, at: T(minutesAgo), ...over,
});
const refusal = (id: string, minutesAgo: number, over: Partial<Refusal> = {}): Refusal => ({
  id, actor: 'sara@acme.test', permission: 'refunds:issue', operation: 'shop/refund-order', invocationId: null, impersonation: null, at: T(minutesAgo), ...over,
});

describe('mergeActivity', () => {
  it('interleaves the two logs newest first', () => {
    const m = mergeActivity({ entries: [action('A1', 1), action('A2', 30)], more: false }, { entries: [refusal('R1', 10)], more: false });
    expect(m.items.map((i) => i.id)).toEqual(['A1', 'R1', 'A2']);
    expect(m.older).toBeNull();
  });

  it('stops at the newest point where a log has more to give, and names that log as the one to read', () => {
    // Refusals read down to 10 minutes ago and have more; the actions reach back an hour.
    // An action at 30 minutes could have a refusal at 20 that is not read yet — so it waits.
    const m = mergeActivity({ entries: [action('A1', 1), action('A2', 30), action('A3', 60)], more: false }, { entries: [refusal('R1', 5), refusal('R2', 10)], more: true });
    expect(m.items.map((i) => i.id)).toEqual(['A1', 'R1', 'R2']);
    expect(m.older).toBe('refusals');
    expect(m.floor).toBe(T(10));
  });

  it('with All apps reads no refusals, and is just the actions', () => {
    const m = mergeActivity({ entries: [action('A1', 1)], more: true }, null);
    expect(m.items.map((i) => i.id)).toEqual(['A1']);
    expect(m.older).toBe('actions');
  });
});

describe('filterActivity', () => {
  const items = mergeActivity({ entries: [action('A1', 1)], more: false }, { entries: [refusal('R1', 2), refusal('R2', 3, { actor: { system: 'invoicing' }, permission: 'orders:write', operation: 'shop/mark-invoiced' })], more: false }).items;
  const f = (over: Partial<Parameters<typeof filterActivity>[1]>) =>
    filterActivity(items, { outcome: 'all', kind: 'all', text: '', appName: () => 'Acme HR', ...over }).map((i) => i.id);

  it('filters by outcome', () => {
    expect(f({ outcome: 'allowed' })).toEqual(['A1']);
    expect(f({ outcome: 'refused' })).toEqual(['R1', 'R2']);
  });

  it('applies the kind and text filters to refusals as to actions', () => {
    expect(f({ kind: 'job' })).toEqual(['R2']);
    expect(f({ text: 'refunds' })).toEqual(['R1']);
    expect(f({ text: 'refused' })).toEqual(['R1', 'R2']);
  });
});

describe('refusal wording', () => {
  it('names each kind of actor in the page’s own words, a principal the way an action’s actor is', () => {
    expect(refusalActorOf('sara@acme.test')).toMatchObject({ kind: 'person', name: 'sara@acme.test' });
    expect(refusalActorOf({ system: 'invoicing' })).toMatchObject({ kind: 'job', name: 'invoicing (a consumer)' });
    expect(refusalActorOf({ connection: 'c1' })).toMatchObject({ kind: 'job', name: 'A connector' });
    expect(refusalActorOf({ vertical: 'acme/crm', scope: 's' })).toMatchObject({ kind: 'job', name: 'The acme/crm app' });
    expect(refusalActorOf(null)).toMatchObject({ kind: 'unknown' });
    // The kernel's marker for an actor it could not decode is not a consumer.
    expect(refusalActorOf({ system: 'undecodable' })).toMatchObject({ kind: 'unknown', name: 'An actor that could not be read' });
    expect(refusalSentence({ permission: 'refunds:issue', operation: 'shop/refund-order' })).toBe('was refused refunds:issue on shop/refund-order');
  });
});

describe('Audit page with refusals', () => {
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
  const render = (scopeId: string | null) => act(async () => root.render(<AuditLog apps={apps} appsComplete scopeId={scopeId} onScope={() => {}} />));
  const press = (label: string) =>
    act(async () =>
      [...container.querySelectorAll('[aria-label="Outcome"] button')].find((b) => b.textContent === label)!.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

  it('shows an app’s refusals among its actions, and filters them by outcome', async () => {
    vi.spyOn(api, 'auditLogAll').mockResolvedValue({ entries: [action('A1', 1)], nextCursor: null });
    const denials = vi.spyOn(api, 'appDenials').mockResolvedValue({ entries: [refusal('R1', 5, { invocationId: '01J8Z000000000000000000401' })], limit: 100 });
    await render('a');
    expect(denials).toHaveBeenCalledWith('a', { until: undefined, limit: 100 });
    expect(container.querySelector('[data-refusal-id="R1"]')!.textContent).toContain('sara@acme.test was refused refunds:issue on shop/refund-order');
    expect(container.querySelector('[data-refusal-id="R1"] a')!.getAttribute('href')).toContain('req=01J8Z000000000000000000401');
    await press('Refused');
    expect(container.querySelector('[data-entry-id]')).toBeNull();
    expect(container.querySelector('[data-refusal-id="R1"]')).not.toBeNull();
    await press('Allowed');
    expect(container.querySelector('[data-refusal-id]')).toBeNull();
  });

  it('waits for the first page of refusals before drawing, so nothing is slotted in afterwards', async () => {
    vi.spyOn(api, 'auditLogAll').mockResolvedValue({ entries: [action('A1', 30)], nextCursor: null });
    let answer!: (v: { entries: Refusal[]; limit: number }) => void;
    vi.spyOn(api, 'appDenials').mockReturnValue(new Promise((r) => (answer = r)));
    await render('a');
    expect(container.querySelector('[data-entry-id="A1"]')).toBeNull();
    expect(container.textContent).toContain('Loading audit log');
    await act(async () => answer({ entries: [refusal('R1', 5)], limit: 100 }));
    const order = [...container.querySelectorAll('[data-entry-id], [data-refusal-id]')].map((el) => el.getAttribute('data-entry-id') ?? el.getAttribute('data-refusal-id'));
    expect(order).toEqual(['R1', 'A1']);
  });

  it('with All apps reads no refusals, and Refused asks for an app', async () => {
    vi.spyOn(api, 'auditLogAll').mockResolvedValue({ entries: [action('A1', 1)], nextCursor: null });
    const denials = vi.spyOn(api, 'appDenials');
    await render(null);
    expect(denials).not.toHaveBeenCalled();
    await press('Refused');
    expect(container.textContent).toContain('Pick an app to see refusals.');
  });

  it('keeps the actions and says so when the refusals cannot be read', async () => {
    vi.spyOn(api, 'auditLogAll').mockResolvedValue({ entries: [action('A1', 1)], nextCursor: null });
    vi.spyOn(api, 'appDenials').mockRejectedValue(new Error('boom'));
    await render('a');
    expect(container.querySelector('[data-entry-id="A1"]')).not.toBeNull();
    expect(container.textContent).toContain('refused checks could not be read');
  });
});
