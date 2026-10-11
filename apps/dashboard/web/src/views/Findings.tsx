import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Dialog, Input, Select, Tabs } from '@substrat-run/ui';
import type { FindingEntry, FindingRuleEntry } from '../lib/api.generated';
import { relativeTime, untilTime } from '../lib/format';
import { card } from '../components/ui';
import {
  EXPIRY_CHOICES,
  FINDING_TABS,
  canSuppress,
  countByStatus,
  draftFor,
  draftNarrows,
  draftReady,
  findingsError,
  inTab,
  movesFrom,
  ruleInput,
  ruleScope,
  type FindingMove,
  type FindingStatus,
  type SuppressDraft,
} from '../lib/findings';
import type { FindingsClient } from '../lib/mock-findings';

/**
 * The Findings inbox (#1748): the team's anomalies, triaged like email. Four tabs, one per
 * status; acknowledge, resolve and reopen move a finding between them, and suppress turns a
 * finding's scope into a rule with an expiry — matching anomalies are still recorded, no
 * finding opens.
 *
 * Who may do what is the plane's call (`dashboard:read-findings`, `dashboard:manage-findings`):
 * `canManage` only decides whether the actions are drawn, and every action still handles the
 * refusal, because the role the page guessed from may be a reload behind the answer.
 */

const SEVERITY: Record<FindingEntry['severity'], 'danger' | 'warning' | 'info'> = {
  critical: 'danger',
  warning: 'warning',
  info: 'info',
};

const KIND_LABEL: Record<FindingEntry['kind'], string> = { invariant: 'Invariant', drift: 'Drift', recurring: 'Recurring' };

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'unavailable' } | { state: 'ready'; entries: FindingEntry[]; rules: FindingRuleEntry[] };

