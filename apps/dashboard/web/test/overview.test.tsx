import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type AccountIntegration, type AppHealthRow, type AppRow, type AuditEntry } from '../src/lib/api';
import { fleetRows } from '../src/lib/fleet-rows';
import { actionWords, attentionRows, errorWords, filterApps, integrationRows, statusSentence } from '../src/lib/overview-status';
import { Overview } from '../src/views/Overview';

const app = (id: string, status: AppRow['status'] = 'active') =>
  ({ id, app_scope_id: id, name: `App ${id}`, vertical_slug: 'todo', status, hostname: null, created_by: 'a@acme.com', created_at: new Date().toISOString() }) as AppRow;
const health = (scopeId: string, state: AppHealthRow['state'], reason = `${state} reason.`) =>
  ({ scopeId, name: `App ${scopeId}`, vertical: 'todo', state, reason, failures: 0, sweepFailures: 0, stale: 0, lastSweepAt: null }) as AppHealthRow;
const provider = (name: string, status: 'active' | 'error' | 'expired' | 'revoked', lastError: string | null = null): AccountIntegration => ({
  provider: name.toLowerCase(),
  name,
  description: '',
  monogram: name.slice(0, 2),
  fields: [],
  connectFlow: null,
  connections: [
    {
      id: `c-${name}`,
      label: 'Production',
      status,
      externalAccountRef: null,
      expiresAt: null,
      lastOkAt: null,
      lastError,
      lastErrorAt: null,
      createdAt: new Date().toISOString(),
      vertical: 'todo',
      apps: [{ scopeId: 'a', name: 'App a' }],
      sweepRuns: [],
    },
  ],
  connectTargets: [],
});
const rows = (apps: AppRow[], h: AppHealthRow[] | null) => fleetRows({ apps, health: h, metrics: null });

describe('statusSentence (#1815)', () => {
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const sentences = (s: string) => s.split(/(?<=[.!?])\s+/).filter(Boolean).length;
  const ands = (s: string) => (s.match(/\band\b/g) ?? []).length;

  it('says every app is working only when every verdict is OK', () => {
    const s = statusSentence({ apps: rows([app('a'), app('b')], [health('a', 'ok'), health('b', 'ok')]), healthRead: 'ok', integrations: [provider('Scrive', 'active')] });
    expect(s.headline).toBe('All 2 apps are working.');
    expect(s.detail).toBe('Nothing is failing, overdue or unchecked. The one integration is connected.');
  });

  it('names the one app that needs attention, on the app’s side', () => {
    const s = statusSentence({ apps: rows([app('a'), app('b')], [health('a', 'failing', '3 operation failures recorded.'), health('b', 'ok')]), healthRead: 'ok', integrations: [] });
    expect(s.headline).toBe('Mostly working. App a is failing on the app’s side.');
    expect(s.detail).toBe('App a is failing on the app’s side: 3 operation failures recorded.');
  });

  it('puts an integration in error on its own side, naming it once', () => {
    const s = statusSentence({ apps: rows([app('a')], [health('a', 'ok')]), healthRead: 'ok', integrations: [provider('Fortnox', 'error', 'HTTP 503 from Fortnox: service temporarily unavailable')] });
    expect(s.headline).toBe('Your apps are working, but Fortnox is erroring on its side.');
    expect(s.detail).toBe('HTTP 503, service temporarily unavailable, on Fortnox’s side.');
  });

  it('counts apps when more than one needs attention, keeps one "and", and points at the list', () => {
    const s = statusSentence({
      apps: rows([app('a'), app('b'), app('c'), app('ok'), app('new', 'provisioning')], [health('a', 'failing'), health('b', 'stale'), health('c', 'silent'), health('ok', 'ok')]),
      healthRead: 'ok',
      integrations: [provider('Fortnox', 'error', 'HTTP 503')],
    });
    expect(s.headline).toBe('Mostly working. 3 apps need attention, and Fortnox is erroring on its side.');
    expect(words(s.headline)).toBeLessThanOrEqual(14);
    expect(ands(s.headline)).toBeLessThanOrEqual(1);
    expect(sentences(s.detail)).toBeLessThanOrEqual(2);
    expect(s.detail).toBe('App a is failing on the app’s side: failing reason. 3 more below.');
  });

  it('leaves an installing app out of the sentence', () => {
    const s = statusSentence({ apps: rows([app('a'), app('b'), app('new', 'provisioning')], [health('a', 'failing'), health('b', 'ok')]), healthRead: 'ok', integrations: [] });
    expect(s.headline).toBe('Mostly working. App a is failing on the app’s side.');
    expect(`${s.headline} ${s.detail}`).not.toMatch(/App new|install/);
    const allOk = statusSentence({ apps: rows([app('b'), app('new', 'provisioning')], [health('b', 'ok')]), healthRead: 'ok', integrations: [] });
    expect(allOk.headline).toBe('All 1 app is working.');
    expect(allOk.detail).not.toMatch(/App new|install/);
  });

  it('never claims all-clear when a read failed', () => {
    const noHealth = statusSentence({ apps: rows([app('a')], null), healthRead: 'failed', integrations: [] });
    expect(noHealth.headline).toBe('App health could not be read.');
    expect(noHealth.headline).not.toMatch(/working/);
    const noIntegrations = statusSentence({ apps: rows([app('a')], [health('a', 'ok')]), healthRead: 'ok', integrations: 'failed' });
    expect(noIntegrations.headline).toBe('All 1 app is working; integrations could not be read.');
    expect(sentences(noIntegrations.detail)).toBeLessThanOrEqual(2);
  });
});

