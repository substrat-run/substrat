import { useEffect, useState } from 'react';
import { api, ApiError, fmtMoney, type Invite, type PayrollExport } from './api';
import { todayISO, type AdminData } from './data';
import { Button } from './ui';

/**
 * The Admin (HR-setup) section — the first-run surface a freshly-installed instance
 * needs. An installed Meridian is EMPTY: no leave types, no people, no projects. The
 * hr-admin owner sets that up here before anyone uses the employee/manager surfaces.
 * Every screen is a full-page content view (the desktop shell / mobile scroll), not
 * the modal flow the employee app uses; permission is still checked in the kernel on
 * every op, so a non-admin who reached these calls would be refused regardless.
 */

export type AdminTab = 'setup' | 'leavetypes' | 'people' | 'projects' | 'payroll' | 'access';

export const ADMIN_TABS: { key: AdminTab; label: string; icon: string }[] = [
  { key: 'setup', label: 'Setup', icon: 'home' },
  { key: 'leavetypes', label: 'Leave types', icon: 'timeoff' },
  { key: 'people', label: 'People', icon: 'people' },
  { key: 'projects', label: 'Projects', icon: 'timesheet' },
  { key: 'payroll', label: 'Payroll', icon: 'expenses' },
  { key: 'access', label: 'Access', icon: 'people' },
];

export interface AdminProps {
  d: AdminData;
  reload: () => void;
  toast: (m: string) => void;
  go: (tab: AdminTab) => void;
}

/** The statutory leave types each country ships with (spec §6) — one-tap quick-add. */
const PRESETS: Record<'SE' | 'ES', { key: string; label: string; kind: string; annualDays?: string }[]> = {
  SE: [
    { key: 'semester', label: 'Semester (vacation)', kind: 'vacation', annualDays: '25' },
    { key: 'sjuk', label: 'Sjuklön (sick)', kind: 'sick' },
    { key: 'vab', label: 'VAB (care of child)', kind: 'vab' },
    { key: 'foraldra', label: 'Föräldraledighet (parental)', kind: 'parental' },
  ],
  ES: [
    { key: 'vacaciones', label: 'Vacaciones (vacation)', kind: 'vacation', annualDays: '22' },
    { key: 'baja', label: 'Baja (sick leave)', kind: 'baja' },
    { key: 'permisos', label: 'Permisos', kind: 'unpaid' },
    { key: 'permiso-parental', label: 'Permiso parental', kind: 'parental' },
  ],
};

function typeClass(kind: string): string {
  if (kind === 'vacation') return 'vacation';
  if (kind === 'sick' || kind === 'vab' || kind === 'baja') return 'sick';
  if (kind === 'parental') return 'parental';
  return 'unpaid';
}
const Dot = ({ kind }: { kind: string }) => <span className={`tdot ${typeClass(kind)}`} />;

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '11px 13px', borderRadius: 12, border: '1px solid var(--card-border)',
  background: 'var(--bg)', color: 'var(--ink)', fontSize: 15,
};

/** Shared busy/error submit wrapper, mirroring flows.tsx `useSubmit`. */
function useRun(reload: () => void, toast: (m: string) => void) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>, msg: string) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      toast(msg);
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, run, setErr };
}

// -- Setup (first-run checklist) --------------------------------------------

