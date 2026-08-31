import { useState } from 'react';
import { fmtMoney } from './api';
import { fmtDate, type ManagerData } from './data';

export interface ManageProps {
  d: ManagerData;
  onDecideLeave: (id: string, decision: 'approve' | 'reject', note?: string) => Promise<void>;
  onDecideExpense: (id: string, decision: 'approve' | 'reject') => Promise<void>;
}

function typeClass(kind: string): string {
  if (kind === 'vacation') return 'vacation';
  if (kind === 'sick' || kind === 'vab' || kind === 'baja') return 'sick';
  if (kind === 'parental') return 'parental';
  return 'unpaid';
}
const Dot = ({ kind }: { kind: string }) => <span className={`tdot ${typeClass(kind)}`} />;
function Avatar({ name, lg }: { name: string; lg?: boolean }) {
  const initials = name.split(' ').map((p) => p[0]).slice(0, 2).join('');
  return <span className={`avatar${lg ? ' lg' : ''}`}>{initials}</span>;
}
const empName = (d: ManagerData, id: string) => d.roster.find((r) => r.id === id)?.name ?? 'Unknown';
const kindOf = (d: ManagerData, key: string) => d.leaveTypes.find((t) => t.key === key)?.kind ?? key;
const leaveLabel = (d: ManagerData, key: string) => d.leaveTypes.find((t) => t.key === key)?.label ?? key;
const today = () => new Date().toISOString().slice(0, 10);

function DeclineDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Decline with reason</div>
        <div className="muted" style={{ fontSize: 13, marginBottom: 12 }}>The requester is notified either way.</div>
        <textarea
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this declined?"
          style={{ width: '100%', minHeight: 90, padding: 12, borderRadius: 12, border: '1px solid var(--card-border)', background: 'var(--bg)', color: 'var(--ink)', fontSize: 14, resize: 'vertical' }}
        />
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn sm tint" onClick={onCancel}>Cancel</button>
          <button className="btn sm" disabled={!reason.trim()} onClick={() => onConfirm(reason.trim())} style={{ background: 'var(--destructive)', color: '#fff' }}>Decline</button>
        </div>
      </div>
    </div>
  );
}

function Stat({ num, label, accent }: { num: number; label: string; accent?: boolean }) {
  return (
    <div className="card stat">
      <div className="stat-num num" style={accent ? { color: 'var(--accent)' } : undefined}>{num}</div>
      <div className="stat-lbl">{label}</div>
    </div>
  );
}

