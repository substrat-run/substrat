import { useCallback, useEffect, useState } from 'react';
import { Button, Dialog, Input, Select } from '@substrat-run/ui';
import { api, ApiError, type AppRow, type DnsRecord, type DomainRow } from '../lib/api';
import { DEV_MOCK } from '../lib/mock';
import { Ic } from '../lib/icons';
import { Page } from '../components/layout';
import { card, CopyButton, MonoTag, PageTitle, Pill } from '../components/ui';
import { relativeTime } from '../lib/format';

const COLS = '2.2fr 1.4fr 1.6fr 1fr 40px';

/** DEV_MOCK preview data — the real shape `GET /api/domains` returns, no backend. */
const MOCK_DOMAINS: DomainRow[] = [
  {
    hostname: 'hr.acme.com', appScopeId: '01J1', app: 'Acme HR', surface: 'app',
    status: 'active', statusNote: null, primary: true, createdAt: '2026-07-21T10:00:00Z',
    validationRecords: [],
  },
  {
    hostname: 'legal.acme.com', appScopeId: '01J2', app: 'Acme Legal', surface: 'app',
    status: 'verifying', statusNote: null, primary: false, createdAt: new Date().toISOString(),
    validationRecords: [
      { type: 'hostname', name: 'legal.acme.com', value: 'cname.substrat.run', status: 'pending' },
    ],
  },
  {
    hostname: 'app.acme.io', appScopeId: '01J3', app: 'Acme Field Ops', surface: 'app',
    status: 'failed', statusNote: 'DNS validation timed out — the CNAME does not resolve yet.',
    primary: false, createdAt: '2026-07-18T09:00:00Z',
    validationRecords: [{ type: 'hostname', name: 'app.acme.io', value: 'cname.substrat.run', status: 'pending' }],
  },
];

const STATUS: Record<DomainRow['status'], { kind: 'success' | 'warning' | 'danger' | 'neutral'; label: string; pulse?: boolean }> = {
  active: { kind: 'success', label: 'Active' },
  verifying: { kind: 'warning', label: 'Verifying', pulse: true },
  pending: { kind: 'warning', label: 'Pending verification', pulse: true },
  failed: { kind: 'danger', label: 'Verification failed' },
};

