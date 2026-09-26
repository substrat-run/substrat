import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Badge, Button, Input, Select } from '@substrat-run/ui';
import { api, ApiError, type AccountIntegration, type AppHealthRow, type AppRow, type AuditEntry, type InstallStep } from '../lib/api';
import { DEV_MOCK, MOCK_FLEET_HEALTH } from '../lib/mock';
import { MOCK_OVERVIEW_AUDIT, MOCK_OVERVIEW_INTEGRATIONS } from '../lib/mock-overview';
import { VERDICTS, fleetRows, type FleetRow } from '../lib/fleet-rows';
import { activityRows, appHref, attentionRows, clock, filterApps, integrationRows, statusSentence, type AppsFilter, type Read } from '../lib/overview-status';
import { navigate, obsPath, teamPath } from '../lib/router';
import { Ic } from '../lib/icons';
import { AppCard } from '../components/AppCard';
import { Page } from '../components/layout';
import { Onboarding, toCard } from './Apps';

const cardStyle: CSSProperties = { border: '1px solid var(--border-default)', borderRadius: 12, background: 'var(--surface-card)', boxShadow: 'var(--shadow-sm)', overflow: 'hidden' };
const quiet: CSSProperties = { padding: '12px 16px', borderTop: '1px solid var(--border-subtle)', fontSize: 13, color: 'var(--text-tertiary)' };

const TONE: Record<string, string> = {
  danger: 'var(--status-danger-fg)',
  warning: 'var(--status-warning-fg)',
  success: 'var(--status-success-fg)',
  info: 'var(--status-info-fg)',
  neutral: 'var(--text-tertiary)',
};

/**
 * The Overview home (#1815, design screen 1): "is anything wrong, and what do I need
 * to do?" in plain words. Three team-wide reads — fleet verdicts, integrations, the
 * audit log — one call each, no per-app fan-out. Each section stands on its own read:
 * one that fails says so in its own card, and the others still render.
 *
 * The app list arrives a page at a time, and the status sentence counts the whole
 * fleet, so the pages are walked to exhaustion the way the Apps table walks them.
 */
