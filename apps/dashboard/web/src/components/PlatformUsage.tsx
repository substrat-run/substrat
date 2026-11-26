import { useEffect, useState, type CSSProperties } from 'react';
import { Segmented } from '@substrat-run/ui/wa';
import { isApiError, teamApi } from '../lib/api';
import { shortBytes, shortNumber, verticalLabel, type VerticalNames } from '../lib/usage-days';
import { LINE_COLORS } from './TrafficChart';
import { card, Pill } from './ui';

type Reading = Awaited<ReturnType<ReturnType<typeof teamApi>['readPlatformUsage']>>;
type Quantities = NonNullable<Reading['days'][number]['quantities']>;
type Day = Reading['days'][number];
type Period = '7' | '30' | '90';
type Split = 'app' | 'kind';
type Result = { key: string; reading: Reading | null; error: 'forbidden' | 'unavailable' | 'absent' | null };

const PERIODS: { value: Period; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];
const SPLITS: { value: Split; label: string }[] = [
  { value: 'app', label: 'By app' },
  { value: 'kind', label: 'Live vs preview' },
];
const HEIGHT = 180;
const GAP = 'repeating-linear-gradient(135deg, var(--border-default) 0 3px, transparent 3px 7px)';
const mono: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' };
const th: CSSProperties = { textAlign: 'right', fontWeight: 500, fontSize: 11.5, color: 'var(--text-tertiary)', padding: '6px 8px', whiteSpace: 'nowrap' };
const td: CSSProperties = { textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12, padding: '6px 8px', whiteSpace: 'nowrap' };

/** The plane's decimal dollar string, for display only: the plane did the arithmetic. */
const usd = (amount: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(amount));
/** A small amount keeps enough digits to not read as nothing. */
const usdFine = (amount: string) => Number(amount) > 0 && Number(amount) < 0.01 ? '< $0.01' : usd(amount);
const qty = (value: string) => shortNumber(Number(value));
const COLUMNS: { key: keyof Quantities; label: string; format: (v: string) => string }[] = [
  { key: 'rowsWritten', label: 'Rows written', format: qty },
  { key: 'rowsRead', label: 'Rows read', format: qty },
  { key: 'storage', label: 'Storage', format: (v) => shortBytes(Number(v)) },
  { key: 'requests', label: 'Requests', format: qty },
  { key: 'cpu', label: 'CPU', format: (v) => `${qty(v)} ms` },
  { key: 'doRequests', label: 'DO requests', format: qty },
  // #3316: builder sandboxes and other platform containers run for the team. Disk and egress are
  // in the would-cost but kept out of the table: they are a small share of a container's price.
  { key: 'containerCpu', label: 'Container CPU', format: (v) => `${qty(v)} vCPU-s` },
  { key: 'containerMemory', label: 'Container memory', format: (v) => `${qty(v)} GiB-s` },
];
/**
 * Every priced meter, as the bar's overlay names it: what the quantity counts, and for the one a
 * day mostly went on, a line saying what drives it.
 */