/** Domains — account level (screens 1o, 1p). Custom hostnames across the team's apps. */
export function Domains() {
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [apps, setApps] = useState<AppRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [add, setAdd] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (DEV_MOCK) {
      setDomains(MOCK_DOMAINS);
      setLoading(false);
      return;
    }
    const [d, a] = await Promise.all([api.listDomains(), api.listApps().catch(() => [])]);
    setDomains(d);
    setApps(a);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onVerify = useCallback(
    async (hostname: string) => {
      if (DEV_MOCK) return;
      setBusy(hostname);
      try {
        await api.verifyDomain(hostname);
        await load();
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const onRemove = useCallback(
    async (hostname: string) => {
      if (DEV_MOCK) {
        setDomains((ds) => ds.filter((d) => d.hostname !== hostname));
        return;
      }
      setBusy(hostname);
      try {
        await api.removeDomain(hostname);
        await load();
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  return (
    <Page>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <PageTitle
          title="Domains"
          subtitle={
            <>
              Every app is already live on its <span style={{ fontFamily: 'var(--font-mono)' }}>*.substrat.run</span>{' '}
              hostname — custom domains bind on top.
            </>
          }
        />
        <div style={{ flex: 1 }} />
        <Button icon={<Ic name="plus" />} onClick={() => setAdd(true)}>
          Add domain
        </Button>
      </div>

      <div style={{ ...card, overflow: 'hidden' }}>
        <div
          style={{
            display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 36, padding: '0 16px',
            fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase',
            color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <span>Hostname</span>
          <span>App</span>
          <span>Status</span>
          <span>Added</span>
          <span />
        </div>
        {loading ? (
          <div style={{ padding: '18px 16px', fontSize: 13, color: 'var(--text-tertiary)' }}>Loading…</div>
        ) : domains.length === 0 ? (
          <div style={{ padding: '18px 16px', fontSize: 13, color: 'var(--text-tertiary)' }}>
            No custom domains yet. Add one to serve an app on your own hostname.
          </div>
        ) : (
          domains.map((d, i) => (
            <DomainRowView
              key={d.hostname}
              d={d}
              last={i === domains.length - 1}
              busy={busy === d.hostname}
              onVerify={() => onVerify(d.hostname)}
              onRemove={() => onRemove(d.hostname)}
            />
          ))
        )}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
        Default hostnames (<span style={{ fontFamily: 'var(--font-mono)' }}>acme-hr.substrat.run</span>, …) are managed
        automatically and not listed here.
      </div>

      <AddDomainDialog open={add} apps={apps} onClose={() => setAdd(false)} onAdded={load} />
    </Page>
  );
}

function DomainRowView({
  d, last, busy, onVerify, onRemove,
}: {
  d: DomainRow;
  last: boolean;
  busy: boolean;
  onVerify: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const s = STATUS[d.status];
  const hasRecords = d.validationRecords.length > 0 && d.status !== 'active';
  return (
    <div style={{ borderBottom: last ? 'none' : '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 40, padding: '0 16px', fontSize: 13 }}>
        {d.status === 'active' ? (
          <a
            href={`https://${d.hostname}`}
            target="_blank"
            rel="noreferrer"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}
          >
            {d.hostname}
            <Ic name="external" size={11} />
          </a>
        ) : (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)' }}>{d.hostname}</span>
        )}
        <span style={{ fontSize: 13 }}>{d.app}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Pill kind={s.kind} pulse={s.pulse}>
            {s.label}
          </Pill>
          {d.status === 'active' && d.primary && <MonoTag color="var(--text-tertiary)">primary</MonoTag>}
          {(d.status === 'verifying' || d.status === 'pending' || d.status === 'failed') && (
            <span
              onClick={busy ? undefined : onVerify}
              style={{ fontSize: 12, color: 'var(--text-brand)', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1 }}
            >
              {busy ? 'Checking…' : 'Check again'}
            </span>
          )}
        </span>
        <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{relativeTime(d.createdAt)}</span>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
          {hasRecords && (
            <button
              type="button"
              aria-label="Show DNS records"
              onClick={() => setOpen((o) => !o)}
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, border: 0, borderRadius: 6, background: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', transform: open ? 'rotate(180deg)' : 'none' }}
            >
              <Ic name="chevronDown" size={16} />
            </button>
          )}
          <button
            type="button"
            aria-label="Remove domain"
            disabled={busy}
            onClick={onRemove}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, border: 0, borderRadius: 6, background: 'none', color: 'var(--text-tertiary)', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1 }}
          >
            <Ic name="trash" size={15} />
          </button>
        </div>
      </div>

      {d.status === 'failed' && d.statusNote && (
        <div style={{ margin: '0 16px 12px', background: 'var(--status-danger-bg)', borderRadius: 6, padding: '10px 14px', fontSize: 12.5, color: 'var(--status-danger-fg)', lineHeight: 1.6 }}>
          {d.statusNote}
        </div>
      )}

      {open && hasRecords && (
        <div style={{ margin: '0 16px 14px' }}>
          <DnsRecords records={d.validationRecords} />
        </div>
      )}
    </div>
  );
}

/** The records a tenant must publish for a custom domain to validate — copy-ready rows. */
function DnsRecords({ records }: { records: DnsRecord[] }) {
  return (
    <div style={{ background: 'var(--surface-inset)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '12px 14px', display: 'grid', gridTemplateColumns: '64px 1fr 1.4fr 24px', alignItems: 'center', gap: '8px 10px', fontSize: 12.5 }}>
      <span style={{ color: 'var(--text-tertiary)' }}>Type</span>
      <span style={{ color: 'var(--text-tertiary)' }}>Name</span>
      <span style={{ color: 'var(--text-tertiary)' }}>Value</span>
      <span />
      {records.map((r) => (
        <RecordRow key={`${r.type}:${r.name}`} r={r} />
      ))}
    </div>
  );
}

function RecordRow({ r }: { r: DnsRecord }) {
  const type = r.type === 'hostname' ? 'CNAME' : 'TXT';
  return (
    <>
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{type}</span>
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', wordBreak: 'break-all' }}>{r.name}</span>
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', wordBreak: 'break-all' }}>{r.value}</span>
      <CopyButton text={r.value} />
    </>
  );
}

function AddDomainDialog({
  open, apps, onClose, onAdded,
}: {
  open: boolean;
  apps: AppRow[];
  onClose: () => void;
  onAdded: () => Promise<void> | void;
}) {
  const [hostname, setHostname] = useState('');
  const [appScopeId, setAppScopeId] = useState('');
  const [records, setRecords] = useState<DnsRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const appOptions = apps.map((a) => ({ value: a.app_scope_id, label: a.name }));
  const chosen = appScopeId || appOptions[0]?.value || '';

  const reset = () => {
    setHostname('');
    setAppScopeId('');
    setRecords(null);
    setError(null);
  };

  const submit = async () => {
    setError(null);
    if (!hostname.trim() || !chosen) {
      setError('Pick an app and enter a domain.');
      return;
    }
    setSaving(true);
    try {
      const row = await api.addDomain({ hostname: hostname.trim().toLowerCase(), appScopeId: chosen });
      setRecords(row.validationRecords ?? []);
      await onAdded();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add the domain.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="Add a domain"
      confirmLabel={records ? 'Done' : saving ? 'Adding…' : 'Add domain'}
      cancelLabel={records ? undefined : 'Close'}
      confirmDisabled={saving}
      onCancel={() => {
        reset();
        onClose();
      }}
      onConfirm={records ? () => { reset(); onClose(); } : submit}
      width={520}
    >
      {records ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            Publish these records with your DNS provider. The domain goes live once they validate — use{' '}
            <b>Check again</b> to re-poll.
          </div>
          {records.length > 0 ? <DnsRecords records={records} /> : <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Recorded — issuance will start shortly.</div>}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Select
            label="App"
            options={appOptions.length ? appOptions : [{ value: '', label: 'No apps yet', disabled: true }]}
            value={chosen}
            onChange={(e) => setAppScopeId(e.target.value)}
          />
          <Input
            label="Domain"
            placeholder="legal.acme.com"
            mono
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
          />
          {error && <div style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{error}</div>}
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            After adding, we’ll show the DNS records to publish. Certificate issuance is automatic once they validate.
          </div>
        </div>
      )}
    </Dialog>
  );
}
