import { useState, type CSSProperties } from 'react';
import { Segmented } from '@substrat-run/ui/wa';
import { LINE_COLORS } from './TrafficChart';
import { card } from './ui';
import { ALL_APPS, appsOf, shortBytes, shortNumber, usageChart, type UsageDay, type UsageMetric } from '../lib/usage-days';

const HEIGHT = 220;
const METRICS: { value: UsageMetric; label: string }[] = [
  { value: 'requests', label: 'Requests' },
  { value: 'tokens', label: 'Model tokens' },
  { value: 'stored', label: 'Stored' },
];
const GAP = 'repeating-linear-gradient(135deg, var(--border-default) 0 3px, transparent 3px 7px)';
const mono: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' };

/** One bar per closed day, stacked by app. A day with no reading is hatched, never a zero. */
export function UsageChart({ days }: { days: readonly UsageDay[] }) {
  const [metric, setMetric] = useState<UsageMetric>('requests');
  const [picked, setPicked] = useState(ALL_APPS);
  const apps = appsOf(days, metric);
  const app = apps.some((row) => row.key === picked) ? picked : ALL_APPS;
  const { series, bars, peak } = usageChart(days, metric, app);
  const colorOf = new Map(series.map((row, i) => [row.key, row.key === 'other' ? 'var(--text-tertiary)' : LINE_COLORS[i % LINE_COLORS.length]!]));
  const format = metric === 'stored' ? shortBytes : shortNumber;
  const read = bars.filter((bar) => bar.value !== null).length;
  const noReading = metric === 'tokens' ? 'no reported tokens' : 'no reading';
  const scopesOn = (day: string) => days.find((row) => row.day === day)?.storedScopes ?? 0;
  const titleOf = (bar: (typeof bars)[number]) => bar.value === null
    ? `${bar.day}: ${noReading}`
    : `${bar.day}: ${format(bar.value)}${metric === 'stored' ? `, ${scopesOn(bar.day)} scopes sampled` : ''}`;

  return (
    <section aria-label="Daily usage" style={{ ...card, marginTop: 12, overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 12px 8px 20px', background: 'var(--surface-inset)', borderBottom: '1px solid var(--border-default)' }}>
        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)' }}>Daily usage</h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <Segmented label="Meter" options={METRICS} value={metric} onChange={setMetric} />
          {apps.length > 1 && (
            <Segmented
              label="App"
              options={[{ value: ALL_APPS, label: 'All apps' }, ...apps.slice(0, 4).map((row) => ({ value: row.key, label: row.label }))]}
              value={app}
              onChange={setPicked}
            />
          )}
        </div>
      </div>
      <div style={{ padding: 20 }}>
        {read === 0 ? (
          <div role="status" style={{ color: 'var(--text-secondary)', fontSize: 13 }}>No daily readings are available for this meter yet.</div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 10 }}>
              <div aria-hidden="true" style={{ ...mono, width: 56, height: HEIGHT, flexShrink: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', textAlign: 'right' }}>
                <span>{format(peak)}</span>
                <span>0</span>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  role="img"
                  aria-label={`Daily ${metric}: ${read} of ${bars.length} days have a reading, highest ${format(peak)}`}
                  style={{ height: HEIGHT, display: 'flex', alignItems: 'flex-end', gap: 3, borderBottom: '1px solid var(--border-strong)' }}
                >
                  {bars.map((bar) => (
                    <div key={bar.day} title={titleOf(bar)} style={{ flex: '1 1 0', minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column-reverse', gap: 1 }}>
                      {bar.value === null
                        ? <div data-gap={bar.day} style={{ height: '100%', background: GAP }} />
                        : bar.segments.map((segment) => (
                          <div key={segment.key} style={{ height: peak > 0 ? `${(segment.value / peak) * 100}%` : 0, background: colorOf.get(segment.key) }} />
                        ))}
                    </div>
                  ))}
                </div>
                <div aria-hidden="true" style={{ ...mono, display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                  <span>{bars[0]?.day}</span>
                  <span>{bars[bars.length - 1]?.day}</span>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16, marginTop: 14, fontSize: 12.5, color: 'var(--text-secondary)' }}>
              {series.map((row) => (
                <span key={row.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: colorOf.get(row.key) }} />
                  {row.label}
                </span>
              ))}
              {read < bars.length && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, background: GAP }} />
                  Hatched: {noReading} for that day
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