export function Overview({
  apps,
  loading,
  teamName,
  onCreate,
  onOpen,
  onRetry,
  onResume,
  loadSteps,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  apps: AppRow[];
  loading?: boolean;
  teamName: string;
  onCreate: () => void;
  onOpen: (scopeId: string) => void;
  onRetry: (scopeId: string) => void;
  onResume?: (scopeId: string) => void;
  loadSteps?: (scopeId: string) => Promise<InstallStep[]>;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  const [health, setHealth] = useState<Read<AppHealthRow[]>>(null);
  const [integrations, setIntegrations] = useState<Read<AccountIntegration[]>>(null);
  const [audit, setAudit] = useState<Read<AuditEntry[]>>(null);
  const [auditUnavailable, setAuditUnavailable] = useState(false);
  const [landedAt, setLandedAt] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<AppsFilter>('all');

  useEffect(() => {
    if (DEV_MOCK) {
      setHealth(MOCK_FLEET_HEALTH);
      setIntegrations(MOCK_OVERVIEW_INTEGRATIONS.providers);
      setAudit(MOCK_OVERVIEW_AUDIT);
      return;
    }
    let live = true;
    api.fleetHealth().then((r) => live && setHealth(r.rows)).catch(() => live && setHealth('failed'));
    api.integrations().then((v) => live && setIntegrations(v.providers)).catch(() => live && setIntegrations('failed'));
    api
      .auditLogAll({ limit: 6 })
      .then((p) => live && setAudit(p.entries))
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 501) setAuditUnavailable(true);
        setAudit('failed');
      });
    return () => {
      live = false;
    };
  }, []);

  const walking = !!hasMore && !!onLoadMore;
  useEffect(() => {
    if (walking && !loadingMore) onLoadMore!();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the row count, as the Apps table's walk is
  }, [walking, apps.length]);

  const settled = health !== null && integrations !== null && audit !== null;
  useEffect(() => {
    if (settled) setLandedAt(Date.now());
  }, [settled]);

  const rows = useMemo(() => fleetRows({ apps, health: Array.isArray(health) ? health : null, metrics: null }), [apps, health]);
  const byScope = useMemo(() => new Map(apps.map((a) => [a.app_scope_id, a])), [apps]);

  if (!loading && apps.length === 0) return <Onboarding onCreate={onCreate} />;

  const ready = !loading && !walking && health !== null && integrations !== null;
  const sentence = ready ? statusSentence({ apps: rows, healthRead: health === 'failed' ? 'failed' : 'ok', integrations: integrations === 'failed' ? 'failed' : integrations! }) : null;
  const attention = ready ? attentionRows({ apps: rows, integrations }) : null;
  const shown = filterApps(rows, q, filter);

  return (
    <Page>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>Overview</h1>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>{teamName} · the tools your team runs. Each app is its own isolated scope.</div>
        </div>
        <Button icon={<Ic name="plus" />} onClick={onCreate}>Create app</Button>
      </div>

      {/* The status sentence — composed from the reads below, never written (#1749 is where AI would write it). */}
      <div role="status" style={{ ...cardStyle, overflow: 'visible', display: 'flex', gap: 12, alignItems: 'flex-start', padding: '16px 18px' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 16, lineHeight: '24px', fontWeight: 500, color: 'var(--text-primary)', textWrap: 'pretty' } as CSSProperties}>
            {sentence ? sentence.headline : 'Reading app health and integrations…'}
          </div>
          {sentence?.detail && <div style={{ fontSize: 13.5, lineHeight: '21px', color: 'var(--text-secondary)', textWrap: 'pretty' } as CSSProperties}>{sentence.detail}</div>}
        </div>
        {landedAt !== null && <span style={{ fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>updated <span style={{ fontFamily: 'var(--font-mono)' }}>{clock(landedAt)}</span></span>}
      </div>

      <div style={cardStyle} aria-label="Needs attention">
        <div style={{ padding: '14px 16px 10px' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Needs attention</div>
          {attention && attention.length > 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', marginTop: 2 }}>
              {attention.length} {attention.length === 1 ? 'item' : 'items'}, worst first. Open a row for the app, its schedules or the integration.
            </div>
          )}
        </div>
        {attention === null ? (
          <div style={quiet}>Reading…</div>
        ) : attention.length === 0 ? (
          <div style={quiet}>Nothing needs attention.</div>
        ) : (
          attention.map((n) => (
            <Go key={n.key} href={n.href} style={{ display: 'grid', gridTemplateColumns: '96px 150px minmax(0,1fr) 110px', gap: '0 12px', alignItems: 'center', minHeight: 44, padding: '6px 16px', borderTop: '1px solid var(--border-subtle)' }}>
              <span><Badge status={n.status}>{n.badge}</Badge></span>
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.what}</span>
                <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.where}</span>
              </span>
              <span style={{ fontSize: 13, lineHeight: '19px', color: 'var(--text-secondary)', textWrap: 'pretty' } as CSSProperties}>{n.text}</span>
              <span style={{ fontSize: 12.5, color: 'var(--text-link)', textAlign: 'right' }}>{n.action}</span>
            </Go>
          ))
        )}
        {integrations === 'failed' && <div style={quiet}>Integrations could not be read, so connection problems are not listed here.</div>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Apps</span>
          <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            {loading ? 'listing apps…' : `${apps.length} ${apps.length === 1 ? 'app' : 'apps'}${walking ? ' so far' : ''} · health in plain words, details in Observability`}
          </span>
          <span style={{ flex: 1 }} />
          <Input size="sm" ariaLabel="Search apps" placeholder="Search apps…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />
          <Select
            size="sm"
            ariaLabel="Status"
            options={[
              { value: 'all', label: 'All statuses' },
              { value: 'attention', label: 'Needs attention' },
              { value: 'working', label: 'Working' },
            ]}
            value={filter}
            onChange={(e) => setFilter(e.target.value as AppsFilter)}
            style={{ width: 140 }}
          />
        </div>
        {health === 'failed' && <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>App health could not be read, so no card claims its app is working.</span>}
        {!loading && shown.length === 0 ? (
          <div style={{ ...cardStyle, ...quiet, borderTop: undefined }}>No apps match.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 16, alignItems: 'start' }}>
            {shown.map((r) => {
              const row = byScope.get(r.scopeId)!;
              return (
                <AppCard
                  key={r.scopeId}
                  app={toCard(row)}
                  onOpen={() => onOpen(r.scopeId)}
                  onRetry={() => onRetry(r.scopeId)}
                  onResume={() => onResume?.(r.scopeId)}
                  loadSteps={loadSteps ? () => loadSteps(r.scopeId) : undefined}
                  health={cardHealth(r, health !== null)}
                  observeHref={obsPath({ app: r.scopeId })}
                />
              );
            })}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.4fr)', gap: 16, alignItems: 'start' }}>
        <div style={cardStyle} aria-label="Integrations">
          <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px' }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Integrations</span>
            <span style={{ flex: 1 }} />
            <Go href="/integrations" plain style={{ fontSize: 12.5, color: 'var(--text-link)' }}>Manage →</Go>
          </div>
          {integrations === null ? (
            <div style={quiet}>Reading…</div>
          ) : integrations === 'failed' ? (
            <div style={quiet}>Integrations could not be read.</div>
          ) : (
            <IntegrationList providers={integrations} />
          )}
        </div>

        <div style={cardStyle} aria-label="Recent activity">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px' }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Recent activity</span>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>who did what</span>
            <span style={{ flex: 1 }} />
            <Go href="/audit" plain style={{ fontSize: 12.5, color: 'var(--text-link)' }}>Open audit log →</Go>
          </div>
          {audit === null ? (
            <div style={quiet}>Reading…</div>
          ) : audit === 'failed' ? (
            <div style={quiet}>{auditUnavailable ? 'The audit log is served by the control plane, which isn’t available in this environment.' : 'The audit log could not be read.'}</div>
          ) : audit.length === 0 ? (
            <div style={quiet}>No audited actions yet.</div>
          ) : (
            activityRows(audit, (s) => byScope.get(s)?.name ?? null).map((e) => (
              <Go key={e.id} href={e.href} style={{ display: 'grid', gridTemplateColumns: '24px minmax(0,1fr) 84px', gap: '0 10px', alignItems: 'center', minHeight: 40, padding: '4px 16px', borderTop: '1px solid var(--border-subtle)' }}>
                <span aria-hidden style={{ width: 24, height: 24, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600, background: 'var(--surface-active)', color: 'var(--text-secondary)' }}>{e.initials}</span>
                <span style={{ fontSize: 13, lineHeight: '19px', color: 'var(--text-secondary)', textWrap: 'pretty' } as CSSProperties}>
                  <span title={e.actor} style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{e.who}</span> {e.text}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-tertiary)', textAlign: 'right' }}>{e.time}</span>
              </Go>
            ))
          )}
        </div>
      </div>
    </Page>
  );
}

