import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Findings } from '../src/views/Findings';
import { ApiError, createClient, type FindingEntry, type FindingRuleEntry } from '../src/lib/api.generated';
import { mockFindingsClient, type FindingsClient } from '../src/lib/mock-findings';
import {
  canSuppress,
  countByStatus,
  draftFor,
  draftReady,
  findingsError,
  inTab,
  mayManageFromRole,
  movesFrom,
  ruleInput,
  tabOf,
} from '../src/lib/findings';
import { OBS_SECTIONS, sectionOf, sectionQuery } from '../src/lib/obs-sections';
import { obsPath } from '../src/lib/router';
import { readObsQuery } from '../src/lib/observability-query';

/** #1748: the Findings inbox — its rules, and the view against the client the plane serves. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const finding = (over: Partial<FindingEntry>): FindingEntry => ({
  id: 'F',
  tenantId: 'T',
  kind: 'recurring',
  subject: 'tickets/create',
  status: 'open',
  regressed: false,
  severity: 'warning',
  title: 'conflict on tickets/create',
  operation: 'tickets/create',
  codes: ['conflict'],
  vertical: null,
  scopeId: null,
  count: 3,
  firstSeen: '2026-10-01T10:00:00.000Z',
  lastSeen: '2026-10-01T11:00:00.000Z',
  lastVersion: null,
  resolvedVersion: null,
  resolvedAt: null,
  resolution: null,
  acknowledgedAt: null,
  ruleId: null,
  evidence: { source: 'ops-failures', fingerprint: 'fp' },
  likelyCause: null,
  ...over,
});

describe('findings, pure', () => {
  it('reads a tab from the URL and falls back to Open', () => {
    expect(tabOf('acked')).toBe('acked');
    expect(tabOf('suppressed')).toBe('suppressed');
    expect(tabOf('bogus')).toBe('open');
    expect(tabOf(undefined)).toBe('open');
  });

  it('sorts a tab most recently seen first and counts every tab', () => {
    const a = finding({ id: 'a', lastSeen: '2026-10-01T10:00:00.000Z' });
    const b = finding({ id: 'b', lastSeen: '2026-10-01T12:00:00.000Z' });
    const c = finding({ id: 'c', status: 'resolved' });
    expect(inTab([a, b, c], 'open').map((e) => e.id)).toEqual(['b', 'a']);
    expect(countByStatus([a, b, c])).toEqual({ open: 2, acked: 0, resolved: 1, suppressed: 0 });
  });

  it('offers the moves the lifecycle allows, and none for a suppressed finding', () => {
    expect(movesFrom('open').map((m) => m.to)).toEqual(['acked', 'resolved']);
    expect(movesFrom('acked').map((m) => m.to)).toEqual(['resolved', 'open']);
    expect(movesFrom('resolved').map((m) => m.to)).toEqual(['open']);
    expect(movesFrom('suppressed')).toEqual([]);
    expect([canSuppress('open'), canSuppress('acked'), canSuppress('resolved'), canSuppress('suppressed')]).toEqual([true, true, false, false]);
  });

  it('builds the rule body from the set dimensions only, expiring at the chosen distance', () => {
    const d = { ...draftFor(finding({})), code: 'conflict', days: '7', reason: ' known retry storm ' };
    expect(draftReady(d)).toBe(true);
    expect(ruleInput(d, 'recurring', Date.parse('2026-10-01T00:00:00.000Z'))).toEqual({
      kind: 'recurring',
      operation: 'tickets/create',
      code: 'conflict',
      expiresAt: '2026-10-08T00:00:00.000Z',
      reason: 'known retry storm',
    });
  });

  it('refuses a rule that narrows nothing or has no reason', () => {
    const open = finding({ operation: null });
    expect(draftReady({ ...draftFor(open), reason: 'x' })).toBe(false); // would match everything
    expect(draftReady({ ...draftFor(finding({})), reason: '  ' })).toBe(false);
  });

  it('says what a 403 means for a read and for a change', () => {
    const forbidden = new ApiError(403, 'forbidden', null);
    expect(findingsError(forbidden, 'read')).toMatch(/do not have access/);
    expect(findingsError(forbidden, 'change')).toMatch(/read findings but not change/);
    expect(findingsError(new ApiError(500, 'boom', null), 'change')).toBe('boom (500)');
    expect(findingsError(new TypeError('x'), 'read')).toMatch(/could not be reached/);
  });

  it('hides actions for a viewer only, and draws them while the role is unknown', () => {
    expect(mayManageFromRole('viewer')).toBe(false);
    expect(mayManageFromRole('member')).toBe(true);
    expect(mayManageFromRole(undefined)).toBe(true);
  });

  it('is the fourth Observability child, addressed by ?view=findings&tab=', () => {
    expect(OBS_SECTIONS.map((s) => s.key)).toEqual(['pulse', 'processes', 'logs', 'findings']);
    expect(sectionOf('findings')).toBe('findings');
    expect(readObsQuery('?view=findings&tab=acked')).toMatchObject({ view: 'findings', tab: 'acked' });
    expect(obsPath({ view: 'findings', tab: 'resolved' })).toBe('/observability?view=findings&tab=resolved');
    expect(sectionQuery('?app=A&hours=72&tab=acked', 'findings')).toEqual({ app: 'A', view: 'findings', hours: '72' });
  });
});

describe('Findings view', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const settle = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  const click = async (el: Element | null | undefined) => {
    expect(el).toBeTruthy();
    await act(async () => {
      (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
  };
  const button = (label: string, within: ParentNode = host) =>
    [...within.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  const row = (id: string) => host.querySelector(`[data-finding="${id}"]`)!;

  function fake(entries: FindingEntry[], rules: FindingRuleEntry[] = []): FindingsClient & { calls: Record<string, unknown[]> } {
    const calls: Record<string, unknown[]> = { set: [], create: [], revoke: [] };
    return {
      calls,
      listFindings: async () => ({ available: true, entries }),
      listFindingRules: async () => ({ entries: rules }),
      setFindingStatus: async (input) => {
        calls.set!.push(input);
        return { ...entries.find((e) => e.id === input.id)!, status: input.status };
      },
      createFindingRule: async (input) => {
        calls.create!.push(input);
        return { rule: { id: 'R', tenantId: 'T', kind: input.kind ?? null, operation: input.operation ?? null, code: input.code ?? null, subject: input.subject ?? null, expiresAt: input.expiresAt, reason: input.reason, createdBy: 'me', createdAt: 'now' }, suppressed: 2 };
      },
      revokeFindingRule: async (input) => {
        calls.revoke!.push(input);
        return rules.find((r) => r.id === input.ruleId)!;
      },
    };
  }

  const mount = async (client: FindingsClient, tab: Parameters<typeof Findings>[0]['tab'] = 'open', canManage = true, onTab = vi.fn()) => {
    await act(async () => root.render(<Findings client={client} tab={tab} canManage={canManage} nonce={0} onTab={onTab} />));
    await settle();
    return onTab;
  };

  const entries = [
    finding({ id: 'o', title: 'open one', regressed: true, likelyCause: { kind: 'deploy', version: 'v9', reason: 'onset 41 s after rollout' } }),
    finding({ id: 'a', status: 'acked', title: 'acked one' }),
    finding({ id: 'r', status: 'resolved', title: 'resolved one' }),
    finding({ id: 's', status: 'suppressed', title: 'suppressed one', ruleId: 'R1' }),
  ];

  it('shows the tab’s findings with counts, regressed badge and likely cause', async () => {
    await mount(fake(entries));
    expect(host.textContent).toContain('open one');
    expect(host.textContent).not.toContain('acked one');
    expect(host.textContent).toContain('Regressed');
    expect(host.textContent).toContain('onset 41 s after rollout');
    const tabs = [...host.querySelectorAll('button')].map((b) => b.textContent);
    expect(tabs.some((t) => t?.startsWith('Open'))).toBe(true);
    expect(tabs.some((t) => t?.startsWith('Suppressed'))).toBe(true);
  });

  it('asks the parent to switch tab, and renders the one it is given', async () => {
    const onTab = await mount(fake(entries));
    await click([...host.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Acked')));
    expect(onTab).toHaveBeenCalledWith('acked');
    await mount(fake(entries), 'acked', true, onTab);
    expect(host.textContent).toContain('acked one');
    expect(host.textContent).not.toContain('open one');
  });

  it('acknowledges, resolves and reopens with the status the plane expects, and moves the row', async () => {
    const client = fake(entries);
    await mount(client);
    await click(button('Acknowledge', row('o')));
    expect(client.calls.set).toEqual([{ id: 'o', status: 'acked' }]);
    expect(host.textContent).not.toContain('open one'); // it left the Open tab
    await mount(client, 'resolved');
    await click(button('Reopen', row('r')));
    expect(client.calls.set).toEqual([{ id: 'o', status: 'acked' }, { id: 'r', status: 'open' }]);
    await mount(client, 'acked');
    await click(button('Resolve', row('a')));
    expect(client.calls.set!.at(-1)).toEqual({ id: 'a', status: 'resolved' });
  });

  it('offers a suppressed finding no move', async () => {
    await mount(fake(entries), 'suppressed');
    expect(row('s').querySelectorAll('button')).toHaveLength(0);
  });

  it('draws no actions when the caller may not manage — and the twin draws them', async () => {
    await mount(fake(entries), 'open', false);
    expect(host.textContent).toContain('open one');
    expect(button('Acknowledge')).toBeUndefined();
    expect(button('Suppress…')).toBeUndefined();
    await mount(fake(entries), 'open', true);
    expect(button('Acknowledge')).toBeTruthy();
    expect(button('Suppress…')).toBeTruthy();
  });

  it('keeps the row and says why when the plane refuses an action', async () => {
    const client = fake(entries);
    client.setFindingStatus = async () => {
      throw new ApiError(403, 'forbidden', null);
    };
    await mount(client);
    await click(button('Resolve', row('o')));
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/read findings but not change/);
    expect(host.textContent).toContain('open one'); // still on the Open tab
  });

  it('says there is no access when the plane refuses the read', async () => {
    const client = fake(entries);
    client.listFindings = async () => {
      throw new ApiError(403, 'forbidden', null);
    };
    await mount(client);
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/do not have access/);
    expect(host.textContent).not.toContain('open one');
  });

  it('says the store is not there yet when the read is unavailable', async () => {
    const client = fake(entries);
    client.listFindings = async () => ({ available: false, entries: [] });
    await mount(client);
    expect(host.textContent).toContain('not available on this platform yet');
  });

  it('has an empty state for every tab', async () => {
    await mount(fake([]));
    expect(host.textContent).toContain('No findings');
    await mount(fake([]), 'suppressed');
    expect(host.textContent).toContain('Nothing suppressed');
  });

  it('suppresses with a scoped rule, an expiry and a reason, then reloads', async () => {
    const client = fake(entries);
    await mount(client);
    await click(button('Suppress…', row('o')));
    const confirm = button('Suppress', document.body)!;
    expect(confirm.disabled).toBe(true); // a reason is required
    const input = document.body.querySelector('input')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'known retry storm');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Suppress', document.body));
    expect(client.calls.create).toHaveLength(1);
    expect(client.calls.create![0]).toMatchObject({ kind: 'recurring', operation: 'tickets/create', reason: 'known retry storm' });
    expect(Date.parse((client.calls.create![0] as { expiresAt: string }).expiresAt)).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(host.textContent).toContain('2 findings suppressed');
  });

  it('lists the rules on the Suppressed tab and revokes one', async () => {
    const rule: FindingRuleEntry = { id: 'R1', tenantId: 'T', kind: null, operation: 'tickets/create', code: 'conflict', subject: null, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), reason: 'noise', createdBy: 'me', createdAt: 'then' };
    const client = fake(entries, [rule]);
    await mount(client, 'suppressed');
    expect(host.textContent).toContain('conflict on tickets/create');
    await click(button('Revoke rule'));
    expect(client.calls.revoke).toEqual([{ ruleId: 'R1' }]);
  });

  it('works end to end on the preview client', async () => {
    const client = mockFindingsClient();
    await mount(client);
    await click(button('Acknowledge', host.querySelector('[data-finding="F2"]')!));
    const after = (await client.listFindings({})).entries.find((e) => e.id === 'F2');
    expect(after?.status).toBe('acked');
  });
});

describe('the generated client the view is built on', () => {
  it('speaks the paths and verbs the plane serves', async () => {
    const seen: { url: string; method: string; body: unknown }[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ available: true, entries: [] }), { status: 200 });
    });
    const client = createClient({ baseUrl: '/api/teams/T1', fetch: fetch as unknown as typeof globalThis.fetch });
    await client.listFindings({});
    await client.setFindingStatus({ id: 'F 1', status: 'acked' });
    await client.createFindingRule({ operation: 'a/b', expiresAt: '2026-10-08T00:00:00.000Z', reason: 'r' });
    await client.revokeFindingRule({ ruleId: 'R1' });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /api/teams/T1/findings',
      'PUT /api/teams/T1/findings/F%201/status',
      'POST /api/teams/T1/findings/rules',
      'DELETE /api/teams/T1/findings/rules/R1',
    ]);
    expect(seen[1]!.body).toEqual({ status: 'acked' });
  });
});
