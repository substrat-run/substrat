import { useCallback, useEffect, useState } from 'react';
import {
  api,
  extra,
  type BillableLine,
  type Money,
  type Repair,
  type TimelineEntry,
} from '../api';
import { StatusPill } from './Repairs';
import { ConditionReportPanel } from './ConditionReport';

const STEPS: Repair['status'][] = ['planned', 'in_progress', 'completed', 'closed'];
const STEP_LABEL: Record<string, string> = {
  planned: 'Inlämnad',
  in_progress: 'Pågår',
  completed: 'Klar',
  closed: 'Uthämtad',
};

function StatusFlow({ status }: { status: Repair['status'] }) {
  const idx = STEPS.indexOf(status);
  return (
    <div className="statusflow">
      {STEPS.map((s, i) => (
        <span key={s} style={{ display: 'contents' }}>
          {i > 0 && <span className="arrow">→</span>}
          <span className={`step ${i < idx ? 'done' : i === idx ? 'current' : ''}`}>
            {STEP_LABEL[s]}
          </span>
        </span>
      ))}
    </div>
  );
}

function money(m: Money | { amount: string; currency?: string }): string {
  return `${m.amount} ${'currency' in m && m.currency ? m.currency : 'SEK'}`;
}

export function RepairDetailView({ repairId }: { repairId: string }) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.workorderGet>> | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [error, setError] = useState('');
  const [hours, setHours] = useState('0.5');
  const [article, setArticle] = useState('sb:innerslang-28');
  const [qty, setQty] = useState('1');
  const [mechanic, setMechanic] = useState('');
  const [billed, setBilled] = useState<{ billable: BillableLine[]; total: Money } | null>(null);

  const load = useCallback(() => {
    api.workorderGet({ orderId: repairId }).then(setDetail).catch((e: Error) => setError(e.message));
    extra.timeline(repairId).then(setTimeline).catch(() => setTimeline([]));
  }, [repairId]);
  useEffect(load, [load]);

  const act = (fn: () => Promise<unknown>) => async () => {
    setError('');
    try {
      await fn();
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error && !detail) return <div className="alert error">{error}</div>;
  if (!detail) return <p className="muted">Laddar…</p>;
  const { order, time, material } = detail;

  return (
    <>
      <a href="#/" className="muted" style={{ textDecoration: 'none' }}>
        ← Alla reparationer
      </a>
      <div className="row" style={{ margin: '8px 0 0' }}>
        <h1 className="grow">
          #{order.number} — {order.title}
        </h1>
        <StatusPill status={order.status} />
      </div>
      <StatusFlow status={order.status} />
      {error && <div className="alert error">{error}</div>}

      <div className="card">
        <h2>Åtgärder</h2>
        <div className="row">
          {order.status === 'planned' && (
            <>
              {/*
                A free-text field, not a picker, and deliberately — the same treatment
                `callout/OrderDetail` gives the identical problem. The dropdown used to be
                filled from the dev server's persona cast, which made it work locally and
                nowhere else: a hosted install has no cast, so it rendered empty and
                assignment was impossible. Listing the real mechanics means "which
                principals hold the mechanic role in this scope" — a members API this
                vertical does not have, and a permission surface of its own. Rather than
                keep a picker that works in one environment only, the field says what it is.
              */}
              <input
                style={{ width: 260 }}
                placeholder="Mekaniker (principal-id)"
                value={mechanic}
                onChange={(e) => setMechanic(e.target.value)}
              />
              <button className="btn" disabled={!mechanic} onClick={act(() => api.workorderAssign({ orderId: repairId, technician: mechanic }))}>
                Tilldela
              </button>
              <button className="btn primary" onClick={act(() => api.workorderStart({ orderId: repairId }))}>
                Påbörja reparation
              </button>
            </>
          )}
          {(order.status === 'planned' || order.status === 'in_progress') && (
            <>
              <input style={{ width: 70 }} value={hours} onChange={(e) => setHours(e.target.value)} />
              <button className="btn" onClick={act(() => api.workorderReportTime({ orderId: repairId, hours }))}>
                Rapportera tid
              </button>
              <input style={{ width: 180 }} value={article} onChange={(e) => setArticle(e.target.value)} />
              <input style={{ width: 50 }} value={qty} onChange={(e) => setQty(e.target.value)} />
              <button className="btn" onClick={act(() => api.workorderReportMaterial({ orderId: repairId, article, qty }))}>
                Reservdel
              </button>
            </>
          )}
          {order.status === 'in_progress' && (
            <button
              className="btn primary"
              onClick={act(async () => setBilled(await api.completeRepair({ orderId: repairId })))}
            >
              Klarmarkera & prissätt
            </button>
          )}
          {order.status === 'completed' && (
            <button className="btn primary" onClick={act(() => api.closeRepair({ orderId: repairId }))}>
              Lämna ut cykeln
            </button>
          )}
        </div>
      </div>

      {billed && (
        <div className="card">
          <h2>Prissatt klarmarkering</h2>
          <table className="grid sheet">
            <thead>
              <tr>
                <th>Artikel</th>
                <th>Beskrivning</th>
                <th className="right">Antal</th>
                <th className="right">À-pris</th>
                <th className="right">Summa</th>
              </tr>
            </thead>
            <tbody>
              {billed.billable.map((b, i) => (
                <tr key={i}>
                  <td>{b.article}</td>
                  <td>{b.description}</td>
                  <td className="num">
                    {b.qty} {b.unit}
                  </td>
                  <td className="num">{money(b.unitPrice)}</td>
                  <td className="num">{money(b.lineTotal)}</td>
                </tr>
              ))}
              <tr className="total">
                <td colSpan={4}>Totalt</td>
                <td className="num">{money(billed.total)}</td>
              </tr>
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 12 }}>
            Minsta debitering (0,5 tim) tillämpad, verkstadsmaterial borttaget. Raderna är nu
            snapshottade i fakturaunderlaget — redigera reparationen ändrar dem aldrig.
          </p>
        </div>
      )}

      <ConditionReportPanel repair={order} />

      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="card grow">
          <h2>Rapporterad tid</h2>
          <table className="grid">
            <tbody>
              {time.map((t) => (
                <tr key={t.id}>
                  <td>{t.hours} tim</td>
                  <td className="muted">{t.note ?? ''}</td>
                </tr>
              ))}
              {time.length === 0 && (
                <tr>
                  <td className="muted">Ingen tid rapporterad</td>
                </tr>
              )}
            </tbody>
          </table>
          <h2 style={{ marginTop: 16 }}>Reservdelar</h2>
          <table className="grid">
            <tbody>
              {material.map((m) => (
                <tr key={m.id}>
                  <td>{m.article}</td>
                  <td className="num">{m.qty} st</td>
                </tr>
              ))}
              {material.length === 0 && (
                <tr>
                  <td className="muted">Inga reservdelar</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="card grow">
          <h2>Händelser (event spine)</h2>
          <ul className="timeline">
            {timeline.map((e) => (
              <li key={e.id}>
                {e.type}
                <span className="when">{new Date(e.occurredAt).toLocaleTimeString('sv-SE')}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}