export function Inbox({ d, onDecideLeave, onDecideExpense }: ManageProps) {
  const [filter, setFilter] = useState<'all' | 'timeoff' | 'expenses'>('all');
  const [declining, setDeclining] = useState<string | null>(null);
  const pendingReq = d.requests.filter((r) => r.status === 'requested');
  const pendingExp = d.expenses.filter((e) => e.status === 'submitted');
  const outToday = d.requests.filter((r) => r.status === 'approved' && r.start_date <= today() && r.end_date >= today());
  const onboarding = Object.values(d.onboarding).filter((o) => o && o.instance.status === 'open').length;
  const showReq = filter === 'all' || filter === 'timeoff';
  const showExp = filter === 'all' || filter === 'expenses';

  return (
    <>
      <h1 className="page-title">Inbox</h1>
      <div className="page-sub">Manage · {d.dept}</div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', marginBottom: 22 }}>
        <Stat num={pendingReq.length + pendingExp.length} label="Waiting for approval" accent />
        <Stat num={outToday.length} label="Out today" />
        <Stat num={d.roster.length} label="Team members" />
        <Stat num={onboarding} label="Onboarding" />
      </div>
      <div className="pill-filter">
        {(['all', 'timeoff', 'expenses'] as const).map((f) => (
          <button key={f} className={`pill${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'timeoff' ? 'Time off' : 'Expenses'}
          </button>
        ))}
      </div>
      <div className="card">
        {pendingReq.length === 0 && pendingExp.length === 0 && (
          <div className="muted" style={{ fontSize: 14, padding: 6 }}>Nothing waiting. You're all caught up.</div>
        )}
        {showReq && pendingReq.map((r) => (
          <div className="row" key={r.id}>
            <Avatar name={empName(d, r.employee_id)} />
            <Dot kind={kindOf(d, r.leave_type_key)} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{empName(d, r.employee_id)} · {leaveLabel(d, r.leave_type_key)}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>{fmtDate(r.start_date)} – {fmtDate(r.end_date)} · {r.days}d</div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button className="btn sm tint" onClick={() => setDeclining(`leave:${r.id}`)}>Decline</button>
              <button className="btn sm" onClick={() => onDecideLeave(r.id, 'approve')}>Approve</button>
            </div>
          </div>
        ))}
        {showExp && pendingExp.map((e) => (
          <div className="row" key={e.id}>
            <Avatar name={empName(d, e.employee_id)} />
            <span style={{ width: 11 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{empName(d, e.employee_id)} · {e.description}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>{fmtMoney(e.amount, e.currency)} · {e.category}</div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button className="btn sm tint" onClick={() => setDeclining(`exp:${e.id}`)}>Decline</button>
              <button className="btn sm" onClick={() => onDecideExpense(e.id, 'approve')}>Approve</button>
            </div>
          </div>
        ))}
      </div>
      {declining && (
        <DeclineDialog
          onCancel={() => setDeclining(null)}
          onConfirm={async (reason) => {
            const sep = declining.indexOf(':');
            const kind = declining.slice(0, sep);
            const id = declining.slice(sep + 1);
            if (kind === 'leave') await onDecideLeave(id, 'reject', reason);
            else await onDecideExpense(id, 'reject');
            setDeclining(null);
          }}
        />
      )}
    </>
  );
}

export function TeamCalendar({ d }: ManageProps) {
  const days = businessDaysOfMonth();
  const relevant = d.requests.filter((r) => r.status === 'approved' || r.status === 'requested');
  return (
    <>
      <h1 className="page-title">Team calendar</h1>
      <div className="page-sub">Who's away this month · leave type only, never medical detail</div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 14, fontSize: 12.5 }} className="muted">
        <span><span className="tdot vacation" style={{ display: 'inline-block', marginRight: 4 }} /> Vacation</span>
        <span><span className="tdot sick" style={{ display: 'inline-block', marginRight: 4 }} /> Sick</span>
        <span>▨ striped = pending</span>
      </div>
      <div className="card scroll-x">
        <table className="table">
          <thead>
            <tr>
              <th style={{ minWidth: 130 }}>Person</th>
              {days.map((day) => (
                <th key={day} style={{ textAlign: 'center', padding: '8px 2px' }}>{new Date(day + 'T00:00:00').getDate()}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.roster.map((m) => (
              <tr key={m.id}>
                <td style={{ fontWeight: 500 }}>{m.name}</td>
                {days.map((day) => {
                  const req = relevant.find((r) => r.employee_id === m.id && day >= r.start_date && day <= r.end_date);
                  const kind = req ? kindOf(d, req.leave_type_key) : null;
                  const color = kind ? `var(--lt-${typeClass(kind)})` : 'var(--bg)';
                  const pending = req?.status === 'requested';
                  return (
                    <td key={day} style={{ padding: 3, textAlign: 'center' }}>
                      <span className="cal-cell" style={{ background: pending ? `repeating-linear-gradient(135deg, ${color}, ${color} 3px, transparent 3px, transparent 6px)` : color }} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function Timesheets({ d }: ManageProps) {
  return (
    <>
      <h1 className="page-title">Timesheets</h1>
      <div className="page-sub">Logged hours · corrections append, never overwrite</div>
      <div className="card scroll-x">
        <table className="table">
          <thead>
            <tr><th>Person</th><th style={{ textAlign: 'right' }}>Total hours</th><th style={{ textAlign: 'right' }}>Entries</th><th /></tr>
          </thead>
          <tbody>
            {d.roster.map((m) => {
              const ts = d.timesheets[m.id];
              const total = ts ? Number(ts.totalHours) : 0;
              const n = ts?.entries.length ?? 0;
              return (
                <tr key={m.id}>
                  <td style={{ fontWeight: 500 }}>{m.name}</td>
                  <td className="num" style={{ textAlign: 'right', fontWeight: 700 }}>{total} h</td>
                  <td className="num muted" style={{ textAlign: 'right' }}>{n}</td>
                  <td style={{ textAlign: 'right' }}><span className={`chip ${n === 0 ? 'pending' : 'approved'}`}>{n === 0 ? 'No hours' : 'Logged'}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function OnboardingView({ d }: ManageProps) {
  const cards = d.roster.map((m) => ({ m, ob: d.onboarding[m.id] })).filter((x) => x.ob);
  return (
    <>
      <h1 className="page-title">Onboarding</h1>
      <div className="page-sub">
        New hires and their progress · checklists update live, contracts wait on signatures
      </div>
      {cards.length === 0 && <div className="card muted" style={{ fontSize: 14 }}>No one onboarding right now.</div>}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))' }}>
        {cards.map(({ m, ob }) => {
          const done = ob!.answered;
          const total = ob!.total;
          const status = ob!.instance.status;
          const signed = status === 'signed';
          const pending = status === 'pending_signature';
          // A document (the anställningsavtal) is not a progress bar — it is
          // frozen and waiting on signatures, possibly from someone who has no
          // account here yet. Showing "0/1" would misdescribe that entirely.
          const isDoc = ob!.contentKind === 'document';
          const chip = signed ? 'Signed' : isDoc ? (pending ? 'Out for signature' : 'Draft') : `${done}/${total}`;
          const note = signed
            ? isDoc
              ? 'Signed by both parties.'
              : 'Onboarding complete.'
            : isDoc
              ? pending
                ? `Frozen at Scrive · ${ob!.pendingSignatures} signature${ob!.pendingSignatures === 1 ? '' : 's'} outstanding`
                : 'Contract drafted, not yet sent.'
              : 'Waiting on the employee to finish and e-sign.';
          return (
            <div className="card" key={m.id}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                <Avatar name={m.name} lg />
                <div>
                  <div style={{ fontWeight: 600 }}>{m.name}</div>
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    {m.started_at ? `Started ${m.started_at}` : 'Not started yet'}
                  </div>
                </div>
                <span className={`chip ${signed ? 'approved' : pending ? 'tint' : 'tint'}`} style={{ marginLeft: 'auto' }}>{chip}</span>
              </div>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>{ob!.title}</div>
              {!isDoc && (
                <div style={{ height: 6, borderRadius: 99, background: 'var(--track)' }}>
                  <div style={{ height: 6, borderRadius: 99, background: 'var(--accent)', width: `${(done / Math.max(1, total)) * 100}%` }} />
                </div>
              )}
              <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>{note}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function Team({ d }: ManageProps) {
  const today0 = today();
  const statusOf = (id: string): { label: string; chip: string } => {
    const away = d.requests.find((r) => r.status === 'approved' && r.employee_id === id && r.start_date <= today0 && r.end_date >= today0);
    if (away) return { label: 'Vacation', chip: 'tint' };
    if (d.onboarding[id]?.instance.status === 'open') return { label: 'Onboarding', chip: 'queued' };
    return { label: 'Working', chip: 'approved' };
  };
  return (
    <>
      <h1 className="page-title">Team</h1>
      <div className="page-sub">{d.dept} · {d.roster.length} people · employment facts only, no compensation</div>
      <div className="card scroll-x">
        <table className="table">
          <thead>
            <tr><th>Person</th><th>Number</th><th>Started</th><th style={{ textAlign: 'right' }}>Today</th></tr>
          </thead>
          <tbody>
            {d.roster.map((m) => {
              const s = statusOf(m.id);
              return (
                <tr key={m.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <Avatar name={m.name} />
                      <div>
                        <div style={{ fontWeight: 500 }}>{m.name}</div>
                        <div className="muted" style={{ fontSize: 12 }}>{m.email ?? '—'}</div>
                      </div>
                    </div>
                  </td>
                  <td className="muted num">{m.number}</td>
                  <td className="muted">{m.started_at ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}><span className={`chip ${s.chip}`}>{s.label}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function businessDaysOfMonth(): string[] {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const days: string[] = [];
  const last = new Date(y, m + 1, 0).getDate();
  for (let day = 1; day <= last; day++) {
    const w = new Date(y, m, day).getDay();
    if (w !== 0 && w !== 6) days.push(`${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  return days;
}