export function AdminSetup({ d, go }: AdminProps) {
  const steps = [
    { done: d.leaveTypes.length > 0, title: 'Define leave types', sub: 'Vacation, sick, parental — the vocabulary requests book against.', tab: 'leavetypes' as const, count: d.leaveTypes.length },
    { done: d.roster.length > 0, title: 'Add your people', sub: 'The directory — everyone who reports leave, time and expenses.', tab: 'people' as const, count: d.roster.length },
    { done: d.projects.length > 0, title: 'Add projects', sub: 'What worked hours book against (also satisfies registro de jornada).', tab: 'projects' as const, count: d.projects.length },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;

  return (
    <>
      <h1 className="page-title">Set up Meridian</h1>
      <div className="page-sub">{d.country === 'ES' ? 'Spain' : 'Sweden'} · {allDone ? 'Your workspace is ready' : `${doneCount} of ${steps.length} steps done`}</div>

      {allDone ? (
        <div className="card" style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <span style={{ width: 40, height: 40, borderRadius: 999, display: 'grid', placeItems: 'center', background: 'var(--accent-tint)', color: 'var(--accent-dark)', fontSize: 20, flex: 'none' }}>✓</span>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>You're all set</div>
            <div className="muted" style={{ fontSize: 13 }}>Your team can request leave, log time and submit expenses. Manage it all from the Manage section.</div>
          </div>
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 4 }}>
          <div className="muted" style={{ fontSize: 13.5, lineHeight: 1.5 }}>
            Welcome. Meridian starts empty — a few quick steps and your HR workspace is live. Work through them in order; each takes under a minute.
          </div>
        </div>
      )}

      <div className="card tight" style={{ marginTop: 16 }}>
        {steps.map((s, i) => (
          <button key={s.tab} className="row" style={{ width: '100%', textAlign: 'left', background: 'none' }} onClick={() => go(s.tab)}>
            <span
              style={{
                width: 26, height: 26, borderRadius: 999, flex: 'none', display: 'grid', placeItems: 'center', fontSize: 13, fontWeight: 700,
                background: s.done ? 'var(--accent)' : 'transparent',
                border: `1.5px solid ${s.done ? 'var(--accent)' : 'var(--fainter)'}`,
                color: s.done ? 'var(--btn-fg)' : 'var(--muted)',
              }}
            >
              {s.done ? '✓' : i + 1}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14.5, fontWeight: 600 }}>{s.title}{s.done && s.count > 0 ? ` · ${s.count}` : ''}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>{s.sub}</div>
            </div>
            <span className="muted" style={{ marginLeft: 'auto', fontSize: 13 }}>{s.done ? 'Edit' : 'Start'} ›</span>
          </button>
        ))}
      </div>
    </>
  );
}

// -- Leave types ------------------------------------------------------------

export function AdminLeaveTypes({ d, reload, toast }: AdminProps) {
  const { busy, err, run } = useRun(reload, toast);
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState('vacation');
  const [annualDays, setAnnualDays] = useState('');

  const existing = new Set(d.leaveTypes.map((t) => t.key));
  const presets = PRESETS[d.country].filter((p) => !existing.has(p.key));

  const addPreset = (p: { key: string; label: string; kind: string; annualDays?: string }) =>
    run(async () => {
      await api.defineLeaveType({ key: p.key, label: p.label, kind: p.kind, ...(p.annualDays ? { annualDays: p.annualDays } : {}) });
    }, `Added ${p.label}`);

  const submit = () =>
    run(async () => {
      await api.defineLeaveType({ key: key.trim(), label: label.trim(), kind, ...(annualDays ? { annualDays } : {}) });
      setKey(''); setLabel(''); setAnnualDays('');
    }, `Defined ${label.trim()}`);

  return (
    <>
      <h1 className="page-title">Leave types</h1>
      <div className="page-sub">The absence vocabulary for {d.country === 'ES' ? 'Spain' : 'Sweden'}. Requests and balances book against these.</div>

      <div className="card tight">
        {d.leaveTypes.length === 0 && <div className="muted" style={{ fontSize: 14, padding: 6 }}>No leave types yet. Add the statutory ones below, or define your own.</div>}
        {d.leaveTypes.map((t) => (
          <div className="row" key={t.key}>
            <Dot kind={t.kind} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{t.label}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>{t.key} · {t.kind}{t.annual_days ? ` · ${t.annual_days} days/yr` : ''}</div>
            </div>
          </div>
        ))}
      </div>

      {presets.length > 0 && (
        <>
          <div className="section-label">Statutory presets ({d.country})</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {presets.map((p) => (
              <button key={p.key} className="btn sm tint" disabled={busy} onClick={() => addPreset(p)} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <Dot kind={p.kind} />+ {p.label}
              </button>
            ))}
          </div>
        </>
      )}

      <div className="section-label">Define a leave type</div>
      <div className="card" style={{ display: 'grid', gap: 10 }}>
        {err && <div className="err-banner">{err}</div>}
        <input style={inputStyle} aria-label="Leave type label" placeholder="Label (e.g. Vacation)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <div style={{ display: 'flex', gap: 10 }}>
          <input style={inputStyle} aria-label="Leave type key" placeholder="Key (e.g. vacation)" value={key} onChange={(e) => setKey(e.target.value.replace(/[^a-z0-9-]/g, ''))} />
          <select style={{ ...inputStyle, width: 150 }} aria-label="Leave type kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="vacation">Vacation</option>
            <option value="sick">Sick</option>
            <option value="vab">Care of child</option>
            <option value="baja">Baja</option>
            <option value="parental">Parental</option>
            <option value="unpaid">Unpaid</option>
          </select>
        </div>
        <input style={inputStyle} aria-label="Annual days" inputMode="decimal" placeholder="Annual days (optional, e.g. 25)" value={annualDays} onChange={(e) => setAnnualDays(e.target.value.replace(/[^\d.]/g, ''))} />
        <Button disabled={busy || !key.trim() || !label.trim()} onClick={submit}>Define leave type</Button>
      </div>
    </>
  );
}

