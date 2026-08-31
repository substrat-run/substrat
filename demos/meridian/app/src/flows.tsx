import { useEffect, useState } from 'react';
import { api, ApiError, fmtMoney } from './api';
import type { AppData } from './data';
import { fmtDate, todayISO, workingDays } from './data';
import { Button, Stepper, TypeDot } from './ui';

export interface FlowProps {
  d: AppData;
  onClose: () => void;
  onDone: (msg: string) => void;
}

function FlowHeader({ title, onClose, back }: { title: string; onClose: () => void; back?: boolean }) {
  return (
    <div className="flow-hdr">
      <button className="cancel" onClick={onClose}>
        {back ? 'Back' : 'Cancel'}
      </button>
      <div className="flow-title">{title}</div>
    </div>
  );
}

function useSubmit(onDone: (m: string) => void) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>, msg: string) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onDone(msg);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };
  return { busy, err, run };
}

// -- Request time off --------------------------------------------------------

export function RequestLeave({ d, onClose, onDone }: FlowProps) {
  const eid = d.me.employeeId!;
  const types = d.leaveTypes;
  const [typeKey, setTypeKey] = useState(types.find((t) => t.kind === 'vacation')?.key ?? types[0]?.key ?? '');
  const [start, setStart] = useState(todayISO());
  const [end, setEnd] = useState(todayISO());
  const { busy, err, run } = useSubmit(onDone);

  const days = workingDays(start, end);
  const lt = types.find((t) => t.key === typeKey);
  const bal = d.balance?.balances.find((b) => b.leaveTypeKey === typeKey);
  const before = bal ? Number(bal.balance) : null;
  const after = before !== null ? before - days : null;

  return (
    <>
      <FlowHeader title="New request" onClose={onClose} />
      <div className="flow-scroll">
        {err && <div className="err-banner">{err}</div>}

        <div className="section-label" style={{ marginTop: 0 }}>Type</div>
        <div className="grid2">
          {types.map((t) => {
            const sel = t.key === typeKey;
            return (
              <button
                key={t.key}
                onClick={() => setTypeKey(t.key)}
                className="card"
                style={{ margin: 0, padding: 14, display: 'flex', alignItems: 'center', gap: 10, borderWidth: sel ? 2 : 1, borderColor: sel ? `var(--lt-${dotVar(t.kind)})` : 'var(--card-border)' }}
              >
                <TypeDot kind={t.kind} />
                <span style={{ fontWeight: sel ? 600 : 500, color: sel ? 'var(--ink)' : 'var(--muted)' }}>{t.label}</span>
              </button>
            );
          })}
        </div>

        <div className="section-label">Dates</div>
        <div className="card tight">
          <DateRow label="From" value={start} onChange={setStart} />
          <DateRow label="To" value={end} onChange={setEnd} />
          <div className="row" style={{ background: 'var(--panel-bg)' }}>
            <div className="row-title faint">Working days</div>
            <div className="spacer" />
            <div className="num" style={{ fontWeight: 700 }}>{days}</div>
          </div>
        </div>

        {before !== null && lt?.annual_days && (
          <div style={{ background: 'var(--accent-tint)', borderRadius: 16, padding: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent-dark)' }}>Balance after this request</div>
            <div className="num" style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
              <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--muted)' }}>{before}</span>
              <span className="faint">→</span>
              <span style={{ fontSize: 22, fontWeight: 700, color: after! < 0 ? 'var(--destructive)' : 'var(--ink)' }}>{after}</span>
              <span className="faint" style={{ fontSize: 13 }}>days left</span>
            </div>
          </div>
        )}
      </div>

      <div className="bottom-cta">
        <Button
          disabled={busy || days === 0 || (after !== null && after < 0) || !typeKey}
          onClick={() =>
            run(async () => {
              await api.requestLeave({ employeeId: eid, leaveTypeKey: typeKey, startDate: start, endDate: end, days: String(days) });
            }, 'Request sent for approval')
          }
        >
          Send request
        </Button>
        <div className="cta-caption">Goes to your manager for approval · usually within a day</div>
      </div>
    </>
  );
}

function DateRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="row" style={{ position: 'relative', cursor: 'pointer' }}>
      <div className="row-title faint">{label}</div>
      <div className="spacer" />
      <span style={{ fontSize: 15, fontWeight: 600 }}>{fmtDate(value)}</span>
      {/* Transparent input covers the whole row so a tap anywhere opens the
          native picker; showPicker() also opens it on desktop click. */}
      <input
        type="date"
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        onClick={(e) => (e.currentTarget as HTMLInputElement & { showPicker?: () => void }).showPicker?.()}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer', border: 'none' }}
      />
    </div>
  );
}

// -- Log time ----------------------------------------------------------------

export function LogTime({ d, onClose, onDone }: FlowProps) {
  const eid = d.me.employeeId!;
  const [hours, setHours] = useState(8);
  const [workDate, setWorkDate] = useState(todayISO());
  const [projectId, setProjectId] = useState(d.projects[0]?.id ?? '');
  const { busy, err, run } = useSubmit(onDone);

  return (
    <>
      <FlowHeader title="Log time" onClose={onClose} />
      <div className="flow-scroll">
        {err && <div className="err-banner">{err}</div>}
        <div className="card tight">
          <DateRow label="Date" value={workDate} onChange={setWorkDate} />
        </div>

        <div className="card" style={{ padding: '22px 16px' }}>
          <Stepper value={hours} onChange={setHours} />
        </div>

        <div className="section-label">Project</div>
        <div className="card tight">
          {d.projects.map((p) => {
            const sel = p.id === projectId;
            return (
              <button key={p.id} className="row" style={{ width: '100%', textAlign: 'left', background: 'none' }} onClick={() => setProjectId(p.id)}>
                <span style={{ width: 20, height: 20, borderRadius: 999, border: `${sel ? 6 : 1.5}px solid ${sel ? 'var(--accent)' : 'var(--fainter)'}`, flex: 'none' }} />
                <span style={{ fontSize: 15, fontWeight: sel ? 600 : 500 }}>{p.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="bottom-cta">
        <Button
          disabled={busy || hours <= 0}
          onClick={() =>
            run(async () => {
              await api.logTime({ employeeId: eid, projectId: projectId || undefined, workDate, hours: hours.toFixed(1) });
            }, `Logged ${hours.toFixed(1)} h`)
          }
        >
          Add {hours.toFixed(1)} h to today
        </Button>
        <div className="cta-caption">Entries can't be edited — add a correction instead</div>
      </div>
    </>
  );
}

// -- Submit expense (camera-first) ------------------------------------------

const CATEGORIES = ['travel', 'meals', 'equipment', 'other'];

export function SubmitExpense({ d, onClose, onDone }: FlowProps) {
  const eid = d.me.employeeId!;
  const currency = d.me.country === 'ES' ? 'EUR' : 'SEK';
  const [captured, setCaptured] = useState(false);
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('travel');
  const [note, setNote] = useState('');
  const { busy, err, run } = useSubmit(onDone);

  return (
    <>
      <FlowHeader title="New expense" onClose={onClose} />
      <div className="flow-scroll">
        {err && <div className="err-banner">{err}</div>}

        <button
          onClick={() => setCaptured(true)}
          style={{ width: '100%', height: 190, borderRadius: 20, background: 'repeating-linear-gradient(135deg,#1b2730,#1b2730 8px,#22303a 8px,#22303a 16px)', color: '#cdd8df', display: 'grid', placeItems: 'center', marginBottom: 16, position: 'relative' }}
        >
          <div style={{ position: 'absolute', inset: 20, border: '3px solid rgba(255,255,255,0.6)', borderRadius: 8, clipPath: 'polygon(0 0,26px 0,26px 3px,3px 3px,3px 26px,0 26px, 0 100%,26px 100%,26px calc(100% - 3px),3px calc(100% - 3px),3px calc(100% - 26px),0 calc(100% - 26px), 100% 100%,calc(100% - 26px) 100%,calc(100% - 26px) calc(100% - 3px),calc(100% - 3px) calc(100% - 3px),calc(100% - 3px) calc(100% - 26px),100% calc(100% - 26px), 100% 0,calc(100% - 26px) 0,calc(100% - 26px) 3px,calc(100% - 3px) 3px,calc(100% - 3px) 26px,100% 26px)' }} />
          <span style={{ fontSize: 14, fontWeight: 600 }}>{captured ? '✓ Receipt captured' : 'Tap to capture receipt'}</span>
        </button>

        <div className="card tight">
          <label className="row">
            <div className="row-title faint">Amount</div>
            <div className="spacer" />
            <input
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
              style={{ textAlign: 'right', border: 'none', background: 'none', fontSize: 22, fontWeight: 700, width: 120, color: 'var(--ink)' }}
              className="num"
            />
            <span className="faint" style={{ marginLeft: 4 }}>{currency}</span>
          </label>
        </div>

        <div className="section-label">Category</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {CATEGORIES.map((cat) => {
            const sel = cat === category;
            return (
              <button
                key={cat}
                onClick={() => setCategory(cat)}
                style={{ padding: '9px 16px', borderRadius: 999, fontSize: 14, fontWeight: 500, textTransform: 'capitalize', background: sel ? 'var(--accent)' : 'var(--card)', color: sel ? 'var(--btn-fg)' : 'var(--muted)', border: `1px solid ${sel ? 'var(--accent)' : 'var(--card-border)'}` }}
              >
                {cat}
              </button>
            );
          })}
        </div>

        <div className="section-label">Note (optional)</div>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What was it for?"
          style={{ width: '100%', padding: '12px 14px', borderRadius: 14, border: '1px solid var(--card-border)', background: 'var(--card)', color: 'var(--ink)', fontSize: 15 }}
        />
      </div>

      <div className="bottom-cta">
        <Button
          disabled={busy || !amount || Number(amount) <= 0}
          onClick={() =>
            run(async () => {
              await api.submitExpense({
                employeeId: eid,
                description: note || `${category.slice(0, 1).toUpperCase()}${category.slice(1)} expense`,
                amount: String(Number(amount)),
                currency,
                category,
              });
            }, `Submitted ${fmtMoney(String(Number(amount || '0')), currency)}`)
          }
        >
          Submit
        </Button>
        <div className="cta-caption">Goes to your manager to approve</div>
      </div>
    </>
  );
}

// -- Onboarding e-sign -------------------------------------------------------

export function Onboarding({ d, onClose, onDone }: FlowProps) {
  const ob = d.onboarding!;
  const [items, setItems] = useState(ob.items);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const allDone = items.every((i) => i.done);

  useEffect(() => setItems(ob.items), [ob.instanceId]);

  const tick = async (item: { key: string; label: string; done: boolean }) => {
    if (item.done || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api.fillOnboarding(ob.instanceId, item.key, true);
      setItems((prev) => prev.map((i) => (i.key === item.key ? { ...i, done: true } : i)));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sign = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.signOnboarding(ob.instanceId);
      onDone('Onboarding signed — welcome aboard');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <>
      <FlowHeader title="Getting started" onClose={onClose} back />
      <div className="flow-scroll">
        {err && <div className="err-banner">{err}</div>}
        <div className="card">
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Onboarding checklist</div>
          <div className="row-sub">Tap each item to complete it, then e-sign to finish.</div>
        </div>
        <div className="card tight">
          {items.map((i) => (
            <button key={i.key} className="row" style={{ width: '100%', textAlign: 'left', background: 'none' }} onClick={() => tick(i)}>
              <span
                style={{
                  width: 24, height: 24, borderRadius: 7, flex: 'none', display: 'grid', placeItems: 'center',
                  background: i.done ? 'var(--accent)' : 'transparent',
                  border: `1.5px solid ${i.done ? 'var(--accent)' : 'var(--fainter)'}`,
                  color: '#fff', fontSize: 14,
                }}
              >
                {i.done ? '✓' : ''}
              </span>
              <span style={{ fontSize: 15, fontWeight: 500, color: i.done ? 'var(--muted)' : 'var(--ink)' }}>{i.label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="bottom-cta">
        <Button disabled={!allDone || busy} onClick={sign}>
          {allDone ? 'Sign & finish' : `Complete all ${items.length} tasks to sign`}
        </Button>
        <div className="cta-caption">Signed as {d.me.display} · legally binding e-signature</div>
      </div>
    </>
  );
}

function dotVar(kind: string): string {
  if (kind === 'vacation') return 'vacation';
  if (kind === 'sick' || kind === 'vab' || kind === 'baja') return 'sick';
  if (kind === 'parental') return 'parental';
  return 'unpaid';
}
