import type { ReactNode } from 'react';
import { fmtMoney } from './api';
import type { AppData } from './data';
import { fmtDate } from './data';
import { Button, Chip, Ring, TypeDot, icons, statusChip } from './ui';

export type FlowKind = 'request' | 'log' | 'expense' | 'onboarding';

export interface ScreenProps {
  d: AppData;
  openFlow: (k: FlowKind) => void;
}

function vacation(d: AppData): { remaining: number; total: number; used: number } {
  const lt = d.leaveTypes.find((t) => t.kind === 'vacation');
  const bal = d.balance?.balances.find((b) => b.leaveTypeKey === (lt?.key ?? 'vacation'));
  const remaining = bal ? Number(bal.balance) : 0;
  const total = lt?.annual_days ? Number(lt.annual_days) : remaining;
  return { remaining, total, used: Math.max(0, total - remaining) };
}

function Header({ greet, name }: { greet: string; name: string }) {
  const initials = name.split(' ').map((p) => p[0]).slice(0, 2).join('');
  return (
    <div className="hdr">
      <div>
        <div className="greet">{greet}</div>
        <div className="greet-name">{name.split(' ')[0]}</div>
      </div>
      <div className="avatar">{initials}</div>
    </div>
  );
}

// -- Home --------------------------------------------------------------------