// -- People -----------------------------------------------------------------

export function AdminPeople({ d, reload, toast }: AdminProps) {
  const { busy, err, run } = useRun(reload, toast);
  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [startedAt, setStartedAt] = useState(todayISO());
  // An admin with no employee record of their own can register themselves here: linking the
  // new record to their login (`principalRef`) is what earns the self-service grants (time,
  // leave, expenses) — an hr-admin role alone can manage the team but not report its own time.
  const [linkMe, setLinkMe] = useState(false);
  const canLinkMe = !d.me.employeeId;

  const nextNumber = () => `E-${String(d.roster.length + 1).padStart(3, '0')}`;

  const submit = () =>
    run(async () => {
      await api.createEmployee({
        number: (number || nextNumber()).trim(),
        name: name.trim(),
        ...(email ? { email: email.trim() } : {}),
        startedAt,
        ...(linkMe && canLinkMe ? { principalRef: d.me.key } : {}),
      });
      setNumber(''); setName(''); setEmail('');
      // Registering yourself flips on the "My work" surface (whoami now resolves your
      // employeeId). That state lives in the app-level load, so refetch it wholesale.
      if (linkMe && canLinkMe) window.location.reload();
    }, `Added ${name.trim()}`);

  return (
    <>
      <h1 className="page-title">People</h1>
      <div className="page-sub">The directory — {d.roster.length} {d.roster.length === 1 ? 'person' : 'people'}. Everyone who reports leave, time and expenses.</div>

      <div className="card tight">
        {d.roster.length === 0 && <div className="muted" style={{ fontSize: 14, padding: 6 }}>No people yet. Add your first employee below.</div>}
        {d.roster.map((m) => (
          <div className="row" key={m.id}>
            <span className="avatar">{m.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{m.name}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>{m.number}{m.email ? ` · ${m.email}` : ''}{m.started_at ? ` · started ${m.started_at}` : ''}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="section-label">Add an employee</div>
      <div className="card" style={{ display: 'grid', gap: 10 }}>
        {err && <div className="err-banner">{err}</div>}
        <input style={inputStyle} aria-label="Full name" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
        <div style={{ display: 'flex', gap: 10 }}>
          <input style={inputStyle} aria-label="Employee number" placeholder={`Number (${nextNumber()})`} value={number} onChange={(e) => setNumber(e.target.value)} />
          <input style={inputStyle} type="date" aria-label="Start date" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} />
        </div>
        <input style={inputStyle} aria-label="Email" placeholder="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} />
        {canLinkMe && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, cursor: 'pointer' }}>
            <input type="checkbox" checked={linkMe} onChange={(e) => setLinkMe(e.target.checked)} />
            This is me — link my login so I can report my own time, leave and expenses
          </label>
        )}
        <Button disabled={busy || !name.trim()} onClick={submit}>{linkMe && canLinkMe ? 'Register myself' : 'Add employee'}</Button>
        <div className="muted" style={{ fontSize: 12 }}>National id / salary and country scope are set on the employee record; erasure crypto-shreds the PII while absence facts survive (§8).</div>
      </div>
    </>
  );
}