describe('attentionRows (#1815)', () => {
  it('lists every app not OK and every connection in trouble, worst first, each with where it leads', () => {
    const r = attentionRows({
      apps: rows([app('ok'), app('stale'), app('silent'), app('failing'), app('boom', 'failed'), app('new', 'provisioning'), app('dunno')], [health('ok', 'ok'), health('stale', 'stale'), health('silent', 'silent'), health('failing', 'failing')]),
      integrations: [provider('Fortnox', 'error', 'HTTP 503'), provider('Scrive', 'active'), provider('Planima', 'expired'), provider('Old', 'revoked')],
    });
    expect(r.map((x) => [x.badge, x.what])).toEqual([
      ['install failed', 'App boom'],
      ['failing', 'App failing'],
      ['error', 'Fortnox'],
      ['stale', 'App stale'],
      ['expired', 'Planima'],
      ['silent', 'App silent'],
      ['unknown', 'App dunno'],
    ]);
    const href = (what: string) => r.find((x) => x.what === what)!.href;
    expect(href('App failing')).toBe('/apps/failing/overview');
    expect(href('App boom')).toBe('/apps/boom/overview');
    expect(href('App stale')).toBe('/observability?app=stale&view=schedules');
    expect(href('App silent')).toBe('/observability?app=silent&view=schedules');
    expect(href('Fortnox')).toBe('/integrations');
    expect(r.find((x) => x.what === 'Fortnox')!.text).toBe('HTTP 503, on Fortnox’s side.');
  });

  it('is empty when nothing needs anyone', () => {
    expect(attentionRows({ apps: rows([app('a'), app('n', 'provisioning')], [health('a', 'ok')]), integrations: [provider('Scrive', 'active')] })).toEqual([]);
  });
});

