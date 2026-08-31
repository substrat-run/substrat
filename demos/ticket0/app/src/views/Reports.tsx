/**
 * The desk, measured (#1085).
 *
 * One read — `ticket0/desk-metrics` — and one screen, and the assistant panel is at the
 * top of it on purpose. Everything below it is the report every desk has; the panel is
 * the one this product is about, because "the assistant cost €4.10" is half a sentence
 * and "…and settled 61% of the turns, at €0.02 per resolved conversation" is the rest.
 *
 * The screen renders nothing it was not given. Rates arrive computed, money arrives as a
 * decimal string, and a null is drawn as "—" rather than as a zero — a desk with no
 * resolved conversation this month has no median resolution time, and inventing 0 for it
 * would be a lie a reader cannot see through.
 *
 * Reached only by someone holding `usage:read`, which the shell learns by asking rather
 * than by decoding a token; an agent never sees the nav item, and would get a 403 here.
 */
import { useEffect, useState } from 'react';
import type { Capabilities, View } from '../App.js';
import { api } from '../api.js';
import { Avatar, Empty } from '../ui.js';

/** The windows a person actually asks for. Days, so the label and the maths agree. */
const RANGES: { days: number; label: string }[] = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

type Metrics = Awaited<ReturnType<typeof api.deskMetrics>>;

/** Seconds as something a person reads at a glance, never as a raw count. */
function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

const percent = (rate: number | null): string => (rate === null ? '—' : `${Math.round(rate * 100)}%`);