export function Home({ d, openFlow }: ScreenProps) {
  const v = vacation(d);
  const ob = d.onboarding && d.onboarding.status === 'open' ? d.onboarding : null;
  const nextTask = ob?.items.find((i) => !i.done);
  const pendingReq = d.requests.filter((r) => r.status === 'requested');
  const pendingExp = d.expenses.filter((e) => e.status === 'submitted');
  const week = d.timesheet ? Number(d.timesheet.totalHours) : 0;

  return (
    <>
      <Header greet={greeting()} name={d.me.display} />

      {ob && (
        <div className="card hero accent" style={{ paddingBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Getting started</div>
            <div style={{ fontSize: 13, opacity: 0.85 }}>
              {ob.answered} of {ob.total} done
            </div>
          </div>
          <div style={{ height: 6, borderRadius: 99, background: 'rgba(255,255,255,0.25)', margin: '12px 0 14px' }}>
            <div style={{ height: 6, borderRadius: 99, background: '#fff', width: `${(ob.answered / Math.max(1, ob.total)) * 100}%` }} />
          </div>
          {nextTask ? (
            <button
              onClick={() => openFlow('onboarding')}
              style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, background: 'rgba(255,255,255,0.12)', borderRadius: 14, padding: '12px 14px', color: 'inherit' }}
            >
              <span style={{ textAlign: 'left', flex: 1, fontSize: 14, fontWeight: 500 }}>{nextTask.label}</span>
              <span style={{ background: '#fff', color: 'var(--accent)', fontWeight: 600, fontSize: 13, padding: '8px 14px', borderRadius: 10 }}>
                {nextTask.label.toLowerCase().includes('sign') || nextTask.label.toLowerCase().includes('avtal') ? 'Sign' : 'Do'}
              </span>
            </button>
          ) : (
            <Button variant="secondary" onClick={() => openFlow('onboarding')}>
              Review &amp; finish
            </Button>
          )}
        </div>
      )}

      {ob ? (
        <CompactVacation v={v} onRequest={() => openFlow('request')} />
      ) : (
        <VacationHero v={v} onRequest={() => openFlow('request')} />
      )}

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <div>
            <div className="row-sub">This week</div>
            <div className="num" style={{ fontSize: 19, fontWeight: 700 }}>
              {week} h <span className="faint" style={{ fontWeight: 500, fontSize: 14 }}>of 40</span>
            </div>
          </div>
          <div className="spacer" />
          <Button variant="pill" onClick={() => openFlow('log')}>
            + Log today
          </Button>
        </div>
      </div>

      <button className="card" style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left' }} onClick={() => openFlow('expense')}>
        <span style={{ color: 'var(--accent)' }}>{icons.camera}</span>
        <span style={{ flex: 1 }}>
          <span style={{ display: 'block', fontSize: 15, fontWeight: 600 }}>Snap a receipt</span>
          <span className="faint" style={{ fontSize: 12.5 }}>Camera opens straight away</span>
        </span>
        <span className="faint">{icons.chevron}</span>
      </button>

      {(pendingReq.length > 0 || pendingExp.length > 0) && (
        <>
          <div className="section-label">Waiting on</div>
          <div className="card tight">
            {pendingReq.map((r) => (
              <div className="row" key={r.id}>
                <TypeDot kind={leaveKind(d, r.leave_type_key)} />
                <div>
                  <div className="row-title">{leaveLabel(d, r.leave_type_key)}</div>
                  <div className="row-sub">{fmtDate(r.start_date)} – {fmtDate(r.end_date)}</div>
                </div>
                <div className="spacer" />
                <Chip kind="pending">Pending</Chip>
              </div>
            ))}
            {pendingExp.map((e) => (
              <div className="row" key={e.id}>
                <span style={{ color: 'var(--accent)' }}>{icons.expenses}</span>
                <div>
                  <div className="row-title">{e.description}</div>
                  <div className="row-sub">{fmtMoney(e.amount, e.currency)}</div>
                </div>
                <div className="spacer" />
                <Chip kind="pending">Pending</Chip>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function VacationHero({ v, onRequest }: { v: { remaining: number; total: number; used: number }; onRequest: () => void }) {
  return (
    <div className="card hero">
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <div style={{ position: 'relative', width: 112, height: 112, flex: 'none' }}>
          <Ring size={112} remaining={v.remaining} total={v.total} />
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
            <div>
              <div className="num" style={{ fontSize: 30, fontWeight: 700, lineHeight: 1 }}>{v.remaining}</div>
              <div className="faint" style={{ fontSize: 11 }}>days left</div>
            </div>
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Vacation</div>
          <div className="row-sub" style={{ marginTop: 2 }}>{v.used} of {v.total} used</div>
          <div className="row-sub">Resets 1 Jan 2027</div>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <Button onClick={onRequest}>Request time off</Button>
      </div>
    </div>
  );
}

function CompactVacation({ v, onRequest }: { v: { remaining: number; total: number; used: number }; onRequest: () => void }) {
  return (
    <div className="card">
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <div style={{ position: 'relative', width: 64, height: 64, flex: 'none' }}>
          <Ring size={64} remaining={v.remaining} total={v.total} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Vacation days</div>
          <div className="row-sub">Full year available · {v.used === 0 ? 'none used yet' : `${v.used} used`}</div>
        </div>
        <Button variant="pill" onClick={onRequest}>Request</Button>
      </div>
    </div>
  );
}

// -- Time off ----------------------------------------------------------------

export function TimeOff({ d, openFlow }: ScreenProps) {
  const upcoming = d.requests.filter((r) => r.status === 'requested' || (r.status === 'approved' && r.end_date >= todayStr()));
  const earlier = d.requests.filter((r) => !upcoming.includes(r));
  return (
    <>
      <div className="tab-title">Time off</div>
      <div className="card tight">
        {d.leaveTypes.map((lt) => {
          const bal = d.balance?.balances.find((b) => b.leaveTypeKey === lt.key);
          const remaining = bal ? Number(bal.balance) : null;
          return (
            <div className="row" key={lt.key}>
              <TypeDot kind={lt.kind} />
              <div className="row-title" style={{ fontSize: 14.5 }}>{lt.label}</div>
              <div className="spacer" />
              <div className="num" style={{ fontSize: 14.5 }}>
                {lt.annual_days
                  ? <><b style={{ fontWeight: 700 }}>{remaining ?? lt.annual_days}</b> / {lt.annual_days} days</>
                  : <span className="faint">on request</span>}
              </div>
            </div>
          );
        })}
      </div>

      {upcoming.length > 0 && (
        <>
          <div className="section-label">Upcoming</div>
          <RequestList d={d} rows={upcoming} />
        </>
      )}
      {earlier.length > 0 && (
        <>
          <div className="section-label">Earlier this year</div>
          <RequestList d={d} rows={earlier} />
        </>
      )}

      <div style={{ marginTop: 6 }}>
        <Button onClick={() => openFlow('request')}>Request time off</Button>
      </div>
    </>
  );
}

function RequestList({ d, rows }: { d: AppData; rows: AppData['requests'] }) {
  return (
    <div className="card tight">
      {rows.map((r) => {
        const c = statusChip(r.status);
        return (
          <div className="row" key={r.id}>
            <TypeDot kind={leaveKind(d, r.leave_type_key)} />
            <div>
              <div className="row-title">{fmtDate(r.start_date)} – {fmtDate(r.end_date)}</div>
              <div className="row-sub">{leaveLabel(d, r.leave_type_key)} · {r.days} day{r.days === '1' ? '' : 's'}</div>
            </div>
            <div className="spacer" />
            <Chip kind={c.kind}>{c.label}</Chip>
          </div>
        );
      })}
    </div>
  );
}

// -- Timesheet ---------------------------------------------------------------

export function TimesheetScreen({ d, openFlow }: ScreenProps) {
  const entries = d.timesheet?.entries ?? [];
  const byDay = new Map<string, number>();
  for (const e of entries) byDay.set(e.work_date, (byDay.get(e.work_date) ?? 0) + Number(e.hours));
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const maxH = Math.max(8, ...days.map((x) => x[1]));
  const total = Number(d.timesheet?.totalHours ?? '0');

  return (
    <>
      <div className="tab-title">Timesheet</div>
      <div className="card">
        <div className="row-sub">This period</div>
        <div className="num" style={{ fontSize: 17, fontWeight: 700, marginBottom: 12 }}>
          {total} / 40 h
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 64 }}>
          {days.length === 0 && <div className="faint" style={{ fontSize: 13 }}>No hours logged yet.</div>}
          {days.map(([date, h]) => (
            <div key={date} style={{ flex: 1, textAlign: 'center' }}>
              <div
                style={{ height: Math.round((h / maxH) * 52), background: 'var(--accent)', borderRadius: 6, marginBottom: 6 }}
                title={`${h} h`}
              />
              <div className="num faint" style={{ fontSize: 11 }}>{new Date(date + 'T00:00:00').toLocaleDateString('en', { weekday: 'narrow' })}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="section-label">This period</div>
      <div className="card tight">
        {days.length === 0 && <div className="row"><span className="faint" style={{ fontSize: 13 }}>Log your first hours below.</span></div>}
        {[...days].reverse().map(([date, h]) => {
          const projects = entries.filter((e) => e.work_date === date).map((e) => projName(d, e.project_id)).join(', ');
          return (
            <div className="row" key={date}>
              <div>
                <div className="row-title">{fmtDate(date)}</div>
                <div className="row-sub">{projects || '—'}</div>
              </div>
              <div className="spacer" />
              <div className="num" style={{ fontSize: 14.5, fontWeight: 700 }}>{h} h</div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 6 }}>
        <Button onClick={() => openFlow('log')}>Log time</Button>
      </div>
    </>
  );
}

// -- Expenses ----------------------------------------------------------------

export function Expenses({ d, openFlow }: ScreenProps) {
  const submitted = d.expenses.filter((e) => e.status === 'submitted' || e.status === 'approved');
  const reimbursed = d.expenses.filter((e) => e.status === 'exported');
  const sum = (rows: AppData['expenses']) => rows.reduce((s, e) => s + Number(e.amount), 0);
  const currency = d.expenses[0]?.currency ?? (d.me.country === 'ES' ? 'EUR' : 'SEK');
  return (
    <>
      <div className="tab-title">Expenses</div>
      <div className="card">
        <div style={{ display: 'flex' }}>
          <div style={{ flex: 1 }}>
            <div className="row-sub">Submitted</div>
            <div className="num" style={{ fontSize: 18, fontWeight: 700 }}>{fmtMoney(String(sum(submitted)), currency)}</div>
          </div>
          <div style={{ width: 1, background: 'var(--divider)', margin: '0 14px' }} />
          <div style={{ flex: 1 }}>
            <div className="row-sub">Reimbursed</div>
            <div className="num" style={{ fontSize: 18, fontWeight: 700, color: 'var(--chip-approved-fg)' }}>{fmtMoney(String(sum(reimbursed)), currency)}</div>
          </div>
        </div>
      </div>

      <Button onClick={() => openFlow('expense')}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>{icons.camera} Snap a receipt</span>
      </Button>

      <div className="section-label" style={{ marginTop: 20 }}>Recent</div>
      <div className="card tight">
        {d.expenses.length === 0 && <div className="row"><span className="faint" style={{ fontSize: 13 }}>No expenses yet.</span></div>}
        {d.expenses.map((e) => {
          const c = statusChip(e.status);
          return (
            <div className="row" key={e.id}>
              <div style={{ width: 38, height: 38, borderRadius: 8, background: 'repeating-linear-gradient(135deg, var(--divider), var(--divider) 4px, var(--card) 4px, var(--card) 8px)', flex: 'none' }} />
              <div>
                <div className="row-title">{e.description}</div>
                <div className="row-sub">{e.category}</div>
              </div>
              <div className="spacer" />
              <div style={{ textAlign: 'right' }}>
                <div className="num" style={{ fontSize: 14.5, fontWeight: 700 }}>{fmtMoney(e.amount, e.currency)}</div>
                <Chip kind={c.kind}>{c.label}</Chip>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// -- Me ----------------------------------------------------------------------

export function Me({
  d,
  theme,
  onTheme,
  onSwitch,
}: {
  d: AppData;
  theme: string;
  onTheme: (t: 'system' | 'light' | 'dark') => void;
  onSwitch: () => void;
}) {
  const initials = d.me.display.split(' ').map((p) => p[0]).slice(0, 2).join('');
  return (
    <>
      <div className="tab-title">Me</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '4px 2px 18px' }}>
        <div className="avatar" style={{ width: 56, height: 56, fontSize: 18 }}>{initials}</div>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{d.me.display}</div>
          <div className="row-sub">Employee · {d.me.country === 'ES' ? 'Madrid' : 'Stockholm'}</div>
        </div>
      </div>

      <div className="card tight">
        <ListRow>Payslips</ListRow>
        <ListRow>Documents &amp; contracts</ListRow>
        <ListRow>Bank details</ListRow>
      </div>

      <div className="card tight">
        <div className="row">
          <div className="row-title">Appearance</div>
          <div className="spacer" />
          <div style={{ display: 'flex', gap: 6 }}>
            {(['system', 'light', 'dark'] as const).map((t) => (
              <button
                key={t}
                onClick={() => onTheme(t)}
                className="num"
                style={{
                  fontSize: 12.5,
                  padding: '6px 10px',
                  borderRadius: 8,
                  background: theme === t ? 'var(--accent-tint)' : 'transparent',
                  color: theme === t ? 'var(--accent-dark)' : 'var(--muted)',
                  fontWeight: theme === t ? 600 : 500,
                }}
              >
                {t.slice(0, 1).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <ListRow>Notifications</ListRow>
      </div>

      <div style={{ background: 'var(--panel-bg)', color: 'var(--muted)', borderRadius: 12, padding: '12px 14px', fontSize: 13, margin: '4px 0 18px' }}>
        Only you and HR can see this data. Colleagues never see your balances, requests or pay.
      </div>

      <button onClick={onSwitch} style={{ display: 'block', width: '100%', textAlign: 'center', color: 'var(--destructive)', fontSize: 16, fontWeight: 600, padding: 12 }}>
        Switch persona (dev)
      </button>
    </>
  );
}

function ListRow({ children }: { children: ReactNode }) {
  return (
    <div className="row">
      <div className="row-title" style={{ fontSize: 15 }}>{children}</div>
      <div className="spacer" />
      <span className="faint">{icons.chevron}</span>
    </div>
  );
}

// -- helpers -----------------------------------------------------------------

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}
function leaveLabel(d: AppData, key: string): string {
  return d.leaveTypes.find((t) => t.key === key)?.label ?? key;
}
function leaveKind(d: AppData, key: string): string {
  return d.leaveTypes.find((t) => t.key === key)?.kind ?? key;
}
function projName(d: AppData, id: string | null): string {
  if (!id) return 'No project';
  return d.projects.find((p) => p.id === id)?.name ?? 'Project';
}