const METERS: { key: keyof Quantities; label: string; format: (v: string) => string; hint: string }[] = [
  { key: 'rowsWritten', label: 'Rows written', format: qty, hint: 'Every database row an app inserts, updates or deletes, each index entry included. Background work such as schedules, imports and syncs often writes far more than people do.' },
  { key: 'rowsRead', label: 'Rows read', format: qty, hint: 'Every database row a query scans. A list or search without a matching index reads the whole table.' },
  { key: 'storage', label: 'Storage', format: (v) => shortBytes(Number(v)), hint: 'What the apps keep stored, charged a little each day.' },
  { key: 'requests', label: 'Requests', format: qty, hint: 'Requests that reach your apps.' },
  { key: 'cpu', label: 'CPU', format: (v) => `${qty(v)} ms`, hint: 'Compute time your apps spend handling requests and background work.' },
  { key: 'doRequests', label: 'Database requests', format: qty, hint: 'Calls into the apps\' databases, one or more per operation.' },
  { key: 'duration', label: 'Database time', format: (v) => `${qty(v)} GB-s`, hint: 'How long the apps\' databases stay awake doing work.' },
  { key: 'containerCpu', label: 'Container CPU', format: (v) => `${qty(v)} vCPU-s`, hint: 'Builds and other containers run for the team.' },
  { key: 'containerMemory', label: 'Container memory', format: (v) => `${qty(v)} GiB-s`, hint: 'Builds and other containers run for the team.' },
  { key: 'containerDisk', label: 'Container disk', format: (v) => `${qty(v)} GB-s`, hint: 'Builds and other containers run for the team.' },
  { key: 'containerEgress', label: 'Container egress', format: (v) => shortBytes(Number(v)), hint: 'Data containers send out.' },
];
const pct = (part: number, whole: number) => whole > 0 ? `${Math.round((part / whole) * 100)}%` : '';
/** A price-per-meter object's meters with a price, costliest first. */
const pricedMeters = (prices: Partial<Record<keyof Quantities, string>> | null | undefined) =>
  prices ? METERS.map((m) => ({ meter: m, usd: Number(prices[m.key] ?? '0') })).filter((m) => m.usd > 0).sort((a, b) => b.usd - a.usd) : [];

/** A kind this dashboard does not know yet is shown as the plane named it, never as live. */
const kindLabel = (kind: string) => kind === 'preview' ? 'Preview' : kind === 'live' ? 'Live' : kind;
const appLabel = (names: VerticalNames, vertical: string | null) => vertical === null ? 'No app' : verticalLabel(names, vertical);

/** Up to this many lines per list in a bar's overlay; the rest are summed into one. */
const OVERLAY_LINES = 4;

/**
 * What one bar is made of: the meters the day's price went on (with the quantity behind each), and
 * the apps or kinds that ran it up, each with the meter it mostly went on. A plane from before the
 * per-meter price answers quantities only, and the overlay lists those without a price.
 */
