import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type AppFreshnessRow, type AppScheduleRow, type AppSchedulesView, type SweepRunView } from '../src/lib/api';
import {
  RUN_CAP,
  SCHEDULE_VERDICT,
  FRESHNESS_VERDICT,
  freshnessSentence,
  hoistInWindow,
  pulseFreshnessRow,
  pulseScheduleRow,
  stripSlots,
} from '../src/lib/schedule-rows';
import { AppSchedules } from '../src/views/AppSchedules';
import { AppSchedulesCard } from '../src/views/AppSchedulesCard';
import { StatusBand } from '../src/views/StatusBand';
import { useAppSchedules } from '../src/lib/use-app-schedules';
import type { AppRow } from '../src/lib/api';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const run = (id: string, min: number, outcome: SweepRunView['outcome'] = 'ok', error: string | null = null): SweepRunView => ({
  id,
  outcome,
  at: ago(min),
  error,
  elapsedMs: 10,
  observedAt: null,
});
const schedule = (operation: string, runs: SweepRunView[], health: AppScheduleRow['health'] = 'healthy', everyMinutes = 60): AppScheduleRow => ({
  operation,
  moduleId: 'm',
  everyMinutes,
  permissions: [],
  lastRun: runs[0] ?? null,
  nextDueAt: runs[0] ? new Date(Date.parse(runs[0].at) + everyMinutes * 60_000).toISOString() : null,
  health,
  runs,
});
const fresh = (eventType: string, health: AppFreshnessRow['health'], observedMin: number | null, withinHours = 1): AppFreshnessRow => ({
  eventType,
  moduleId: 'm',
  withinHours,
  observedAt: observedMin === null ? null : ago(observedMin),
  health,
  runs: [],
});
const day = { from: ago(24 * 60), to: ago(0) };

describe('schedule rows (#1767)', () => {
  it("names the worker's verdicts in the design's words", () => {
    expect(Object.fromEntries(Object.entries(SCHEDULE_VERDICT).map(([k, v]) => [k, v.label]))).toEqual({
      healthy: 'Healthy',
      overdue: 'Late',
      'never-run': 'Never run',
      'sweeper-silent': 'Sweeper silent',
    });
    expect(FRESHNESS_VERDICT.stale).toEqual({ status: 'danger', label: 'Stale' });
  });

  it('places runs at their real times and counts only those inside the window', () => {
    const row = schedule('a/b', [run('3', 60), run('2', 12 * 60, 'failed', 'boom'), run('1', 30 * 60)]);
    const p = pulseScheduleRow(row, day, ago(1));
    expect(p.ticks.map((t) => [t.id, Number(t.x.toFixed(3)), t.failed])).toEqual([
      ['3', Number((23 / 24).toFixed(3)), false],
      ['2', 0.5, true],
    ]);
    expect([p.runs, p.failed, p.truncated, p.coveredFrom]).toEqual([2, 1, false, null]);
  });

  it('reads a full record whose oldest run is inside the window as a lower bound', () => {
    const runs = Array.from({ length: RUN_CAP }, (_, i) => run(String(i), 15 + i * 15));
    const p = pulseScheduleRow(schedule('fast', runs, 'healthy', 15), day, ago(1));
    expect(p.truncated).toBe(true);
    expect(p.coveredFrom).toBeCloseTo(1 - (15 * RUN_CAP) / (24 * 60), 5);
  });

  it('hatches a late schedule from the moment it fell due', () => {
    const row = schedule('late', [run('1', 3 * 60)], 'overdue', 60);
    expect(pulseScheduleRow(row, day, ago(1)).hatch?.from).toBeCloseTo(1 - 120 / (24 * 60), 5);
  });

  it('writes freshness as the sentence and the stale age', () => {
    const stale = fresh('sla.checked', 'stale', 82, 1);
    expect(freshnessSentence(stale, NOW)).toBe('No sla.checked for 1h and counting');
    expect(freshnessSentence(fresh('sla.checked', 'stale', 22, 0), NOW)).toBe('No sla.checked for 22 min and counting');
    expect(freshnessSentence(fresh('x', 'never-seen', null), NOW)).toBe('No x has ever landed here');
    const p = pulseFreshnessRow(fresh('receipt.landed', 'stale', 26 * 60, 24), day, ago(1), NOW);
    expect(p.verdict).toBe('Stale 26h');
    expect(p.hatch?.from).toBeCloseTo(1 - 120 / (24 * 60), 5);
  });

  it('pads the strip on the left, newest run at the right edge', () => {
    const slots = stripSlots([run('new', 1), run('old', 2, 'failed')]);
    expect(slots).toHaveLength(RUN_CAP);
    expect(slots.slice(0, RUN_CAP - 2).every((s) => s === null)).toBe(true);
    expect(slots.slice(-2).map((s) => s?.id)).toEqual(['old', 'new']);
  });

  it('hoists the rows with a run in the window without dropping the rest', () => {
    const rows = [schedule('a', [run('a1', 600)]), schedule('b', [run('b1', 5)]), schedule('c', [])];
    expect(hoistInWindow(rows, { from: ago(10), to: ago(0) }).map((r) => r.operation)).toEqual(['b', 'a', 'c']);
  });
});

