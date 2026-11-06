import { useEffect, useRef, useState } from 'react';
import type { BuilderTurn, BuilderTurnDetail, BuilderTurnOutcome, Tenant, TenantId } from '@substrat-run/contracts';
import { Badge, Button, Card, Select, Table, Tag, UNSET_BUTTON } from '../components';
import type { Api } from '../lib/api';
import { metricsLine, timelineOf } from '../lib/builder-turn';

const PAGE = 25;

const OUTCOME_BADGE: Record<BuilderTurnOutcome, 'success' | 'danger' | 'warning' | 'neutral'> = {
  done: 'success',
  error: 'danger',
  interrupted: 'warning',
  stopped: 'neutral',
};

export interface BuilderTurnsProps {
  api: Api;
  tenants: Map<TenantId, Tenant>;
}

const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' };

/** One turn opened: why it was red, then everything it recorded, in order. */
function TurnDetail({ api, turn }: { api: Api; turn: BuilderTurn }) {
  const [detail, setDetail] = useState<BuilderTurnDetail>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    api.getBuilderTurn(turn.turnId).then(
      (d) => live && setDetail(d),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [api, turn.turnId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12.5 }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
        <span>turn {turn.turnId}</span>
        <span>project {turn.projectId}</span>
        {turn.model && <span>{turn.model}</span>}
        {turn.phaseStart && <span>phase {turn.phaseStart}{turn.phaseEnd && turn.phaseEnd !== turn.phaseStart ? ` → ${turn.phaseEnd}` : ''}</span>}
        {turn.commitSha && <span>commit {turn.commitSha.slice(0, 8)}</span>}
        {metricsLine(turn).map((fact) => <span key={fact}>{fact}</span>)}
        {turn.truncated && <span>truncated</span>}
      </div>
      {turn.failure && <div style={{ ...mono, color: 'var(--status-danger-fg)' }}>{turn.failure}</div>}
      {error && <div style={{ color: 'var(--status-danger-fg)' }}>{error}</div>}
      {!detail && !error && <div style={{ color: 'var(--text-placeholder)' }}>Loading the turn…</div>}
      {detail && detail.events.length === 0 && (
        <div style={{ color: 'var(--text-placeholder)' }}>Nothing of this turn reached the record.</div>
      )}
      {detail &&
        timelineOf(detail.events).map((item) => (
          <div key={item.id} style={{ display: 'flex', gap: 10 }}>
            <span style={{ width: 92, flexShrink: 0, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
              {item.kind === 'host' ? item.event : item.kind}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  ...(item.kind === 'host' || item.kind === 'end' ? mono : { whiteSpace: 'pre-wrap' }),
                  color: item.kind === 'end' && item.failed ? 'var(--status-danger-fg)' : 'var(--text-primary)',
                }}
              >
                {item.text}
              </div>
              {item.kind === 'host' && item.output && (
                <pre style={{ ...mono, margin: '6px 0 0', padding: 8, background: 'var(--surface-inset)', borderRadius: 6, maxHeight: 320, overflow: 'auto' }}>
                  {item.output}
                </pre>
              )}
            </div>
          </div>
        ))}
      {detail?.cut && <div style={{ color: 'var(--text-tertiary)' }}>The turn has more events than one read returns; the rest are not shown.</div>}
    </div>
  );
}

/**
 * Operations → Builder turns: every builder-studio turn across every team,
 * newest first, from the summary each turn leaves when it closes. Filtered to
 * the turns that went wrong by default — an error, a stop, an interrupted
 * turn, or a last gate run that stayed red — because that is what this page is
 * for. A row opens the turn: the red gates' output and everything it recorded.
 */
