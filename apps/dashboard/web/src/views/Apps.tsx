import { useMemo, useState } from 'react';
import { Button, Input, Select } from '@substrat-run/ui';
import type { AppRow } from '../lib/api';
import { verticalMeta } from '../lib/demo';
import { relativeTime } from '../lib/format';
import { Ic } from '../lib/icons';
import { AppCard, type AppCardData } from '../components/AppCard';
import { Page } from '../components/layout';
import { Pill, PageTitle, RowActions, card } from '../components/ui';

/** AppRow → the shape AppCard/list rows render. Version is unknown from the row today. */
export function toCard(a: AppRow): AppCardData & { scopeId: string } {
  const m = verticalMeta(a.vertical_slug);
  return {
    scopeId: a.app_scope_id,
    name: a.name,
    verticalLabel: m.label,
    version: '',
    status: a.status,
    host: a.hostname,
    updated: relativeTime(a.created_at),
    accent: m.accent,
  };
}

type Mode = 'grid' | 'list';

/**
 * Overview / My Apps (screens 1d, 1e, 1f). Real data from the worker. Loading →
 * the skeleton (never the empty state: flashing "Create your first app" at someone
 * who HAS apps reads as data loss); empty → the onboarding state; otherwise the
 * grid or list, filtered by search + status.
 */
export function Apps({
  apps,
  loading,
  onCreate,
  onOpen,
  onRetry,
}: {
  apps: AppRow[];
  loading?: boolean;
  onCreate: () => void;
  onOpen: (scopeId: string) => void;
  onRetry: (scopeId: string) => void;
}) {
  const [mode, setMode] = useState<Mode>('grid');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('All statuses');

  const cards = useMemo(() => apps.map(toCard), [apps]);
  const filtered = useMemo(
    () =>
      cards.filter((c) => {
        if (q && !c.name.toLowerCase().includes(q.toLowerCase())) return false;
        if (status !== 'All statuses' && c.status !== status.toLowerCase()) return false;
        return true;
      }),
    [cards, q, status],
  );

  if (loading) return <AppsSkeleton />;
  if (apps.length === 0) return <Onboarding onCreate={onCreate} />;

  return (
    <Page>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <PageTitle title="Apps" subtitle="The tools your team runs — each app is its own isolated scope." />
        <div style={{ flex: 1 }} />
        <Button icon={<Ic name="plus" />} onClick={onCreate}>Create App</Button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Input placeholder="Search apps…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 260 }} />
        <Select options={['All statuses', 'Active', 'Provisioning', 'Failed']} value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 150 }} />
        <div style={{ flex: 1 }} />
        <div style={{ display: 'inline-flex', border: '1px solid var(--border-default)', borderRadius: 6, overflow: 'hidden' }}>
          <SegBtn on={mode === 'grid'} onClick={() => setMode('grid')} label="Grid view"><Ic name="grid" size={14} /></SegBtn>
          <SegBtn on={mode === 'list'} onClick={() => setMode('list')} label="List view" divider><Ic name="list" size={14} /></SegBtn>
        </div>
      </div>

      {mode === 'grid' ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          {filtered.map((c) => (
            <AppCard key={c.scopeId} app={c} onOpen={() => onOpen(c.scopeId)} onRetry={() => onRetry(c.scopeId)} />
          ))}
        </div>
      ) : (
        <ListMode cards={filtered} onOpen={onOpen} onRetry={onRetry} />
      )}
    </Page>
  );
}