function CardHarness({ v }: { v: AppSchedulesView }) {
  return <AppSchedulesCard scopeId="s" schedules={{ state: 'ok', view: v }} />;
}

describe('window edges', () => {
  it('a run exactly at the left edge still marks the window as truncated (20+)', () => {
    const w = { from: ago(600), to: ago(0) };
    const runs = Array.from({ length: RUN_CAP }, (_, i) => run(`r${i}`, (i * 600) / (RUN_CAP - 1)));
    const p = pulseScheduleRow(schedule('a', runs), w, ago(1));
    expect(p.runs).toBe(RUN_CAP);
    expect(p.truncated).toBe(true);
    expect(p.coveredFrom).toBe(0);
    const f = pulseFreshnessRow({ ...fresh('e', 'fresh', 1), runs }, w, ago(1), NOW);
    expect(f.runs).toBe(RUN_CAP);
    expect(f.truncated).toBe(true);
  });
});

describe('schedule surfaces', () => {
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

  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const liveRun = (id: string, min: number, outcome: SweepRunView['outcome'] = 'ok', error: string | null = null): SweepRunView => ({
    id,
    outcome,
    at: at(min),
    error,
    elapsedMs: 10,
    observedAt: null,
  });
  const view = (): AppSchedulesView => ({
    running: { versionId: 'v', version: '1.0.0' },
    lastSweepAt: at(2),
    schedules: [
      { ...schedule('app/quiet', [liveRun('q1', 20 * 60)]), lastRun: liveRun('q1', 20 * 60) },
      { ...schedule('app/failing', [liveRun('f2', 30), liveRun('f1', 90, 'failed', 'engine refused')]), lastRun: liveRun('f2', 30) },
      { ...schedule('app/new', [], 'never-run'), lastRun: null },
    ],
    freshness: [{ ...fresh('sla.checked', 'stale', 0, 1), observedAt: at(82) }],
  });

  it('Pulse draws each run as a tick on the axis, failures in red, with the verdict in words', async () => {
    vi.spyOn(api, 'appSchedules').mockResolvedValue(view());
    const w = { from: at(24 * 60), to: at(0) };
    await act(async () => root.render(<AppSchedules scopeId="s" window={w} appName="Acme HR" onOpen={() => {}} />));
    const ticks = [...container.querySelectorAll<HTMLElement>('[role="img"]')];
    expect(ticks).toHaveLength(3);
    // Drawn red, not only labelled failed: the colour and the taller tick are the chart's claim.
    const red = ticks.filter((t) => t.style.background === 'var(--status-danger-fg)');
    expect(red.map((t) => t.getAttribute('aria-label'))).toEqual([expect.stringContaining('engine refused')]);
    expect(container.textContent).toContain('Never run');
    expect(container.textContent).toContain('Stale 1h');
    expect(container.textContent).toContain('Acme HR · every hour');
  });

  it('Pulse hoists the schedule whose run a narrowed window names, and names the run', async () => {
    vi.spyOn(api, 'appSchedules').mockResolvedValue(view());
    const w = { from: at(95), to: at(85) };
    const onOpen = vi.fn();
    await act(async () => root.render(<AppSchedules scopeId="s" window={w} focused onOpen={onOpen} />));
    const names = [...container.querySelectorAll('a, div')].filter((el) => el.getAttribute('style')?.includes('height: 48px'));
    expect(names[0]!.textContent).toContain('app/failing');
    expect(names[0]!.textContent).toContain('In this window: failed');
    await act(async () => (names[0] as HTMLElement).click());
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ view: 'logs' }));
  });

  it('the Overview card draws a fixed strip per schedule and links to Schedules', async () => {
    await act(async () => root.render(<CardHarness v={view()} />));
    const strips = [...container.querySelectorAll('[aria-label^="Last "]')];
    expect(strips).toHaveLength(3);
    expect(strips.every((s) => s.children.length === RUN_CAP)).toBe(true);
    expect(container.textContent).toContain('No sla.checked for 1h and counting');
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Open schedules →')!;
    expect(link.getAttribute('href')).toContain('view=schedules');
  });

  it('the Overview card stays away when nothing is declared', async () => {
    await act(async () => root.render(<CardHarness v={{ running: { versionId: null, version: null }, schedules: null, freshness: null, lastSweepAt: null }} />));
    expect(container.innerHTML).toBe('');
  });

  it('the Overview asks for schedules once, for the Health tile and the card together', async () => {
    const spy = vi.spyOn(api, 'appSchedules').mockResolvedValue(view());
    vi.spyOn(api, 'appTenantMetrics').mockResolvedValue([]);
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    const Both = () => {
      const schedules = useAppSchedules('s');
      return (
        <>
          <StatusBand app={{ app_scope_id: 's' } as AppRow} versionLabel="1.0.0" updateAvailable={false} seat={null} schedules={schedules} />
          <AppSchedulesCard scopeId="s" schedules={schedules} />
        </>
      );
    };
    await act(async () => root.render(<Both />));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Schedules and freshness');
  });

  it('a failed last run is danger-red on both surfaces, like its tick', async () => {
    const v = view();
    vi.spyOn(api, 'appSchedules').mockResolvedValue(v);
    const failing = { ...v, schedules: [{ ...schedule('app/broke', [liveRun('b1', 30, 'failed', 'nope')]), lastRun: liveRun('b1', 30, 'failed', 'nope') }], freshness: [] };
    await act(async () => root.render(<CardHarness v={failing} />));
    const lastRun = [...container.querySelectorAll<HTMLElement>('span')].find((e) => e.textContent?.startsWith('failed ·'))!;
    expect(lastRun.style.color).toBe('var(--status-danger-fg)');
    await act(async () => root.render(<div />));
    vi.mocked(api.appSchedules).mockResolvedValue(failing);
    await act(async () => root.render(<AppSchedules scopeId="s" window={{ from: at(24 * 60), to: at(0) }} onOpen={() => {}} />));
    const pulse = [...container.querySelectorAll<HTMLElement>('span')].find((e) => /^failed \d/.test(e.textContent ?? ''))!;
    expect(pulse.style.color).toBe('var(--status-danger-fg)');
  });

  it('Pulse shows a freshness rule\'s runs, failures and ticks', async () => {
    const v = view();
    const f = { ...fresh('sla.checked', 'fresh', 30), runs: [run('r2', 30), run('r1', 90, 'failed', 'probe down')] };
    vi.spyOn(api, 'appSchedules').mockResolvedValue({ ...v, schedules: [], freshness: [{ ...f, runs: [liveRun('r2', 30), liveRun('r1', 90, 'failed', 'probe down')] }] });
    await act(async () => root.render(<AppSchedules scopeId="s" window={{ from: at(24 * 60), to: at(0) }} onOpen={() => {}} />));
    const row = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('sla.checked'))!;
    const nums = [...row.querySelectorAll('span')].map((e) => e.textContent);
    expect(nums).toEqual(expect.arrayContaining(['2', '1']));
    const ticks = [...row.querySelectorAll<HTMLElement>('[role="img"]')];
    expect(ticks).toHaveLength(2);
    expect(ticks.filter((t) => t.style.background === 'var(--status-danger-fg)')).toHaveLength(1);
  });
});
