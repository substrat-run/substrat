import { useCallback, useEffect, useState } from 'react';
import {
  api,
  extra,
  type BillableLine,
  type Money,
  type TimelineEntry,
  type WorkOrder,
} from '../api';
import { StatusPill } from './Orders';
import { ProtocolPanel } from './Protocols';

const STEPS: WorkOrder['status'][] = ['planned', 'in_progress', 'completed', 'closed'];
const STEP_LABEL: Record<string, string> = {
  planned: 'Planerad',
  in_progress: 'Pågår',
  completed: 'Åtgärdad',
  closed: 'Avslutad',
};

function StatusFlow({ status }: { status: WorkOrder['status'] }) {
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

export function OrderDetailView({ orderId }: { orderId: string }) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.workorderGet>> | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [error, setError] = useState('');
  const [hours, setHours] = useState('1');
  const [article, setArticle] = useState('mat:fan-motor-15w');
  const [qty, setQty] = useState('1');
  const [technician, setTechnician] = useState('');
  const [billed, setBilled] = useState<{ billable: BillableLine[]; total: Money } | null>(null);

  const load = useCallback(() => {
    api.workorderGet({ orderId }).then(setDetail).catch((e: Error) => setError(e.message));
    extra.timeline(orderId).then(setTimeline).catch(() => setTimeline([]));
  }, [orderId]);
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
        ← Alla work order
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
                A principal id, typed. This was a `<select>` over the dev server's persona
                cast — which meant the list only ever existed locally: a HOSTED Callout got
                `{}` and could not assign at all. Callout has no member roster to read
                (neither the kernel nor the identity store exposes "who holds this role in
                this scope"), so rather than keep a picker that works in one environment
                only, the field says what it is. Giving it a real list is a members API of
                its own — see the note in the change that removed the cast.
              */}
              <input
                style={{ width: 260 }}
                placeholder="Tekniker (principal-id)"
                value={technician}
                onChange={(e) => setTechnician(e.target.value)}
              />
              <button className="btn" disabled={!technician} onClick={act(() => api.workorderAssign({ orderId, technician }))}>
                Tilldela
              </button>
              <button className="btn primary" onClick={act(() => api.workorderStart({ orderId }))}>
                Starta arbete
              </button>
            </>
          )}
          {(order.status === 'planned' || order.status === 'in_progress') && (
            <>
              <input style={{ width: 70 }} value={hours} onChange={(e) => setHours(e.target.value)} />
              <button className="btn" onClick={act(() => api.workorderReportTime({ orderId, hours }))}>
                Rapportera tid
              </button>
              <input style={{ width: 180 }} value={article} onChange={(e) => setArticle(e.target.value)} />
              <input style={{ width: 50 }} value={qty} onChange={(e) => setQty(e.target.value)} />
              <button className="btn" onClick={act(() => api.workorderReportMaterial({ orderId, article, qty }))}>
                Material
              </button>
            </>
          )}
          {order.status === 'in_progress' && (
            <button
              className="btn primary"
              onClick={act(async () => setBilled(await api.completeWorkorder({ orderId })))}
            >
              Slutför & prissätt
            </button>
          )}
          {order.status === 'completed' && (
            <button className="btn primary" onClick={act(() => api.workorderClose({ orderId }))}>
              Stäng order
            </button>
          )}
        </div>
      </div>

      <ProtocolPanel key={order.status} order={order} />

      {billed && (
        <div className="card">
          <h2>Prissatt slutförande — visar sitt arbete</h2>
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
            Minsta debitering tillämpad, interna artiklar borttagna. Raderna är nu snapshottade
            i fakturaunderlaget — redigera ordern ändrar dem aldrig.
          </p>
        </div>
      )}

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
          <h2 style={{ marginTop: 16 }}>Material</h2>
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
                  <td className="muted">Inget material</td>
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