export function Findings({
  client,
  tab,
  canManage,
  nonce,
  onTab,
}: {
  client: FindingsClient;
  tab: FindingStatus;
  /** A hint for drawing the actions; the plane is the gate. */
  canManage: boolean;
  nonce: number;
  onTab: (tab: FindingStatus) => void;
}) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  // One message for the last action that failed, over the list it failed on.
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [suppressing, setSuppressing] = useState<FindingEntry | null>(null);
  const [notice, setNotice] = useState('');

  const read = useCallback(async (): Promise<Load> => {
    try {
      const [list, rules] = await Promise.all([client.listFindings({}), client.listFindingRules({ active: true })]);
      return list.available ? { state: 'ready', entries: list.entries, rules: rules.entries } : { state: 'unavailable' };
    } catch (e) {
      return { state: 'error', message: findingsError(e, 'read') };
    }
  }, [client]);

  useEffect(() => {
    let live = true;
    setLoad({ state: 'loading' });
    void read().then((l) => live && setLoad(l));
    return () => {
      live = false;
    };
  }, [read, nonce]);

  const reload = async () => setLoad(await read());

  const move = async (f: FindingEntry, to: FindingMove) => {
    setBusy(f.id);
    setActionError('');
    setNotice('');
    try {
      const next = await client.setFindingStatus({ id: f.id, status: to });
      setLoad((l) => (l.state === 'ready' ? { ...l, entries: l.entries.map((e) => (e.id === f.id ? next : e)) } : l));
    } catch (e) {
      setActionError(findingsError(e, 'change'));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (r: FindingRuleEntry) => {
    setBusy(r.id);
    setActionError('');
    setNotice('');
    try {
      await client.revokeFindingRule({ ruleId: r.id });
      await reload();
    } catch (e) {
      setActionError(findingsError(e, 'change'));
    } finally {
      setBusy(null);
    }
  };

  const quiet = { ...card, padding: 16, fontSize: 13, color: 'var(--text-tertiary)' } as const;
  if (load.state === 'loading') return <div style={quiet} role="status">Loading findings…</div>;
  if (load.state === 'error') {
    return (
      <div style={{ ...quiet, color: 'var(--status-danger-fg)' }} role="alert">
        {load.message}
      </div>
    );
  }
  if (load.state === 'unavailable') return <div style={quiet}>Findings are not available on this platform yet.</div>;

  const counts = countByStatus(load.entries);
  const rows = inTab(load.entries, tab);
  return (
    <>
      <Tabs
        tabs={FINDING_TABS.map((t) => ({ value: t.value, label: t.label, count: counts[t.value] }))}
        value={tab}
        onChange={(v) => onTab(v as FindingStatus)}
      />
      {notice && <div role="status" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{notice}</div>}
      {actionError && <div role="alert" style={{ fontSize: 13, color: 'var(--status-danger-fg)' }}>{actionError}</div>}
      <div style={{ ...card, padding: 0 }}>
        {rows.length === 0 ? (
          <div style={{ padding: 16, fontSize: 13, color: 'var(--text-tertiary)' }}>{emptyText(tab, load.entries.length)}</div>
        ) : (
          rows.map((f) => (
            <FindingRow
              key={f.id}
              f={f}
              canManage={canManage}
              busy={busy === f.id}
              onMove={(to) => void move(f, to)}
              onSuppress={() => { setActionError(''); setSuppressing(f); }}
            />
          ))
        )}
      </div>
      {tab === 'suppressed' && load.rules.length > 0 && (
        <section aria-label="Suppress rules" style={{ ...card, padding: 0 }}>
          <div style={{ padding: '10px 16px', fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
            Suppress rules
          </div>
          {load.rules.map((r) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--text-primary)' }}>
                <span style={{ fontFamily: 'var(--font-mono)' }}>{ruleScope(r)}</span>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                  {r.reason} · expires {untilTime(r.expiresAt)}
                </div>
              </div>
              {canManage && (
                <Button variant="secondary" size="sm" loading={busy === r.id} onClick={() => void revoke(r)}>
                  Revoke rule
                </Button>
              )}
            </div>
          ))}
        </section>
      )}
      <SuppressDialog
        finding={suppressing}
        onCancel={() => setSuppressing(null)}
        onSubmit={async (draft, f) => {
          const out = await client.createFindingRule(ruleInput(draft, f.kind, Date.now()));
          setSuppressing(null);
          setNotice(
            `Rule created. ${out.suppressed} ${out.suppressed === 1 ? 'finding' : 'findings'} suppressed; matching anomalies are still recorded.`,
          );
          await reload();
        }}
      />
    </>
  );
}

function emptyText(tab: FindingStatus, total: number): string {
  if (tab === 'open') return total === 0 ? 'No findings. Nothing has broken a rule or drifted yet.' : 'Nothing open. Every finding has been triaged.';
  if (tab === 'acked') return 'Nothing acknowledged. Acknowledge a finding to say someone is looking at it.';
  if (tab === 'resolved') return 'Nothing resolved yet.';
  return 'Nothing suppressed. A suppress rule keeps a known anomaly from opening a finding.';
}

function FindingRow({
  f,
  canManage,
  busy,
  onMove,
  onSuppress,
}: {
  f: FindingEntry;
  canManage: boolean;
  busy: boolean;
  onMove: (to: FindingMove) => void;
  onSuppress: () => void;
}) {
  const moves = movesFrom(f.status);
  return (
    <div
      role="group"
      aria-label={f.title}
      data-finding={f.id}
      style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}
    >
      <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Badge status={SEVERITY[f.severity]}>{f.severity}</Badge>
          <span style={{ fontSize: 14, fontWeight: 550, color: 'var(--text-primary)' }}>{f.title}</span>
          {f.regressed && <Badge status="warning" dot={false}>Regressed</Badge>}
          <Badge status="neutral" dot={false}>{KIND_LABEL[f.kind]}</Badge>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
          {f.count.toLocaleString('en-US')} {f.count === 1 ? 'occurrence' : 'occurrences'} · first seen {relativeTime(f.firstSeen)} · last seen {relativeTime(f.lastSeen)}
          {f.codes.length > 0 && <> · <span style={{ fontFamily: 'var(--font-mono)' }}>{f.codes.join(', ')}</span></>}
        </div>
        {f.likelyCause && (
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            Likely cause: deploy <span style={{ fontFamily: 'var(--font-mono)' }}>{f.likelyCause.version}</span> — {f.likelyCause.reason}
          </div>
        )}
        {f.status === 'suppressed' && f.ruleId && (
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Held by a suppress rule; revoke the rule below to let it open again.</div>
        )}
      </div>
      {canManage && (moves.length > 0 || canSuppress(f.status)) && (
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {moves.map((m) => (
            <Button key={m.to} variant="secondary" size="sm" loading={busy} onClick={() => onMove(m.to)}>
              {m.label}
            </Button>
          ))}
          {canSuppress(f.status) && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={onSuppress}>
              Suppress…
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function SuppressDialog({
  finding,
  onCancel,
  onSubmit,
}: {
  finding: FindingEntry | null;
  onCancel: () => void;
  onSubmit: (draft: SuppressDraft, f: FindingEntry) => Promise<void>;
}) {
  const [draft, setDraft] = useState<SuppressDraft>(() => (finding ? draftFor(finding) : emptyDraft));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A different finding is a different dialog: its own scope, nothing left from the last.
  useEffect(() => {
    if (finding) setDraft(draftFor(finding));
    setError('');
  }, [finding?.id]);

  if (!finding) return null;
  const set = (patch: Partial<SuppressDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await onSubmit(draft, finding);
    } catch (e) {
      setError(findingsError(e, 'change'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title="Suppress matching anomalies"
      description="Matching anomalies are still recorded, but no finding opens for them until the rule expires."
      confirmLabel={busy ? 'Suppressing…' : 'Suppress'}
      confirmDisabled={!draftReady(draft)}
      busy={busy}
      onConfirm={() => void submit()}
      onCancel={onCancel}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Select
          label="Operation"
          options={[{ value: '', label: 'Any operation' }, ...(finding.operation ? [{ value: finding.operation, label: finding.operation }] : [])]}
          value={draft.operation}
          onChange={(e) => set({ operation: e.target.value })}
        />
        <Select
          label="Error code"
          options={[{ value: '', label: 'Any code' }, ...finding.codes.map((c) => ({ value: c, label: c }))]}
          value={draft.code}
          onChange={(e) => set({ code: e.target.value })}
        />
        <Select
          label="Subject"
          options={[{ value: '', label: 'Any subject' }, { value: finding.subject, label: finding.subject }]}
          value={draft.subject}
          onChange={(e) => set({ subject: e.target.value })}
        />
        <Select
          label="Expires in"
          options={EXPIRY_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
          value={draft.days}
          onChange={(e) => set({ days: e.target.value })}
        />
        <Input label="Reason" value={draft.reason} onChange={(e) => set({ reason: e.target.value })} style={{ width: '100%' }} />
        {!draftNarrows(draft) && (
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Pick at least one of operation, code or subject, or the rule would match everything.</div>
        )}
        {error && <div role="alert" style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{error}</div>}
      </div>
    </Dialog>
  );
}

const emptyDraft: SuppressDraft = { operation: '', code: '', subject: '', days: '7', reason: '' };
