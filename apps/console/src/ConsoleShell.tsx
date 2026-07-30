import type { ReactNode } from 'react';
import { Breadcrumbs, IconButton, SideNav, SubIcon, SubIcons } from './components';
import type { BreadcrumbItem } from './components';
import { VERSION_LABEL } from './lib/version';

export type ViewKey = 'tenants' | 'scopes' | 'domains' | 'verticals' | 'observability' | 'admin-log' | 'permissions';

/**
 * The nav items with nothing behind them, rendered dead on purpose.
 *
 * Each needs a platform capability that does not exist, and the dependency is in
 * the tooltip rather than a backlog: a disabled item that says WHY is a design
 * artifact of what the control plane still owes. Never make these live without
 * the read path underneath — an admin console that lies about what it can see is
 * worse than one that admits the gap.
 */
const PLANNED = [
  { label: 'Members', icon: SubIcons.users, dep: 'Needs principal & grant enumeration — permission writes are one-way today' },
] as const;

export interface ConsoleShellProps {
  active: ViewKey;
  onNav: (v: ViewKey) => void;
  onToggleDark: () => void;
  crumbs: BreadcrumbItem[];
  tenantCount?: number;
  scopeCount?: number;
  hostnameCount?: number;
  /** The signed-in staff identity shown in the footer (session mode). */
  identityLabel?: string;
  /** When set, the footer offers sign-out (session mode). */
  onSignOut?: () => void;
  children: ReactNode;
}

export function ConsoleShell({
  active,
  onNav,
  onToggleDark,
  crumbs,
  tenantCount,
  scopeCount,
  hostnameCount,
  identityLabel,
  onSignOut,
  children,
}: ConsoleShellProps) {
  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        overflow: 'hidden',
        background: 'var(--surface-page)',
        position: 'relative',
      }}
    >
      <SideNav
        activeValue={active}
        onSelect={(v) => onNav(v as ViewKey)}
        header={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px 8px' }}>
            {/* The three strata in the console's rose palette — must match public/strata-glyph.svg,
                the privileged-surface signal that distinguishes the console from the dashboard. */}
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
              <rect x="3" y="4.5" width="18" height="4.5" rx="2.25" fill="#FB7185" />
              <rect x="3" y="9.75" width="18" height="4.5" rx="2.25" fill="#E11D48" />
              <rect x="3" y="15" width="18" height="4.5" rx="2.25" fill="#9F1239" />
            </svg>
            <span style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
              substrat.console
            </span>
          </div>
        }
        sections={[
          {
            title: 'Fleet',
            items: [
              { value: 'tenants', label: 'Tenants', icon: <SubIcon d={SubIcons.users} />, count: tenantCount },
              { value: 'scopes', label: 'Scopes', icon: <SubIcon d={SubIcons.layers} />, count: scopeCount },
              { value: 'domains', label: 'Domains', icon: <SubIcon d={SubIcons.globe} />, count: hostnameCount },
              { value: 'verticals', label: 'Verticals', icon: <SubIcon d={SubIcons.box} /> },
              { value: 'observability', label: 'Observability', icon: <SubIcon d={SubIcons.pulse} /> },
              { value: 'admin-log', label: 'Admin log', icon: <SubIcon d={SubIcons.scroll} /> },
              { value: 'permissions', label: 'Permissions', icon: <SubIcon d={SubIcons.cog} /> },
            ],
          },
        ]}
        footer={
          <div style={{ display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border-subtle)' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 10px 4px',
            }}
          >
            <span
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: 'var(--brand-100)',
                color: 'var(--brand-700)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 600,
              }}
            >
              DV
            </span>
            <span
              style={{
                fontSize: 12.5,
                color: 'var(--text-secondary)',
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={identityLabel}
            >
              {identityLabel ?? 'dev actor'}
            </span>
            {onSignOut && (
              <button
                onClick={onSignOut}
                title="Sign out"
                style={{
                  background: 'none',
                  border: 0,
                  color: 'var(--text-tertiary)',
                  fontSize: 12,
                  cursor: 'pointer',
                  padding: '2px 6px',
                }}
              >
                Sign out
              </button>
            )}
            <IconButton label="Toggle theme" size="sm" onClick={onToggleDark}>
              <SubIcon d={SubIcons.moon} size={14} />
            </IconButton>
          </div>
          <span
            style={{
              padding: '0 10px 8px',
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-placeholder)',
            }}
            title="Running console build"
          >
            {VERSION_LABEL}
          </span>
          </div>
        }
      />

      <div
        style={{
          position: 'absolute',
          bottom: 96,
          left: 0,
          width: 'var(--sidebar-w)',
          boxSizing: 'border-box',
          padding: '0 8px',
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--text-placeholder)',
            padding: '0 10px 6px',
          }}
        >
          Planned
        </div>
        {PLANNED.map((it) => (
          <div
            key={it.label}
            title={it.dep}
            aria-disabled
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              height: 32,
              padding: '0 10px',
              borderRadius: 6,
              color: 'var(--text-placeholder)',
              fontSize: 14,
              cursor: 'not-allowed',
            }}
          >
            <span style={{ display: 'inline-flex', width: 16 }}>
              <SubIcon d={it.icon} />
            </span>
            <span style={{ flex: 1 }}>{it.label}</span>
            <span
              style={{
                fontSize: 10,
                fontFamily: 'var(--font-mono)',
                border: '1px solid var(--border-default)',
                borderRadius: 4,
                padding: '1px 5px',
              }}
            >
              soon
            </span>
          </div>
        ))}
      </div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header
          style={{
            height: 'var(--topbar-h)',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '0 24px',
            borderBottom: '1px solid var(--border-default)',
            background: 'color-mix(in srgb, var(--surface-card) 80%, transparent)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <Breadcrumbs items={crumbs} />
          <div style={{ flex: 1 }} />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              height: 32,
              padding: '0 10px',
              width: 240,
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-default)',
              background: 'var(--surface-card)',
              color: 'var(--text-placeholder)',
              fontSize: 13,
            }}
          >
            <SubIcon d={SubIcons.search} size={14} />
            <span style={{ flex: 1 }}>Search scopes…</span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                border: '1px solid var(--border-default)',
                borderRadius: 4,
                padding: '1px 4px',
                color: 'var(--text-tertiary)',
              }}
            >
              ⌘K
            </span>
          </div>
          <IconButton label="Notifications">
            <SubIcon d={SubIcons.bell} />
          </IconButton>
        </header>
        <main style={{ flex: 1, overflow: 'auto', padding: 24 }}>
          <div style={{ maxWidth: 'var(--content-max-w)', margin: '0 auto' }}>{children}</div>
        </main>
      </div>
    </div>
  );
}
