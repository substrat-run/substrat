import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Dialog, Input, Select, Tabs } from '@substrat-run/ui';
import { ApiError, type FindingEntry, type FindingRuleEntry } from '../lib/api.generated';
import { relativeTime, untilTime } from '../lib/format';
import { card } from '../components/ui';
import { AiText } from '../components/AiText';
import {
  EXPIRY_CHOICES,
  FINDING_TABS,
  canSuppress,
  REASON_MAX,
  countByStatus,
  countIsExact,
  draftFor,
  draftNarrows,
  draftReady,
  findingsError,
  inTab,
  mergeFindings,
  movesFrom,
  ruleInput,
  ruleScope,
  type FindingCursors,
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

// The plane owns severity and kind (#2401): one this page does not know is shown as the plane named
// it. Maps, not object literals: a value named like an Object.prototype key must not find one.
const SEVERITY = new Map<string, 'danger' | 'warning' | 'info'>([
  ['critical', 'danger'],
  ['warning', 'warning'],
  ['info', 'info'],
]);

const KIND_LABEL = new Map([
  ['invariant', 'Invariant'],
  ['drift', 'Drift'],
  ['recurring', 'Recurring'],
]);
const kindLabel = (kind: string) => KIND_LABEL.get(kind) ?? kind;

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'unavailable' }
  | { state: 'ready'; entries: FindingEntry[]; cursors: FindingCursors; rules: FindingRuleEntry[] };

