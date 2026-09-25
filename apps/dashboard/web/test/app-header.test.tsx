import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppHeader } from '../src/views/AppHeader';
import { appVerdict } from '../src/lib/fleet-rows';
import { api, type AppHealthRow, type AppRow, type AppSchedulesView } from '../src/lib/api';
import { SchedulesAbsent } from '../src/views/AppDetail';
import type { SchedulesState } from '../src/lib/use-app-schedules';
import { obsPath } from '../src/lib/router';

const app = (status: AppRow['status'] = 'active') =>
  ({ app_scope_id: 'scope-a', name: 'Acme HR', vertical_slug: 'protocol', status, hostname: 'acme-hr.substrat.run' }) as AppRow;
const health = (scopeId: string, state: AppHealthRow['state'], reason = `${state} reason`) =>
  ({ scopeId, name: 'x', vertical: 'protocol', state, reason, failures: 0, sweepFailures: 0, stale: 0, lastSweepAt: null }) as AppHealthRow;

describe('appVerdict (#1767)', () => {
  it('judges install state first, then the health row, and a missing row as unknown', () => {
    expect(appVerdict({ status: 'failed' }, health('a', 'ok')).verdict).toBe('install-failed');
    expect(appVerdict({ status: 'provisioning' }, health('a', 'ok')).verdict).toBe('installing');
    expect(appVerdict({ status: 'active' }, health('a', 'stale', 'late'))).toEqual({ verdict: 'stale', why: 'late' });
    expect(appVerdict({ status: 'active' }, undefined).verdict).toBe('unknown');
  });
});

describe('App page header', () => {
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

  const render = (a: AppRow) => act(async () => root.render(<AppHeader app={a} statusKind="success" statusLabel="Active" />));
  const verdict = () => container.querySelector('[data-verdict]');
  // The verdict's word; the reason sits beside it inside the same trigger.
  const label = () => verdict()?.firstElementChild?.textContent;
  const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;

  it("shows this app's fleet verdict, with the sentence behind it", async () => {
    vi.spyOn(api, 'fleetHealth').mockResolvedValue({ rows: [health('other', 'ok'), health('scope-a', 'failing', '3 operation failures recorded.')] });
    await render(app());
    expect(verdict()?.getAttribute('data-verdict')).toBe('failing');
    expect(label()).toBe('Failing');
  });

  it('shows the reason on keyboard focus, tied to the verdict by aria-describedby', async () => {
    vi.spyOn(api, 'fleetHealth').mockResolvedValue({ rows: [health('scope-a', 'failing', '3 operation failures recorded.')] });
    await render(app());
    const trigger = verdict() as HTMLElement;
    expect(trigger.tabIndex).toBe(0);
    const reason = document.getElementById(trigger.getAttribute('aria-describedby')!)!;
    expect(reason.textContent).toBe('3 operation failures recorded.');
    expect(reason.hidden).toBe(true);
    act(() => trigger.focus());
    expect(reason.hidden).toBe(false);
    act(() => trigger.blur());
    expect(reason.hidden).toBe(true);
  });

  it("does not show the last app's verdict, or Unknown, while the next app's read is pending", async () => {
    vi.spyOn(api, 'fleetHealth')
      .mockResolvedValueOnce({ rows: [health('scope-a', 'failing')] })
      .mockReturnValueOnce(new Promise(() => {}));
    await render(app());
    expect(label()).toBe('Failing');
    // A layout effect sees every commit before the header's own effects run, which is
    // where a stale verdict would show for one frame; asserting after `act` cannot.
    const commits: string[] = [];
    const Probe = () => {
      useLayoutEffect(() => void commits.push(container.textContent ?? ''));
      return null;
    };
    const next = { ...app(), app_scope_id: 'scope-b', name: 'Acme Legal' };
    await act(async () => root.render(<><AppHeader app={next} statusKind="success" statusLabel="Active" /><Probe /></>));
    expect(verdict()).toBeNull();
    expect(commits.length).toBeGreaterThan(0);
    for (const text of commits) {
      expect(text).toContain('Active');
      expect(text).not.toMatch(/Failing|Unknown/);
    }
  });

  it('shows the install status until the read answers, and Unknown when it fails', async () => {
    let fail!: (e: Error) => void;
    vi.spyOn(api, 'fleetHealth').mockReturnValue(new Promise((_, reject) => (fail = reject)));
    await render(app());
    expect(verdict()).toBeNull();
    expect(container.textContent).toContain('Active');
    await act(async () => fail(new Error('down')));
    expect(label()).toBe('Unknown');
  });

  it('judges an installing app by its install state without waiting on the read', async () => {
    vi.spyOn(api, 'fleetHealth').mockReturnValue(new Promise(() => {}));
    await render(app('provisioning'));
    expect(label()).toBe('Installing');
  });

  it('makes no fleet read for an app that is not running', async () => {
    const read = vi.spyOn(api, 'fleetHealth').mockResolvedValue({ rows: [] });
    await render(app('provisioning'));
    await render(app('failed'));
    expect(read).not.toHaveBeenCalled();
  });

  it('puts the vertical and the hostname on the sub-line', async () => {
    vi.spyOn(api, 'fleetHealth').mockResolvedValue({ rows: [] });
    await render(app());
    expect(container.textContent).toContain('protocol');
    expect(container.querySelector('a[href="https://acme-hr.substrat.run"]')).not.toBeNull();
  });

  it.each([
    ['Flow map', 'flow'],
    ['Logs', 'logs'],
  ])('%s opens Observability narrowed to this app', async (label, view) => {
    vi.spyOn(api, 'fleetHealth').mockResolvedValue({ rows: [] });
    await render(app());
    act(() => button(label).click());
    const at = new URL(window.location.href);
    expect(at.pathname).toBe('/observability');
    expect(Object.fromEntries(at.searchParams)).toEqual({ app: 'scope-a', view });
  });
});

describe('Overview schedules line when the card has nothing to draw', () => {
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
  });
  const empty = { running: { versionId: null, version: null }, schedules: null, freshness: null, lastSweepAt: null } as AppSchedulesView;
  const draw = (s: SchedulesState) => act(() => root.render(<SchedulesAbsent scopeId="scope-a" schedules={s} />));

  it('says nothing is declared, with no link, when there are no schedules or freshness rules', () => {
    draw({ state: 'ok', view: { ...empty, running: { versionId: 'ver-1', version: '1.0.0' } } });
    expect(container.textContent).toContain('none declared by the running version');
    expect(container.querySelector('a')).toBeNull();
  });

  it('says no version is running yet, rather than blaming a running version, when none is', () => {
    draw({ state: 'ok', view: empty });
    expect(container.textContent).toContain('no version is running yet');
    expect(container.textContent).not.toContain('running version');
    expect(container.querySelector('a')).toBeNull();
  });

  it('says a failed read is not measured, and links to the schedules view', () => {
    draw({ state: 'error' });
    expect(container.textContent).toContain('could not be read — not measured, not zero');
    const link = container.querySelector('a')!;
    expect(link.textContent).toBe('Open schedules →');
    expect(link.getAttribute('href')).toBe(obsPath({ app: 'scope-a', view: 'schedules' }));
  });

  it('renders nothing when schedules are declared, or while the read is in flight', () => {
    draw({ state: 'ok', view: { ...empty, schedules: [{} as NonNullable<AppSchedulesView['schedules']>[number]] } });
    expect(container.innerHTML).toBe('');
    draw({ state: 'loading' });
    expect(container.innerHTML).toBe('');
  });
});