export function Reports({ caps }: { caps: Capabilities | null }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Metrics | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!caps?.money) return;
    let live = true;
    setData(null);
    setFailed(false);
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    void api
      .deskMetrics({ from: from.toISOString(), to: to.toISOString() })
      .then((d) => live && setData(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [caps?.money, days]);

  if (!caps?.money)
    return (
      <div className="frame" style={{ width: 720 }}>
        <Empty
          title="Reporting is the desk admin's"
          note="Your account does not hold `usage:read`. Cost has one door, and the numbers derived from it use the same one."
        />
      </div>
    );

  return (
    <div className="frame" style={{ width: 960, maxWidth: '100%', padding: 22, background: 'var(--surface)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 18 }}>
        <div>
          <div className="t-page">Reports</div>
          <div className="t-meta" style={{ marginTop: 4 }}>
            What the desk did, and what the assistant settled
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {RANGES.map((r) => (
            <button
              key={r.days}
              className="btn btn-ghost"
              onClick={() => setDays(r.days)}
              style={{
                background: r.days === days ? 'var(--nav-active)' : 'transparent',
                fontWeight: r.days === days ? 600 : 500,
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {failed ? (
        <Empty title="The report could not be read" note="Try again, or check the desk is reachable." />
      ) : !data ? (
        <div className="t-meta">Loading…</div>
      ) : (
        <>
          <Assistant data={data} />
          <Speed data={data} />
          <Volume data={data} />
          <Backlog data={data} />
          <People data={data} />
        </>
      )}
    </div>
  );
}

/* ── The headline ───────────────────────────────────────────────────────────── */

function Assistant({ data }: { data: Metrics }) {
  const a = data.assistant;
  return (
    <section style={{ marginBottom: 22 }}>
      <SectionHead
        title="The assistant"
        note={`${a.turns.toLocaleString()} turns · ${a.currency} ${Number(a.cost).toFixed(4)} spent`}
      />
      <div className="card" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', overflow: 'hidden' }}>
        <Stat label="Deflected" value={percent(a.deflectionRate)} note={`${a.answered} answered outright`} lead />
        <Stat label="Escalated" value={percent(a.escalationRate)} note={`${a.escalated} handed to a person`} />
        <Stat label="Failed" value={percent(a.failureRate)} note={`${a.failed} never produced anything`} />
        <Stat
          label="Cost / resolved"
          value={a.costPerResolved === null ? '—' : `${Number(a.costPerResolved).toFixed(4)}`}
          note={`${a.currency} · ${data.volume.resolved} resolved`}
        />
      </div>
      <div className="t-small" style={{ marginTop: 8, lineHeight: 1.6, color: 'var(--secondary)' }}>
        {a.drafted.toLocaleString()} more turns were only <em>drafted</em> — a person still read and
        sent those, so they count as neither deflected nor escalated.
      </div>
    </section>
  );
}

/* ── Speed ──────────────────────────────────────────────────────────────────── */

function Speed({ data }: { data: Metrics }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <SectionHead title="Speed" note="Measured on the conversations whose reply or resolution fell in this window" />
      <div className="card" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', overflow: 'hidden' }}>
        <Stat
          label="First response, median"
          value={duration(data.firstResponse.medianSeconds)}
          note={`${data.firstResponse.measured} measured`}
          lead
        />
        <Stat label="First response, p90" value={duration(data.firstResponse.p90Seconds)} />
        <Stat
          label="Resolution, median"
          value={duration(data.resolution.medianSeconds)}
          note={`${data.resolution.measured} measured`}
        />
        <Stat label="Resolution, p90" value={duration(data.resolution.p90Seconds)} />
      </div>
    </section>
  );
}

/* ── Volume ─────────────────────────────────────────────────────────────────── */

function Volume({ data }: { data: Metrics }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <SectionHead
        title="Volume"
        note={`${data.volume.opened.toLocaleString()} opened · ${data.volume.resolved.toLocaleString()} resolved`}
      />
      <div className="card" style={{ overflow: 'hidden' }}>
        <Row head cells={['Channel', 'Opened', 'Resolved']} />
        {data.volume.byChannel.length === 0 ? (
          <div className="t-meta" style={{ padding: '11px 14px' }}>
            Nothing arrived in this window.
          </div>
        ) : (
          data.volume.byChannel.map((c) => (
            <Row
              key={c.channel}
              cells={[c.channel, c.opened.toLocaleString(), c.resolved.toLocaleString()]}
            />
          ))
        )}
      </div>
    </section>
  );
}

/* ── Backlog ────────────────────────────────────────────────────────────────── */

function Backlog({ data }: { data: Metrics }) {
  const b = data.backlog;
  return (
    <section style={{ marginBottom: 22 }}>
      {/* Deliberately says "right now": the backlog does not move when the range does. */}
      <SectionHead title="Backlog" note="Right now — not for the selected window" />
      <div className="card" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', overflow: 'hidden' }}>
        <Stat label="Open" value={b.open.toLocaleString()} lead />
        <Stat label="Snoozed" value={b.snoozed.toLocaleString()} />
        <Stat label="Unassigned" value={b.unassigned.toLocaleString()} />
        <Stat
          label="Oldest untouched"
          value={duration(b.oldestUntouchedAgeSeconds)}
          note={b.oldestUntouchedId ? 'since anyone last touched it' : undefined}
        />
      </div>
    </section>
  );
}

/* ── People ─────────────────────────────────────────────────────────────────── */

function People({ data }: { data: Metrics }) {
  return (
    <section>
      <SectionHead title="People" note="Conversations resolved, and public replies sent — internal notes are not replies" />
      <div className="card" style={{ overflow: 'hidden' }}>
        <Row head cells={['Agent', 'Resolved', 'Replies']} />
        {data.agents.length === 0 ? (
          <div className="t-meta" style={{ padding: '11px 14px' }}>
            Nobody resolved or replied in this window.
          </div>
        ) : (
          data.agents.map((a) => (
            <Row
              key={a.principal}
              cells={[
                <span key="n" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Avatar name={a.displayName ?? a.principal} size={20} />
                  {a.displayName ?? a.principal}
                </span>,
                a.resolved.toLocaleString(),
                a.replies.toLocaleString(),
              ]}
            />
          ))
        )}
      </div>
      <div style={{ marginTop: 22 }}>
        <SectionHead title="Satisfaction" note="What customers said when asked" />
        <div className="card" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', overflow: 'hidden' }}>
          <Stat
            label="Average score"
            value={data.csat.average === null ? '—' : `${data.csat.average.toFixed(1)} / 5`}
            lead
          />
          <Stat label="Responses" value={data.csat.responses.toLocaleString()} />
        </div>
      </div>
    </section>
  );
}

/* ── Pieces ─────────────────────────────────────────────────────────────────── */

function SectionHead({ title, note }: { title: string; note?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
      <div className="t-strong">{title}</div>
      {note ? <div className="t-meta">{note}</div> : null}
    </div>
  );
}

function Stat({
  label,
  value,
  note,
  lead = false,
}: {
  label: string;
  value: string;
  note?: string;
  lead?: boolean;
}) {
  return (
    <div style={{ padding: '13px 14px', borderLeft: lead ? 0 : '1px solid var(--row-line)' }}>
      <div className="micro" style={{ color: 'var(--muted)' }}>
        {label}
      </div>
      <div style={{ font: "600 21px 'Geist Mono', monospace", letterSpacing: '-.02em', margin: '5px 0 3px' }}>
        {value}
      </div>
      {note ? <div className="t-small">{note}</div> : null}
    </div>
  );
}

function Row({ cells, head = false }: { cells: React.ReactNode[]; head?: boolean }) {
  return (
    <div
      className={head ? 'micro-6' : undefined}
      style={{
        display: 'grid',
        gridTemplateColumns: '1.6fr 120px 120px',
        gap: '0 12px',
        alignItems: 'center',
        padding: head ? '9px 14px' : '11px 14px',
        color: head ? 'var(--muted)' : undefined,
        borderTop: head ? undefined : '1px solid var(--row-line)',
      }}
    >
      {cells.map((c, i) => (
        <div key={i} style={{ textAlign: i === 0 ? 'left' : 'right' }}>
          {c}
        </div>
      ))}
    </div>
  );
}