const STATUSES = FINDING_TABS.map((t) => t.value);

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
  // Every finding or rule with a request in flight: one row's work never frees or spins another's.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const latest = useRef(0);
  const [suppressing, setSuppressing] = useState<FindingEntry | null>(null);
  const [notice, setNotice] = useState('');
  // The tab whose next page is being fetched, and why the last such fetch failed. The failure
  // sits beside the list, which keeps every page already loaded.
  const [loadingMore, setLoadingMore] = useState<FindingStatus | null>(null);
  const [moreError, setMoreError] = useState('');

  const read = useCallback(async (): Promise<Load> => {
    try {
      // The first page of every tab, so each can say whether its walk is already over (an exact
      // count) or has more behind it (Load more).
      const [pages, rules] = await Promise.all([
        Promise.all(STATUSES.map((status) => client.listFindings({ status }))),
        client.listFindingRules({ active: true }),
      ]);
      if (pages.some((p) => !p.available)) return { state: 'unavailable' };
      return {
        state: 'ready',
        entries: pages.reduce<FindingEntry[]>((all, p) => mergeFindings(all, p.entries), []),
        cursors: Object.fromEntries(STATUSES.map((status, i) => [status, { next: pages[i]!.nextCursor ?? null, cut: pages[i]!.cut === true }])) as FindingCursors,
        rules: rules.entries,
      };
    } catch (e) {
      return { state: 'error', message: findingsError(e, 'read') };
    }
  }, [client]);

  // Only the newest read may land: a slow answer to an older one is dropped.
  useEffect(() => {
    const mine = ++latest.current;
    setLoad({ state: 'loading' });
    setMoreError('');
    void read().then((l) => mine === latest.current && setLoad(l));
    return () => {
      latest.current += 1;
    };
  }, [read, nonce]);

  /**
   * Re-read after a change that already succeeded. A failure here must not blank the list the
   * person is looking at, so it keeps it and says it may be stale.
   */
  const reload = async () => {
    const mine = ++latest.current;
    const next = await read();
    if (mine !== latest.current) return;
    if (next.state === 'ready') setLoad(next);
    else setActionError('The list could not be refreshed, so what is shown may be out of date.');
  };

  /**
   * The next page of one tab, appended and de-duplicated by id. A failure keeps what is loaded
   * and the cursor, so pressing the button again retries the same page. An answer that lands
   * after a refresh began belongs to a list that is gone: dropped, like a slow first read.
   */
  const loadMore = async (tab: FindingStatus, cursor: string) => {
    const mine = latest.current;
    setLoadingMore(tab);
    setMoreError('');
    try {
      const page = await client.listFindings({ status: tab, cursor });
      if (mine !== latest.current) return;
      setLoad((l) =>
        l.state === 'ready'
          ? { ...l, entries: mergeFindings(l.entries, page.entries), cursors: { ...l.cursors, [tab]: { next: page.nextCursor ?? null, cut: page.cut === true } } }
          : l,
      );
    } catch (e) {
      if (mine === latest.current) setMoreError(findingsError(e, 'read'));
    } finally {
      setLoadingMore((t) => (t === tab ? null : t));
    }
  };

  const working = async (id: string, work: () => Promise<void>) => {
    setBusy((b) => new Set(b).add(id));
    setActionError('');
    setNotice('');
    try {
      await work();
    } finally {
      setBusy((b) => {
        const rest = new Set(b);
        rest.delete(id);
        return rest;
      });
    }
  };

  const move = (f: FindingEntry, to: FindingMove) =>
    working(f.id, async () => {
      try {
        const next = await client.setFindingStatus({ id: f.id, status: to });
        setLoad((l) => (l.state === 'ready' ? { ...l, entries: l.entries.map((e) => (e.id === f.id ? next : e)) } : l));
      } catch (e) {
        setActionError(findingsError(e, 'change'));
        if (e instanceof ApiError && e.status === 404) await reload();
      }
    });

  const revoke = (r: FindingRuleEntry) =>
    working(r.id, async () => {
      try {
        await client.revokeFindingRule({ ruleId: r.id });
        // Its findings stay suppressed until their next occurrence, which then opens them.
        setNotice('Rule revoked. Its findings stay suppressed until their next occurrence, which then opens them.');
        await reload();
      } catch (e) {
        setActionError(findingsError(e, 'change', 'rule'));
        if (e instanceof ApiError && e.status === 404) await reload();
      }
    });

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
  const more = load.cursors[tab].next;
  const cut = load.cursors[tab].cut;
  return (
    <>
      <Tabs
        // A tab still being walked counts what is loaded, not the team's total: left off until its walk ends.
        tabs={FINDING_TABS.map((t) => ({ value: t.value, label: t.label, ...(countIsExact(load.cursors, t.value) ? { count: counts[t.value] } : {}) }))}
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
              busy={busy.has(f.id)}
              onMove={(to) => void move(f, to)}
              onSuppress={() => { setActionError(''); setSuppressing(f); }}
              client={client}
            />
          ))
        )}
        {more !== null && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px' }}>
            <Button variant="secondary" size="sm" loading={loadingMore === tab} onClick={() => void loadMore(tab, more)}>
              Load more
            </Button>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              Showing {rows.length} by last seen; older findings follow.
            </span>
          </div>
        )}
      </div>
      {cut && (
        <div role="status" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          Showing the latest {rows.length} findings by last seen. Older ones cannot be listed until the platform finishes updating, so this tab carries no count.
        </div>
      )}
      {moreError && <div role="alert" style={{ fontSize: 13, color: 'var(--status-danger-fg)' }}>{moreError}</div>}
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
                <Button variant="secondary" size="sm" loading={busy.has(r.id)} onClick={() => void revoke(r)}>
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
          const out = await client.createFindingRule(ruleInput(draft, Date.now()));
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
  client,
}: {
  f: FindingEntry;
  canManage: boolean;
  busy: boolean;
  onMove: (to: FindingMove) => void;
  onSuppress: () => void;
  client: FindingsClient;
}) {
  const moves = movesFrom(f.status);
  // #1749: closed until asked, so a page of findings reads no evidence it does not show.
  const [explaining, setExplaining] = useState(false);
  const loadExplanation = useCallback(() => client.getFindingExplanation({ id: f.id }), [client, f.id]);
  const writeExplanation = useCallback(() => client.writeFindingExplanation({ id: f.id }), [client, f.id]);
  return (
    <div
      role="group"
      aria-label={f.title}
      data-finding={f.id}
      style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}
    >
      <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Badge status={SEVERITY.get(f.severity) ?? 'neutral'}>{f.severity}</Badge>
          <span style={{ fontSize: 14, fontWeight: 550, color: 'var(--text-primary)' }}>{f.title}</span>
          {f.regressed && <Badge status="warning" dot={false}>Regressed</Badge>}
          <Badge status="neutral" dot={false}>{kindLabel(f.kind)}</Badge>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
          {f.count.toLocaleString('en-US')} {f.count === 1 ? 'occurrence' : 'occurrences'} · first seen {relativeTime(f.firstSeen)} · last seen {relativeTime(f.lastSeen)}
          {f.codes.length > 0 && <> · <span style={{ fontFamily: 'var(--font-mono)' }}>{f.codes.join(', ')}</span></>}
        </div>
        {f.likelyCause && (
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            Likely cause: {f.likelyCause.kind} <span style={{ fontFamily: 'var(--font-mono)' }}>{f.likelyCause.version}</span> — {f.likelyCause.reason}
          </div>
        )}
        {f.status === 'suppressed' && f.ruleId && (
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Held by a suppress rule; revoke the rule below to let it open again.</div>
        )}
        <div>
          <Button variant="ghost" size="sm" onClick={() => setExplaining((x) => !x)}>
            {explaining ? 'Hide AI explanation' : 'AI explanation'}
          </Button>
        </div>
        {explaining && <AiText load={loadExplanation} write={writeExplanation} writeLabel="Explain this finding" />}
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
          label="Kind"
          options={[{ value: '', label: 'Any kind' }, { value: finding.kind, label: kindLabel(finding.kind) }]}
          value={draft.kind}
          onChange={(e) => set({ kind: e.target.value })}
        />
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
        <Input label="Reason" maxLength={REASON_MAX} value={draft.reason} onChange={(e) => set({ reason: e.target.value })} style={{ width: '100%' }} />
        {!draftNarrows(draft) && (
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Pick at least one of kind, operation, code or subject, or the rule would match everything.</div>
        )}
        {error && <div role="alert" style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{error}</div>}
      </div>
    </Dialog>
  );
}

const emptyDraft: SuppressDraft = { kind: '', operation: '', code: '', subject: '', days: '7', reason: '' };
