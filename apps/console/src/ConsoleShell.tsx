import type { ReactNode } from 'react';
import { Breadcrumbs, IconButton, SideNav, SubIcon, SubIcons } from './components';
import type { BreadcrumbItem } from './components';

export type ViewKey =
  | 'tenants'
  | 'scopes'
  | 'domains'
  | 'verticals'
  | 'observability'
  | 'meters'
  | 'admin-log'
  | 'permissions'
  | 'members'
  | 'failures'
  | 'settings';

/*
 * There used to be a "Planned" nav stratum here — items with nothing behind
 * them, rendered dead on purpose, each tooltip naming the capability the
 * control plane still owed. Its last resident (Members) graduated when the
 * staff-roster write path landed (views/Members.tsx); bring
 * the pattern back verbatim for the next owed capability rather than shipping
 * a live item without its read path. (Per-tenant principal & grant enumeration
 * is still owed and would be a different view.)
 */

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
              { value: 'meters', label: 'Meters', icon: <SubIcon d={SubIcons.gauge} /> },
              { value: 'admin-log', label: 'Admin log', icon: <SubIcon d={SubIcons.scroll} /> },
              { value: 'permissions', label: 'Permissions', icon: <SubIcon d={SubIcons.cog} /> },
            ],
          },
          {
            // What the platform could NOT do (#559) — a separate stratum from Fleet's
            // state-of-the-world, so a red day is one click, not a filter recipe.
            title: 'Operations',
            items: [{ value: 'failures', label: 'Failures', icon: <SubIcon d={SubIcons.alert} /> }],
          },
          {
            title: 'Console',
            items: [
              { value: 'members', label: 'Members', icon: <SubIcon d={SubIcons.users} /> },
              { value: 'settings', label: 'Settings', icon: <SubIcon d={SubIcons.sliders} /> },
            ],
          },
        ]}
        footer={
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 10px',
              borderTop: '1px solid var(--border-subtle)',
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
        }
      />

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