/**
 * The card's health line. An app still installing, or whose install failed, already
 * says so in the card's own pill and install steps; a second line saying it again
 * would only push the Retry further down.
 */
function cardHealth(r: FleetRow, healthSettled: boolean) {
  if (r.verdict === 'installing' || r.verdict === 'install-failed') return undefined;
  if (!healthSettled) return { label: 'Checking', color: 'var(--text-tertiary)', text: 'reading health…', href: appHref(r) };
  const v = VERDICTS[r.verdict];
  return { label: v.label, color: TONE[v.status]!, text: r.why, href: appHref(r) };
}

function IntegrationList({ providers }: { providers: AccountIntegration[] }) {
  const rows = integrationRows(providers);
  if (rows.length === 0) return <div style={quiet}>No integrations are connected yet.</div>;
  return (
    <>
      {rows.map((i) => (
        <Go key={i.provider} href="/integrations" style={{ display: 'grid', gridTemplateColumns: '130px minmax(0,1fr)', gap: '0 10px', alignItems: 'center', minHeight: 44, padding: '6px 16px', borderTop: '1px solid var(--border-subtle)' }}>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>{i.name}</span>
            <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.used}</span>
          </span>
          <span style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 12.5, lineHeight: '18px', minWidth: 0 }}>
            <span style={{ width: 7, height: 7, flexShrink: 0, marginTop: 5, borderRadius: '50%', background: TONE[i.tone] }} />
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              <span style={{ color: TONE[i.tone], fontWeight: 500 }}>{i.state}</span> <span style={{ color: 'var(--text-secondary)' }}>{i.text}</span>
            </span>
          </span>
        </Go>
      ))}
    </>
  );
}

/** A row or link with a real href (open in new tab works) that navigates in place on a plain click. */
function Go({ href, style, plain, children }: { href: string; style: CSSProperties; plain?: boolean; children: ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <a
      href={teamPath(href)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ color: 'var(--text-primary)', textDecoration: 'none', cursor: 'pointer', ...(!plain && hover ? { background: 'var(--surface-hover)' } : {}), ...style }}
    >
      {children}
    </a>
  );
}