// -- Access (member invites) ------------------------------------------------

/**
 * Invite teammates to this workspace (the post-setup join path — the instance is
 * invite-only once the admin has set it up). Each invite grants a role and produces a
 * one-time accept link to share; a teammate who opens it creates their login and lands
 * with that role. Employees (HR records) are separate — this is about who can sign in.
 * Self-contained: it reads its own invite list rather than the shared admin bundle.
 */
export function AdminAccess({ toast }: { toast: (m: string) => void }) {
  const [roles, setRoles] = useState<string[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [role, setRole] = useState('');
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const { busy, err, run } = useRun(() => load(), toast);

  const load = () => {
    api
      .invites()
      .then((r) => {
        setRoles(r.roles);
        setInvites(r.invites);
        setRole((cur) => cur || r.roles[0] || '');
      })
      .catch(() => {});
  };
  useEffect(load, []);

  const create = () =>
    run(async () => {
      const r = await api.createInvite(role || roles[0] || 'manager', email.trim() || undefined);
      setLink(r.acceptUrl);
      setEmail('');
    }, 'Invite created');

  const revoke = (principal: string) => run(async () => { await api.revokeInvite(principal); }, 'Invite revoked');

  return (
    <>
      <h1 className="page-title">Access</h1>
      <div className="page-sub">Who can sign in to this workspace. Invite a teammate at a role; they get a one-time link to create their login.</div>

      <div className="section-label">Invite a teammate</div>
      <div className="card" style={{ display: 'grid', gap: 10 }}>
        {err && <div className="err-banner">{err}</div>}
        <input style={inputStyle} type="email" aria-label="Email" placeholder="Email (optional — for your own reference)" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select style={inputStyle} aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}>
          {roles.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <Button disabled={busy || !role} onClick={create}>Create invite link</Button>
        {link && (
          <div style={{ display: 'grid', gap: 6 }}>
            <div className="muted" style={{ fontSize: 12 }}>Share this one-time link — it expires when used:</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input style={{ ...inputStyle, fontFamily: 'var(--mono, monospace)', fontSize: 12.5 }} readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
              <Button onClick={() => { void navigator.clipboard?.writeText(link); toast('Link copied'); }}>Copy</Button>
            </div>
          </div>
        )}
      </div>

      <div className="section-label">Pending invites</div>
      <div className="card tight">
        {invites.length === 0 && <div className="muted" style={{ fontSize: 14, padding: 6 }}>No pending invites.</div>}
        {invites.map((iv) => (
          <div className="row" key={iv.principal}>
            <span className="avatar">{(iv.email ?? iv.roleKey).slice(0, 2).toUpperCase()}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{iv.email ?? 'Invite'}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>{iv.roleKey} · awaiting sign-up</div>
            </div>
            <button type="button" className="link-btn" onClick={() => revoke(iv.principal)} style={{ background: 'none', border: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: 13 }}>Revoke</button>
          </div>
        ))}
      </div>
    </>
  );
}

// -- Projects ---------------------------------------------------------------

export function AdminProjects({ d, reload, toast }: AdminProps) {
  const { busy, err, run } = useRun(reload, toast);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');

  const submit = () =>
    run(async () => {
      await api.createProject({ code: code.trim(), name: name.trim() });
      setCode(''); setName('');
    }, `Created ${name.trim()}`);

  return (
    <>
      <h1 className="page-title">Projects</h1>
      <div className="page-sub">What worked hours book against. Daily totals also satisfy Spain's registro de jornada.</div>

      <div className="card tight">
        {d.projects.length === 0 && <div className="muted" style={{ fontSize: 14, padding: 6 }}>No projects yet. Add the first one below.</div>}
        {d.projects.map((p) => (
          <div className="row" key={p.id}>
            <span className="mono" style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--muted)', minWidth: 54 }}>{p.code}</span>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{p.name}</div>
          </div>
        ))}
      </div>

      <div className="section-label">Create a project</div>
      <div className="card" style={{ display: 'grid', gap: 10 }}>
        {err && <div className="err-banner">{err}</div>}
        <div style={{ display: 'flex', gap: 10 }}>
          <input style={{ ...inputStyle, width: 120 }} aria-label="Project code" placeholder="Code" value={code} onChange={(e) => setCode(e.target.value)} />
          <input style={inputStyle} aria-label="Project name" placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <Button disabled={busy || !code.trim() || !name.trim()} onClick={submit}>Create project</Button>
      </div>
    </>
  );
}