export function BuilderTurns({ api, tenants }: BuilderTurnsProps) {
  const [entries, setEntries] = useState<BuilderTurn[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string>();
  const [error, setError] = useState<string>();
  const [loadingOlder, setLoadingOlder] = useState(false);

  const [tenantFilter, setTenantFilter] = useState('all');
  const [outcomeFilter, setOutcomeFilter] = useState<'all' | BuilderTurnOutcome>('all');
  const [gateFilter, setGateFilter] = useState('all');
  const [troubled, setTroubled] = useState(true);

  const filter = {
    tenantId: tenantFilter === 'all' ? undefined : tenantFilter,
    outcome: outcomeFilter === 'all' ? undefined : outcomeFilter,
    redGate: gateFilter === 'all' ? undefined : gateFilter,
    troubled: troubled || undefined,
  };

  // A filter change makes an in-flight older-page fetch stale (the SweepRuns posture).
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    let live = true;
    void (async () => {
      try {
        const page = await api.listBuilderTurns({ limit: PAGE, ...filter });
        if (!live) return;
        setEntries(page.entries);
        setCursor(page.nextCursor);
        setError(undefined);
      } catch (e) {
        if (!live) return;
        setEntries([]);
        setCursor(null);
        setError((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, tenantFilter, outcomeFilter, gateFilter, troubled]);

  async function loadOlder() {
    // One older page at a time: a second click on the same cursor would append it twice.
    if (!cursor || loadingOlder) return;
    const at = generation.current;
    setLoadingOlder(true);
    try {
      const page = await api.listBuilderTurns({ limit: PAGE, cursor, ...filter });
      if (at !== generation.current) return;
      setEntries((prev) => [...prev, ...page.entries]);
      setCursor(page.nextCursor);
      setError(undefined);
    } catch (e) {
      if (at === generation.current) setError((e as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  }

  // The gates offered are the ones the turns name, never a copy of the builder's list that drifts
  // when a gate is added; the chosen one stays offered when a filter leaves no row naming it.
  const gates = [...new Set([...entries.flatMap((t) => t.redGates.map((g) => g.name)), ...(gateFilter === 'all' ? [] : [gateFilter])])].sort();

  const columns = ['Ended', 'Team', 'Project', 'Outcome', 'Red gates', 'Repairs', 'Tokens'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
          Builder turns
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-tertiary)', maxWidth: 640 }}>
          Every builder-studio turn, every team, newest first. <em>Red gates</em> are the gates the turn's last run left
          failing, after its repair passes. Open a turn for the gates' output and everything it recorded.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Select
          options={[
            { value: 'trouble', label: 'Only turns that went wrong' },
            { value: 'all', label: 'All turns' },
          ]}
          value={troubled ? 'trouble' : 'all'}
          onChange={(e) => setTroubled(e.target.value === 'trouble')}
          style={{ width: 210 }}
        />
        <Select
          options={[
            { value: 'all', label: 'All outcomes' },
            { value: 'done', label: 'done' },
            { value: 'error', label: 'error' },
            { value: 'stopped', label: 'stopped' },
            { value: 'interrupted', label: 'interrupted' },
          ]}
          value={outcomeFilter}
          onChange={(e) => setOutcomeFilter(e.target.value as typeof outcomeFilter)}
          style={{ width: 140 }}
        />
        <Select
          options={[{ value: 'all', label: 'Any red gate' }, ...gates.map((g) => ({ value: g, label: g }))]}
          value={gateFilter}
          onChange={(e) => setGateFilter(e.target.value)}
          style={{ width: 160 }}
        />
        <Select
          options={[{ value: 'all', label: 'All teams' }, ...[...tenants.values()].map((t) => ({ value: t.id, label: t.slug }))]}
          value={tenantFilter}
          onChange={(e) => setTenantFilter(e.target.value)}
          style={{ width: 160 }}
        />
      </div>

      {error && (
        <Card>
          <span style={{ fontSize: 13, color: 'var(--status-danger-fg)' }}>{error}</span>
        </Card>
      )}

      <Card padding={0} footer="Turns recorded since the turn summaries shipped. Row click opens the turn. Cursor-paginated.">
        <Table
          label="Builder turns"
          rows={entries}
          rowKey={(t) => t.id}
          expanded={expanded}
          onRowClick={(t) => setExpanded(expanded === t.id ? undefined : t.id)}
          detail={(t) => (
            <div id={`turn-detail-${t.id}`}>
              {t.redGates.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
                  {t.redGates.map((g) => (
                    <div key={g.name} style={{ ...mono, fontSize: 12.5, color: 'var(--status-danger-fg)' }}>
                      {g.name} ({g.status}): {g.line}
                    </div>
                  ))}
                </div>
              )}
              <TurnDetail api={api} turn={t} />
            </div>
          )}
          emptyText={error ? 'The turns could not be read.' : troubled ? 'No turn went wrong. Switch to all turns to see the rest.' : 'No turns recorded yet.'}
          columns={[
            { header: 'Ended', mono: true, muted: true, render: (t) => t.endedAt.slice(0, 19).replace('T', ' ') },
            { header: 'Team', mono: true, muted: true, render: (t) => tenants.get(t.tenantId as TenantId)?.slug ?? t.tenantId.slice(0, 8) },
            {
              header: 'Project',
              render: (t) => (
                // The keyboard path into the detail row — the row's click is pointer-only.
                <button
                  type="button"
                  aria-expanded={expanded === t.id}
                  aria-controls={expanded === t.id ? `turn-detail-${t.id}` : undefined}
                  onClick={() => setExpanded(expanded === t.id ? undefined : t.id)}
                  style={{ ...UNSET_BUTTON, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {t.projectName || t.projectId}
                </button>
              ),
            },
            { header: 'Outcome', render: (t) => <Badge status={OUTCOME_BADGE[t.outcome]}>{t.outcome}</Badge> },
            {
              header: 'Red gates',
              render: (t) =>
                t.redGates.length > 0 ? (
                  <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                    {t.redGates.map((g) => (
                      <Tag key={g.name} mono>
                        {g.name}
                      </Tag>
                    ))}
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-placeholder)' }}>{t.gatesOk === null ? '—' : 'none'}</span>
                ),
            },
            { header: 'Repairs', mono: true, render: (t) => t.repairs },
            {
              header: 'Tokens in / out',
              mono: true,
              muted: true,
              render: (t) => `${(t.inputTokens / 1000).toFixed(1)}k / ${(t.outputTokens / 1000).toFixed(1)}k`,
            },
          ]}
        />
        {cursor && (
          <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}>
            <Button variant="ghost" size="sm" disabled={loadingOlder} onClick={() => void loadOlder()}>
              {loadingOlder ? 'Loading…' : 'Load older turns'}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
