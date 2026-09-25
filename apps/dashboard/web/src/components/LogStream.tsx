import type { ReactNode } from 'react';
import { Tabs } from '@substrat-run/ui';
import { LOG_MODES, modeHint, type LogMode } from '../lib/log-stream';

/**
 * The Logs stream card (#1767): one card, its modes as tabs along the top, the open
 * mode's body below. The modes used to be a sub-view switch above two separate cards;
 * as tabs on the card they read as two ways of looking at one stream, which is what
 * they are.
 */
export function LogStream({ mode, onMode, children }: { mode: LogMode; onMode: (mode: LogMode) => void; children: ReactNode }) {
  return (
    <div
      style={{
        border: '1px solid var(--border-default)',
        borderRadius: 12,
        background: 'var(--surface-card)',
        boxShadow: 'var(--shadow-sm)',
        overflow: 'hidden',
        minWidth: 0,
      }}
    >
      <div
        data-log-modes
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px 0 16px', borderBottom: '1px solid var(--border-default)', flexWrap: 'wrap' }}
      >
        <Tabs tabs={LOG_MODES} value={mode} onChange={(v) => onMode(v as LogMode)} style={{ borderBottom: 'none' }} />
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{modeHint(mode)}</span>
      </div>
      {children}
    </div>
  );
}