describe('the smaller derivations', () => {
  it('filters apps by name and by status', () => {
    const r = rows([app('a'), app('b'), app('c', 'provisioning')], [health('a', 'ok'), health('b', 'failing')]);
    expect(filterApps(r, '', 'working').map((x) => x.scopeId)).toEqual(['a']);
    expect(filterApps(r, '', 'attention').map((x) => x.scopeId)).toEqual(['b']);
    expect(filterApps(r, 'APP C', 'all').map((x) => x.scopeId)).toEqual(['c']);
  });

  it('reads integration state from the connection record only, worst first', () => {
    const r = integrationRows([provider('Scrive', 'active'), provider('Fortnox', 'error', 'HTTP 503')]);
    expect(r.map((x) => [x.name, x.state, x.text])).toEqual([
      ['Fortnox', 'Error', 'HTTP 503, on Fortnox’s side'],
      ['Scrive', 'Connected', 'not used yet'],
    ]);
  });

  it('takes the provider’s own name out of its error', () => {
    expect(errorWords('Fortnox', 'HTTP 503 from Fortnox: service temporarily unavailable')).toBe('HTTP 503, service temporarily unavailable');
    expect(errorWords('Scrive', 'Scrive: invalid credentials.')).toBe('invalid credentials');
    expect(errorWords('Fortnox', 'timeout')).toBe('timeout');
  });

  it('turns an audit action into words', () => {
    expect([actionWords('bindScopeVersion'), actionWords('assignRole'), actionWords('provisionScope'), actionWords('setHostnameStatus')]).toEqual([
      'bound scope version',
      'assigned role',
      'provisioned scope',
      'set hostname status',
    ]);
  });
});

describe('Overview page', () => {
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

  const entry = (id: string, action: string): AuditEntry => ({ id, actor: 'dana@acme.com', action, tenantId: null, scopeId: 'a', vertical: null, before: null, after: null, causedBy: null, at: new Date().toISOString() });
  const render = () =>
    act(async () => root.render(<Overview apps={[app('a'), app('b')]} teamName="Acme" onCreate={() => {}} onOpen={() => {}} onRetry={() => {}} />));
  const section = (label: string) => container.querySelector(`[aria-label="${label}"]`)!.textContent!;
  const cards = () => [...container.querySelectorAll('a[href*="/observability?app="]')].filter((a) => a.textContent === 'Observe →').map((a) => a.getAttribute('href'));

  it('keeps every section standing when one read fails', async () => {
    vi.spyOn(api, 'fleetHealth').mockResolvedValue({ rows: [health('a', 'failing'), health('b', 'ok')] });
    vi.spyOn(api, 'integrations').mockRejectedValue(new Error('down'));
    vi.spyOn(api, 'auditLogAll').mockResolvedValue({ entries: [entry('1', 'assignRole')], nextCursor: null });
    await render();
    expect(section('Integrations')).toContain('Integrations could not be read.');
    expect(section('Recent activity')).toContain('dana@acme.com assigned role on App a');
    expect(section('Needs attention')).toContain('App a');
    expect(section('Needs attention')).toContain('connection problems are not listed here');
    expect(container.querySelector('[role="status"]')!.textContent).toContain('Integrations could not be read.');
    expect(cards()).toHaveLength(2);
  });

  it('says nothing needs attention, rather than hiding the section', async () => {
    vi.spyOn(api, 'fleetHealth').mockResolvedValue({ rows: [health('a', 'ok'), health('b', 'ok')] });
    vi.spyOn(api, 'integrations').mockResolvedValue({ providers: [] });
    vi.spyOn(api, 'auditLogAll').mockRejectedValue(new Error('down'));
    await render();
    expect(section('Needs attention')).toContain('Nothing needs attention.');
    expect(section('Recent activity')).toContain('The audit log could not be read.');
    expect(container.querySelector('[role="status"]')!.textContent).toContain('All 2 apps are working.');
  });

  it('filters the cards by status', async () => {
    vi.spyOn(api, 'fleetHealth').mockResolvedValue({ rows: [health('a', 'failing'), health('b', 'ok')] });
    vi.spyOn(api, 'integrations').mockResolvedValue({ providers: [] });
    vi.spyOn(api, 'auditLogAll').mockResolvedValue({ entries: [], nextCursor: null });
    await render();
    const select = container.querySelector('select[aria-label="Status"]') as HTMLSelectElement;
    await act(async () => {
      select.value = 'working';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(cards()).toEqual(['/observability?app=b']);
    await act(async () => {
      select.value = 'attention';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(cards()).toEqual(['/observability?app=a']);
  });
});