const COLS = '2fr 1.4fr 1fr 2fr 1fr 40px';
function ListMode({ cards, onOpen, onRetry }: { cards: Array<AppCardData & { scopeId: string }>; onOpen: (s: string) => void; onRetry: (s: string) => void }) {
  return (
    <div style={{ ...card, overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
        <span>App</span><span>Vertical</span><span>Status</span><span>Hostname</span><span>Updated</span><span />
      </div>
      {cards.map((c, i) => (
        <div
          key={c.scopeId}
          onClick={() => onOpen(c.scopeId)}
          style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 40, padding: '0 16px', fontSize: 13, borderBottom: i === cards.length - 1 ? 'none' : '1px solid var(--border-subtle)', cursor: 'pointer' }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500, color: 'var(--text-primary)' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.accent }} />{c.name}
          </span>
          <span style={{ color: 'var(--text-secondary)' }}>{c.verticalLabel}{c.version ? ` · ${c.version}` : ''}</span>
          <span>
            <Pill kind={c.status === 'provisioning' ? 'info' : c.status === 'failed' ? 'danger' : 'success'} pulse={c.status === 'provisioning'}>
              {c.status === 'provisioning' ? 'Provisioning' : c.status === 'failed' ? 'Failed' : 'Active'}
            </Pill>
          </span>
          {c.status === 'provisioning' ? (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-placeholder)' }}>assigning hostname…</span>
          ) : c.status === 'failed' ? (
            <span style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>
              Provisioning failed — <span onClick={(e) => { e.stopPropagation(); onRetry(c.scopeId); }} style={{ textDecoration: 'underline', cursor: 'pointer' }}>Retry</span>
            </span>
          ) : c.host ? (
            <a href={`https://${c.host}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{c.host}</a>
          ) : (
            <span />
          )}
          <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{c.updated}</span>
          <RowActions />
        </div>
      ))}
    </div>
  );
}

function SegBtn({ on, onClick, label, children, divider }: { on: boolean; onClick: () => void; label: string; children: React.ReactNode; divider?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, border: 0, borderLeft: divider ? '1px solid var(--border-default)' : 0, background: on ? 'var(--surface-active)' : 'var(--surface-card)', color: on ? 'var(--text-primary)' : 'var(--text-tertiary)', cursor: 'pointer' }}
    >
      {children}
    </button>
  );
}

/** One skeleton block. Static — the pulse lives on each card's content wrapper. */
function Sk({ w, h = 12, r = 6, style }: { w: number | string; h?: number; r?: number; style?: React.CSSProperties }) {
  return <span aria-hidden style={{ display: 'block', width: w, height: h, borderRadius: r, background: 'var(--surface-active)', ...style }} />;
}

/**
 * The loading Overview — same geometry as the loaded page (title row, toolbar,
 * 3-column card grid) so nothing jumps when data lands. Cards pulse with a small
 * stagger; borders stay static so the layout reads as settled, not busy.
 */
function AppsSkeleton() {
  return (
    <Page>
      <div role="status" aria-label="Loading apps…" aria-busy style={{ display: 'contents' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Sk w={92} h={22} />
            <Sk w={330} h={12} />
          </div>
          <div style={{ flex: 1 }} />
          <Sk w={112} h={32} r={8} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Sk w={260} h={32} r={8} />
          <Sk w={150} h={32} r={8} />
          <div style={{ flex: 1 }} />
          <Sk w={62} h={30} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} style={{ background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 12, padding: 16, boxShadow: 'var(--shadow-sm)' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, animation: 'sub-pulse 1.8s ease-in-out infinite', animationDelay: `${i * 120}ms` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Sk w={8} h={8} r={4} />
                  <Sk w="55%" h={14} />
                </div>
                <Sk w="40%" h={11} style={{ marginLeft: 16 }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, minHeight: 22 }}>
                  <Sk w={64} h={20} r={999} />
                  <Sk w="45%" h={11} />
                </div>
                <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 10, paddingTop: 8 }}>
                  <Sk w={96} h={10} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Page>
  );
}

/** The empty Overview / onboarding (screen 1d). */
function Onboarding({ onCreate }: { onCreate: () => void }) {
  const steps = [
    { n: 1, label: 'Create an app', here: true },
    { n: 2, label: 'Invite your team' },
    { n: 3, label: 'Connect a domain' },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 28, minHeight: 'calc(100vh - 56px)', padding: 24 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
        <span style={{ width: 48, height: 48, borderRadius: 12, background: 'var(--surface-brand-subtle)', color: 'var(--brand-600)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          <Ic name="sparkles" size={22} />
        </span>
        <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>Create your first app</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 380, lineHeight: 1.5 }}>
          Apps are the tools your team uses — pick one from the catalog to get started.
        </div>
        <Button icon={<Ic name="plus" />} onClick={onCreate}>Create App</Button>
      </div>
      <div style={{ width: 420, maxWidth: '100%', ...card, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>Getting started</div>
        {steps.map((s) => (
          <div key={s.n} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: s.here ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: s.here ? 500 : 400 }}>
            <span style={{ width: 20, height: 20, borderRadius: '50%', background: s.here ? 'var(--brand-600)' : 'transparent', border: s.here ? 'none' : '1px solid var(--border-strong)', color: s.here ? '#fff' : 'var(--text-tertiary)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, boxSizing: 'border-box' }}>{s.n}</span>
            {s.label}
            {s.here && <><span style={{ flex: 1 }} /><span style={{ fontSize: 12, color: 'var(--text-brand)', fontWeight: 500 }}>You are here</span></>}
          </div>
        ))}
      </div>
    </div>
  );
}