// -- Payroll export (the payroll boundary, §7) -------------------------------

export function AdminPayroll({ d, toast }: AdminProps) {
  const [from, setFrom] = useState(todayISO().slice(0, 8) + '01');
  const [to, setTo] = useState(todayISO());
  const [result, setResult] = useState<PayrollExport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const empName = (id: string) => d.roster.find((r) => r.id === id)?.name ?? id;

  const generate = async () => {
    setBusy(true);
    setErr(null);
    try {
      const out = await api.payrollExport(from, to);
      setResult(out);
      toast(`Exported ${out.expenses.length + out.absence.length} line(s)`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="page-title">Payroll export</h1>
      <div className="page-sub">
        The variable-pay handoff — approved absence and expenses per period. Meridian owns leave,
        overtime and reimbursements; your payroll provider owns gross-to-net. This is the boundary.
      </div>

      <div className="card" style={{ display: 'grid', gap: 10 }}>
        {err && <div className="err-banner">{err}</div>}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <label className="muted" style={{ fontSize: 13 }}>From</label>
          <input style={{ ...inputStyle, width: 170 }} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <label className="muted" style={{ fontSize: 13 }}>To</label>
          <input style={{ ...inputStyle, width: 170 }} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Button disabled={busy} onClick={generate}>Generate export</Button>
        <div className="muted" style={{ fontSize: 12 }}>Marks the exported expenses so a re-run never double-pays them — run once per pay period.</div>
      </div>

      {result && (
        <>
          <div className="section-label">Expenses ({result.expenses.length})</div>
          <div className="card tight">
            {result.expenses.length === 0 && <div className="muted" style={{ fontSize: 14, padding: 6 }}>No approved expenses in range.</div>}
            {result.expenses.map((e, i) => (
              <div className="row" key={i}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{empName(e.employeeId)}</div>
                <div className="muted" style={{ fontSize: 12.5 }}>{e.category}</div>
                <div className="num" style={{ marginLeft: 'auto', fontWeight: 700 }}>{fmtMoney(e.amount, e.currency)}</div>
              </div>
            ))}
          </div>
          <div className="section-label">Absence bookings ({result.absence.length})</div>
          <div className="card tight">
            {result.absence.length === 0 && <div className="muted" style={{ fontSize: 14, padding: 6 }}>No booked absence in range.</div>}
            {result.absence.map((a, i) => (
              <div className="row" key={i}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{empName(a.employeeId)}</div>
                <div className="muted" style={{ fontSize: 12.5 }}>{a.leaveTypeKey}</div>
                <div className="num" style={{ marginLeft: 'auto', fontWeight: 700 }}>{a.days}d</div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
