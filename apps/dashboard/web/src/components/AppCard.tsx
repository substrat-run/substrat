import { useState } from 'react';
import type { InstallStep } from '../lib/api';
import { Ic } from '../lib/icons';
import { InstallSteps } from './InstallSteps';
import { Pill, RowActions } from './ui';

export interface AppCardData {
  name: string;
  verticalLabel: string;
  version: string;
  status: 'active' | 'provisioning' | 'failed';
  host: string | null;
  updated: string;
  accent: string;
  /** A `provisioning` row older than any real install takes — stuck, resumable (#424). */
  stalled?: boolean;
}

/** The app tile — accent dot, name, kind·version, status pill, hostname, footer. */
export function AppCard({
  app,
  onOpen,
  onRetry,
  onResume,
  loadSteps,
}: {
  app: AppCardData;
  onOpen?: () => void;
  onRetry?: () => void;
  onResume?: () => void;
  /** Loader for the install's durable step record (#424) — rendered live while provisioning, and as the diagnosis when failed. */
  loadSteps?: () => Promise<InstallStep[]>;
}) {
  const [hover, setHover] = useState(false);
  const provisioning = app.status === 'provisioning';
  const failed = app.status === 'failed';
  const kind = provisioning ? 'info' : failed ? 'danger' : 'success';
  const label = provisioning ? 'Provisioning' : failed ? 'Failed' : 'Active';

  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: 'var(--surface-card)',
        border: `1px solid ${hover ? 'var(--border-strong)' : 'var(--border-default)'}`,
        borderRadius: 12,
        padding: 16,
        boxShadow: hover ? 'var(--shadow-md)' : 'var(--shadow-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        cursor: 'pointer',
        transition: 'box-shadow 120ms cubic-bezier(0.16,1,0.3,1), border-color 120ms cubic-bezier(0.16,1,0.3,1)',
        boxSizing: 'border-box',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: app.accent, flexShrink: 0 }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {app.name}
        </span>
        <RowActions />
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', paddingLeft: 16 }}>
        {app.verticalLabel}
        {app.version ? ` · ${app.version}` : ''}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, minHeight: 22 }}>
        <Pill kind={kind} pulse={provisioning}>
          {label}
        </Pill>
        {provisioning ? (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-placeholder)' }}>assigning hostname…</span>
        ) : app.host ? (
          <a
            href={`https://${app.host}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-link)', display: 'inline-flex', alignItems: 'center', gap: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {app.host}
            <Ic name="external" size={12} />
          </a>
        ) : null}
      </div>
      {(provisioning || failed) && loadSteps && <InstallSteps status={app.status} load={loadSteps} />}
      {provisioning && app.stalled && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'var(--status-info-bg)',
            color: 'var(--status-info-fg)',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 12.5,
            marginTop: 4,
          }}
        >
          <span style={{ flex: 1 }}>Setup didn’t finish.</span>
          <span
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              onResume?.();
            }}
            style={{ fontWeight: 500, cursor: 'pointer', textDecoration: 'underline' }}
          >
            Resume
          </span>
        </div>
      )}
      {failed && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'var(--status-danger-bg)',
            color: 'var(--status-danger-fg)',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 12.5,
            marginTop: 4,
          }}
        >
          <span style={{ flex: 1 }}>Provisioning failed — nothing was billed.</span>
          <span
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              onRetry?.();
            }}
            style={{ fontWeight: 500, cursor: 'pointer', textDecoration: 'underline' }}
          >
            Retry
          </span>
        </div>
      )}
      <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 10, paddingTop: 8, fontSize: 11, color: 'var(--text-tertiary)' }}>
        Updated {app.updated}
      </div>
    </div>
  );
}