function BarDetail({ day, segments, labelOf, colorOf, split }: {
  day: Day;
  segments: { key: string; value: number; leading: { label: string; usd: number } | null }[];
  labelOf: Map<string, string>;
  colorOf: Map<string, string>;
  split: Split;
}) {
  const heading = <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>{new Date(`${day.day}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</div>;
  const sub: CSSProperties = { fontSize: 10.5, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', margin: '10px 0 4px' };
  const row: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, lineHeight: 1.6 };
  if (!day.read) {
    return <>{heading}<div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>Not read yet. The platform reads each day once it has closed, after 03:00 UTC the next day.</div></>;
  }
  const total = Number(day.wouldCostUsd ?? '0');
  const meters = pricedMeters(day.wouldCostByDimension);
  const unpriced = !day.wouldCostByDimension && day.quantities
    ? METERS.filter((m) => Number(day.quantities![m.key] ?? '0') > 0)
    : [];
  const shownSegments = segments.filter((seg) => seg.value > 0);
  const lead = meters[0];
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16 }}>
        {heading}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{usdFine(day.wouldCostUsd ?? '0')}</span>
      </div>
      {total === 0 && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>Nothing billable used.</div>}
      {meters.length > 0 && (
        <>
          <div style={sub}>What it went on</div>
          {meters.slice(0, OVERLAY_LINES).map(({ meter, usd: price }) => (
            <div key={meter.key} data-meter={meter.key} style={row}>
              <span style={{ flex: 1, color: 'var(--text-secondary)' }}>{meter.label}</span>
              <span style={{ ...mono, fontSize: 11.5 }}>{meter.format(day.quantities?.[meter.key] ?? '0')}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, minWidth: 56, textAlign: 'right' }}>{usdFine(String(price))}</span>
              <span style={{ ...mono, minWidth: 30, textAlign: 'right' }}>{pct(price, total)}</span>
            </div>
          ))}
          {meters.length > OVERLAY_LINES && (
            <div style={{ ...row, color: 'var(--text-tertiary)' }}>
              <span style={{ flex: 1 }}>{meters.length - OVERLAY_LINES} more</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{usdFine(String(meters.slice(OVERLAY_LINES).reduce((n, m) => n + m.usd, 0)))}</span>
            </div>
          )}
          {lead && lead.usd / total >= 0.5 && (
            <div style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.45, color: 'var(--text-secondary)' }}>
              <strong style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{lead.meter.label}</strong> is {pct(lead.usd, total)} of this day. {lead.meter.hint}
            </div>
          )}
        </>
      )}
      {unpriced.length > 0 && (
        <>
          <div style={sub}>Used</div>
          {unpriced.slice(0, OVERLAY_LINES).map((meter) => (
            <div key={meter.key} style={row}>
              <span style={{ flex: 1, color: 'var(--text-secondary)' }}>{meter.label}</span>
              <span style={{ ...mono, fontSize: 11.5 }}>{meter.format(day.quantities![meter.key] ?? '0')}</span>
            </div>
          ))}
        </>
      )}
      {shownSegments.length > 0 && (
        <>
          <div style={sub}>{split === 'kind' ? 'Live vs preview' : 'By app'}</div>
          {shownSegments.slice(0, OVERLAY_LINES).map((seg) => (
            <div key={seg.key} data-segment={seg.key} style={row}>
              <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: colorOf.get(seg.key), flexShrink: 0, alignSelf: 'center' }} />
              <span style={{ flex: 1, minWidth: 0, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {labelOf.get(seg.key) ?? seg.key}
                {seg.leading && <span style={{ color: 'var(--text-tertiary)' }}> · mostly {seg.leading.label.toLowerCase()}</span>}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, minWidth: 56, textAlign: 'right' }}>{usdFine(String(seg.value))}</span>
              <span style={{ ...mono, minWidth: 30, textAlign: 'right' }}>{pct(seg.value, total)}</span>
            </div>
          ))}
          {shownSegments.length > OVERLAY_LINES && (
            <div style={{ ...row, color: 'var(--text-tertiary)' }}>
              <span style={{ flex: 1 }}>{shownSegments.length - OVERLAY_LINES} more</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{usdFine(String(shownSegments.slice(OVERLAY_LINES).reduce((n, seg) => n + seg.value, 0)))}</span>
            </div>
          )}
        </>
      )}
    </>
  );
}

/**
 * One bar per closed day, stacked by app or by kind. A day the rollup has not read is hatched, never
 * zero. Hovering or focusing a bar opens what it is made of (`BarDetail`).
 */
function DailyCost({ reading, split, names }: { reading: Reading; split: Split; names: VerticalNames }) {
  const [active, setActive] = useState<number | null>(null);
  const keyOf = (row: { vertical: string | null; kind: string }) => split === 'kind' ? row.kind : `${row.vertical ?? ''}`;
  const labelOf = (row: { vertical: string | null; kind: string }) => split === 'kind' ? kindLabel(row.kind) : appLabel(names, row.vertical);
  const series = new Map<string, string>();
  for (const app of reading.apps) if (!series.has(keyOf(app))) series.set(keyOf(app), labelOf(app));
  for (const day of reading.days) for (const app of day.byApp) if (!series.has(keyOf(app))) series.set(keyOf(app), labelOf(app));
  const colorOf = new Map([...series.keys()].map((key, i) => [key, split === 'kind' && key === 'preview' ? 'var(--text-tertiary)' : LINE_COLORS[i % LINE_COLORS.length]!]));
  const bars = reading.days.map((day) => {
    const segments = new Map<string, { value: number; prices: Partial<Record<keyof Quantities, number>> | null }>();
    for (const app of day.byApp) {
      const held = segments.get(keyOf(app)) ?? { value: 0, prices: app.wouldCostByDimension ? {} : null };
      held.value += Number(app.wouldCostUsd);
      if (held.prices && app.wouldCostByDimension) {
        for (const m of METERS) held.prices[m.key] = (held.prices[m.key] ?? 0) + Number(app.wouldCostByDimension[m.key] ?? '0');
      } else held.prices = null;
      segments.set(keyOf(app), held);
    }
    return {
      day,
      total: day.wouldCostUsd,
      segments: [...segments].map(([key, { value, prices }]) => {
        const top = prices ? METERS.map((m) => ({ label: m.label, usd: prices[m.key] ?? 0 })).sort((a, b) => b.usd - a.usd)[0] : undefined;
        return { key, value, leading: top && top.usd > 0 && top.usd / value >= 0.5 ? top : null };
      }),
    };
  });
  const peak = Math.max(0, ...bars.map((bar) => Number(bar.total ?? 0)));
  const shown = active === null ? null : bars[active] ?? null;
  // The overlay opens beside the hovered bar, toward the middle of the chart, so it never covers
  // the bar it explains and stays inside the card at either edge.
  const onLeft = active !== null && (active + 0.5) / bars.length > 0.5;
  const place: CSSProperties = active === null ? {} : onLeft
    ? { left: `${(active / bars.length) * 100}%`, transform: 'translateX(calc(-100% - 8px))' }
    : { left: `calc(${((active + 1) / bars.length) * 100}% + 8px)` };
  const summary = (bar: (typeof bars)[number]) => {
    if (!bar.day.read) return `${bar.day.day}: not read yet`;
    const lead = pricedMeters(bar.day.wouldCostByDimension)[0];
    return `${bar.day.day}: would cost ${usdFine(bar.total ?? '0')}${lead ? `, mostly ${lead.meter.label.toLowerCase()}` : ''}`;
  };
  return (
    <div>
      <div style={{ display: 'flex', gap: 10 }}>
        <div aria-hidden="true" style={{ ...mono, width: 56, height: HEIGHT, flexShrink: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', textAlign: 'right' }}>
          <span>{usd(String(peak))}</span>
          <span>$0</span>
        </div>
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <div
            role="group"
            aria-label={`Daily would-cost: ${reading.readDays} of ${reading.totalDays} days read, highest ${usd(String(peak))}. Hover or focus a day for what it went on.`}
            onMouseLeave={() => setActive(null)}
            style={{ height: HEIGHT, display: 'flex', alignItems: 'flex-end', gap: 2, borderBottom: '1px solid var(--border-strong)' }}
          >
            {bars.map((bar, i) => (
              <div
                key={bar.day.day}
                data-day={bar.day.day}
                tabIndex={0}
                aria-label={summary(bar)}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive((held) => held === i ? null : held)}
                style={{ flex: '1 1 0', minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column-reverse', gap: 1, cursor: 'default', opacity: active === null || active === i ? 1 : 0.45, transition: 'opacity 80ms' }}
              >
                {!bar.day.read
                  ? <div data-gap={bar.day.day} style={{ height: '100%', background: GAP }} />
                  : bar.segments.map((seg) => (
                    <div key={seg.key} style={{ height: peak > 0 ? `${(seg.value / peak) * 100}%` : 0, background: colorOf.get(seg.key) }} />
                  ))}
              </div>
            ))}
          </div>
          {shown && (
            <div
              role="tooltip"
              data-bar-detail={shown.day.day}
              style={{
                position: 'absolute', top: 0, ...place, zIndex: 10,
                width: 340, boxSizing: 'border-box', padding: '10px 12px', pointerEvents: 'none',
                background: 'var(--surface-raised, var(--surface-card))', border: '1px solid var(--border-default)', borderRadius: 8,
                boxShadow: '0 6px 24px rgba(0, 0, 0, 0.14)',
              }}
            >
              <BarDetail day={shown.day} segments={shown.segments} labelOf={series} colorOf={colorOf} split={split} />
            </div>
          )}
          <div aria-hidden="true" style={{ ...mono, display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
            <span>{bars[0]?.day.day}</span>
            <span>{bars[bars.length - 1]?.day.day}</span>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, marginTop: 14, fontSize: 12.5, color: 'var(--text-secondary)' }}>
        {[...series].filter(([key]) => reading.apps.some((app) => keyOf(app) === key)).map(([key, label]) => (
          <span key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: colorOf.get(key) }} />
            {label}
          </span>
        ))}
        {reading.readDays < reading.totalDays && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: GAP }} />
            Hatched: not read yet
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * `storageDays`, for a window total: its storage figure sums each read day's bytes, so it is shown
 * as the average stored over those days. A day's row shows that day's bytes.
 */
function QuantityTable({ caption, rows, storageDays }: { caption: string; rows: { key: string; label: string; wouldCostUsd: string | null; quantities: Quantities | null }[]; storageDays?: number }) {
  const cell = (c: (typeof COLUMNS)[number], q: Quantities) =>
    c.key === 'storage' && storageDays ? `${shortBytes(Number(q.storage) / storageDays)} avg` : c.format(q[c.key] ?? '0');
  return (
    <div style={{ overflowX: 'auto' }}>
      <table aria-label={caption} style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-default)' }}>
            <th style={{ ...th, textAlign: 'left' }}>{caption}</th>
            <th style={th}>Would cost</th>
            {COLUMNS.map((c) => <th key={c.key} style={th}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} style={{ borderBottom: '1px solid var(--border-subtle, var(--border-default))' }}>
              <td style={{ ...td, textAlign: 'left', fontFamily: 'inherit' }}>{row.label}</td>
              <td style={td}>{row.wouldCostUsd === null ? '—' : usdFine(row.wouldCostUsd)}</td>
              {COLUMNS.map((c) => <td key={c.key} style={td}>{row.quantities === null ? '—' : cell(c, row.quantities)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Why there is nothing to draw: the daily pass has not read these days, or the team used nothing on them. */
function EmptyState({ reading }: { reading: Reading }) {
  if (reading.state === 'not-read') {
    return (
      <div role="status" style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.5 }}>
        <strong style={{ color: 'var(--text-primary)', fontWeight: 500 }}>No usage has been read for this period yet.</strong>{' '}
        The platform reads each day's usage once the day has closed (after 03:00 UTC the next day). Until a day in this period has been read there is nothing to show here, which does not mean your apps used nothing.
      </div>
    );
  }
  return (
    <div role="status" style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.5 }}>
      <strong style={{ color: 'var(--text-primary)', fontWeight: 500 }}>No platform usage.</strong>{' '}
      Your apps used nothing billable on the {reading.readDays} {reading.readDays === 1 ? 'day' : 'days'} read in this period{reading.readDays < reading.totalDays ? `; ${reading.totalDays - reading.readDays} more ${reading.totalDays - reading.readDays === 1 ? 'day has' : 'days have'} not been read yet` : ''}.
    </div>
  );
}

/**
 * What the team's apps used of the platform, per day, and what it would cost at the platform's
 * price. Nothing is charged yet: like code reviews, the price is shown before it is billed.
 */
export function PlatformUsage({ teamId, names }: { teamId: string; names: VerticalNames }) {
  const [period, setPeriod] = useState<Period>('30');
  const [split, setSplit] = useState<Split>('app');
  const [result, setResult] = useState<Result | null>(null);
  const key = `${teamId}:${period}`;

  useEffect(() => {
    let current = true;
    void teamApi(teamId).readPlatformUsage({ days: Number(period) }).then(
      (reading) => { if (current) setResult({ key, reading, error: null }); },
      (error: unknown) => {
        if (!current) return;
        const status = isApiError(error) ? error.status : 0;
        setResult({ key, reading: null, error: status === 403 ? 'forbidden' : status === 501 ? 'absent' : 'unavailable' });
      },
    );
    return () => { current = false; };
  }, [teamId, period, key]);

  const shown = result?.key === key ? result : null;
  const reading = shown?.reading ?? null;
  const section = { ...card, marginTop: 12, overflow: 'hidden' } satisfies CSSProperties;
  const header = (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 12px 8px 20px', background: 'var(--surface-inset)', borderBottom: '1px solid var(--border-default)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)' }}>Platform usage</h2>
        <Pill kind="success">Not charged</Pill>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Segmented label="Period" options={PERIODS} value={period} onChange={setPeriod} />
        <Segmented label="Split" options={SPLITS} value={split} onChange={setSplit} />
      </div>
    </div>
  );

  let body;
  if (!shown) body = <div role="status" style={{ fontSize: 13 }}>Loading platform usage…</div>;
  else if (shown.error === 'forbidden') body = <div role="status" style={{ fontSize: 13 }}>Ask a team owner or admin to view platform usage.</div>;
  else if (shown.error === 'absent') body = <div role="status" style={{ fontSize: 13 }}>Platform usage is not measured on this platform yet.</div>;
  else if (!reading) body = <div role="status" style={{ fontSize: 13 }}>Platform usage is unavailable. Try again later.</div>;
  else if (reading.state === 'not-read' || reading.state === 'empty') body = <EmptyState reading={reading} />;
  else {
    const totals = split === 'kind'
      ? (['live', 'preview'] as const).map((kind) => {
        const of = reading.apps.filter((a) => a.kind === kind);
        return {
          key: kind,
          label: kindLabel(kind),
          wouldCostUsd: kind === 'live' ? reading.liveWouldCostUsd : reading.previewWouldCostUsd,
          quantities: of.length === 0 ? null : Object.fromEntries(COLUMNS.map((c) => [c.key, String(of.reduce((n, a) => n + Number(a.quantities[c.key] ?? '0'), 0))])) as Quantities,
        };
      }).filter((row) => row.quantities !== null)
      : reading.apps.map((a) => ({ key: `${a.vertical}:${a.kind}`, label: `${appLabel(names, a.vertical)}${a.kind === 'preview' ? ' · preview' : ''}`, wouldCostUsd: a.wouldCostUsd, quantities: a.quantities }));
    body = (
      <>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 28, marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>Would cost</div>
            <div style={{ marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 24, fontWeight: 500 }}>{usd(reading.wouldCostUsd)}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Charged {usd(reading.chargedUsd)}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>Live</div>
            <div style={{ marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 18 }}>{usd(reading.liveWouldCostUsd)}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>Preview</div>
            <div style={{ marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 18 }}>{usd(reading.previewWouldCostUsd)}</div>
          </div>
        </div>
        <DailyCost reading={reading} split={split} names={names} />
        <div style={{ marginTop: 18 }}>
          <QuantityTable caption={split === 'kind' ? 'Kind' : 'App'} rows={totals} storageDays={reading.readDays} />
        </div>
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)' }}>Per day</summary>
          <div style={{ marginTop: 8 }}>
            <QuantityTable
              caption="Day"
              rows={[...reading.days].reverse().map((d) => ({ key: d.day, label: d.read ? d.day : `${d.day} (not read yet)`, wouldCostUsd: d.wouldCostUsd, quantities: d.quantities }))}
            />
          </div>
        </details>
      </>
    );
  }

  return (
    <section aria-label="Platform usage" style={section}>
      {header}
      <div style={{ padding: 20 }}>
        {body}
        <p style={{ margin: '16px 0 0', fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          What your apps used of the platform, priced at the platform's rate: database rows written and read, storage, requests, compute and Durable Object requests.
          Nothing is charged yet, so you can see what usage would cost before it is billed.
          {reading && reading.state !== 'not-read' ? ` ${reading.readDays} of ${reading.totalDays} days read${reading.lastReadAt ? `, last on ${reading.lastReadAt.slice(0, 10)}` : ''}.` : ''}
          {reading?.truncated ? ' Some request or storage figures were capped, so totals are a lower bound.' : ''}
        </p>
      </div>
    </section>
  );
}
