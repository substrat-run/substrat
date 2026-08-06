import { useCallback, useEffect, useState } from 'react';
import type { DirectoryBackup } from '@substrat-run/contracts';
import { Badge, Button, Card, EmptyState, Table, Tabs } from '../components';
import type { TableColumn } from '../components';
import { APP_SHA, APP_VERSION } from '../lib/version';
import { ApiError, type Api } from '../lib/api';

/**
 * Console settings. Two tabs: About — the running build stamp that used to sit in the
 * sidebar footer — and Recovery (#40), the platform's own backup state. It was always a
 * tabbed page so console-level settings had a home to grow into; this is the first thing
 * to grow into it.
 */

export interface SettingsProps {
  api: Api;
  onToast: (title: string, detail?: string, status?: 'success' | 'danger') => void;
}

/** Hours since a copy was taken — the number this whole panel exists to show. */
function hoursSince(iso: string, now: number): number {
  return (now - new Date(iso).getTime()) / 3_600_000;
}

function formatAge(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min ago`;
  if (hours < 48) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The freshness verdict. The cadence is one copy a day, so anything inside ~26h is the
 * healthy steady state (24h plus a sweep interval of slack). Past 48h, two scheduled
 * captures have been missed — and because the cadence guard reads the newest stored copy,
 * a missed tick is normally caught up on the very next pass. So "late" does not mean a
 * slow backup; it means the sweep itself is not arriving.
 */
function freshness(hours: number): { tone: 'success' | 'warning' | 'danger'; label: string } {
  if (hours <= 26) return { tone: 'success', label: 'Current' };
  if (hours <= 48) return { tone: 'warning', label: 'Late' };
  return { tone: 'danger', label: 'Stale' };
}

/**
 * Recovery — is the platform's own backup actually running? (#40)
 *
 * Why this is a view rather than a curl command: a backup nobody has looked at is a
 * belief, not a guarantee, and a cron cannot raise an alarm about its own absence.
 * "Newest copy: 3 h ago" turns the belief into a fact — and "9 days ago" is an alarm
 * nothing else in the system would ever raise.
 *
 * Read and take-now only. There is deliberately NO restore button: replacing the
 * directory has a blast radius of every tenant at once, well past what a type-to-confirm
 * dialog can carry, and the disaster it answers is one where the directory is GONE — a
 * recovery path that assumes a working console is a recovery path that is not there when
 * it is needed. Restore is a deliberate API call, from the runbook (control-plane.md §4.9).
 */
function Recovery({ api, onToast }: SettingsProps) {
  const [backups, setBackups] = useState<DirectoryBackup[] | null>(null);
  // 501 is not an error to report as one: it means no store is bound, i.e. this control
  // plane keeps NO copy of itself. That is the loudest thing this panel can say, and the
  // reason the route answers 501 rather than an empty list — "nothing held" and "nobody
  // is looking" must not render alike.
  const [unconfigured, setUnconfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setError(null);
    try {
      const held = await api.listDirectoryBackups();
      setUnconfigured(false);
      setBackups(held);
      // Stamped when the list is read, so every age on screen is measured from the same
      // instant as the data rather than from render time.
      setNow(Date.now());
    } catch (e) {
      if (e instanceof ApiError && e.status === 501) {
        setUnconfigured(true);
        setBackups([]);
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setBackups([]);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const takeNow = async () => {
    setBusy(true);
    try {
      const taken = await api.backupDirectory();
      onToast('Directory backed up', `Copy taken at ${taken.capturedAt}`, 'success');
      await load();
    } catch (e) {
      onToast('Backup failed', e instanceof Error ? e.message : String(e), 'danger');
    } finally {
      setBusy(false);
    }
  };

  const newest = backups?.[0];
  const age = newest ? hoursSince(newest.capturedAt, now) : null;
  const verdict = age === null ? null : freshness(age);

  const columns: TableColumn<DirectoryBackup>[] = [
    { header: 'Captured', key: 'capturedAt', mono: true },
    { header: 'Age', render: (b) => formatAge(hoursSince(b.capturedAt, now)) },
    { header: 'Size', render: (b) => formatSize(b.size), align: 'right' },
    { header: 'Tables', render: (b) => String(b.tables), align: 'right' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card
        title="Directory backup"
        description="The platform's own copy — tenants, scopes, hostnames, verticals and the audit spine. Taken daily by the platform sweep; 30 kept."
        actions={
          <Button variant="secondary" disabled={busy || unconfigured} onClick={() => void takeNow()}>
            {busy ? 'Backing up…' : 'Back up now'}
          </Button>
        }
      >
        {unconfigured ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--status-danger-fg)', lineHeight: '19px' }}>
            <strong>No backup store is bound.</strong> This control plane keeps no copy of its
            own directory — losing the directory would lose the platform, and there would be
            nothing to restore from. Bind <code>DIRECTORY_BACKUPS</code> and redeploy.
          </p>
        ) : error ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--status-danger-fg)' }}>{error}</p>
        ) : backups === null ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading…</p>
        ) : !newest || !verdict || age === null ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--status-warning-fg)', lineHeight: '19px' }}>
            <strong>No copy has been taken yet.</strong> The sweep takes one within a day of
            deploy — or take the first one now.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Badge status={verdict.tone}>{verdict.label}</Badge>
              <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                Newest copy <strong>{formatAge(age)}</strong> · {backups.length} held ·{' '}
                {formatSize(newest.size)}
              </span>
            </div>
            {verdict.tone !== 'success' && (
              <p style={{ margin: 0, fontSize: 12.5, color: 'var(--status-warning-fg)', lineHeight: '18px' }}>
                A copy is due daily, and a missed tick is caught up on the next pass — so an
                overdue copy points at the platform sweep rather than at the backup. Check the
                control-plane worker's cron triggers.
              </p>
            )}
          </div>
        )}
      </Card>

      <Card
        title="Copies held"
        description="Newest first. Restoring one replaces the entire directory, so it is a deliberate API call rather than a button here."
      >
        {backups && backups.length > 0 ? (
          <Table columns={columns} rows={backups} />
        ) : (
          <EmptyState title="No copies" description="Nothing is held for this control plane yet." />
        )}
      </Card>

      <Card title="Restoring" description="What to do when the directory is the thing that was lost.">
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: '20px' }}>
          <p style={{ margin: '0 0 8px' }}>
            A restore <strong>replaces</strong> the directory — anything created after the copy
            was taken is gone — so it is refused while tenants exist unless the request says{' '}
            <code>overwrite: true</code>. That guard is aimed at the real hazard: a restore
            replayed against a control plane that has already recovered.
          </p>
          <p style={{ margin: 0 }}>
            The procedure is in <code>docs/design/control-plane.md</code> §4.9, including what a
            restore does <em>not</em> bring back — the staff roster (D1), worker secrets, and the
            key any sealed row was sealed with.
          </p>
        </div>
      </Card>
    </div>
  );
}

export function Settings({ api, onToast }: SettingsProps) {
  const [tab, setTab] = useState('about');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
          Settings
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-tertiary)' }}>
          Console configuration, platform recovery, and the running build.
        </p>
      </div>

      <Tabs
        tabs={[
          { value: 'about', label: 'About' },
          { value: 'recovery', label: 'Recovery' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'about' && (
        <Card title="Running build" description="The console build currently served to your browser.">
          <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', fontSize: 13, rowGap: 8 }}>
            <span style={{ color: 'var(--text-tertiary)' }}>Version</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>v{APP_VERSION}</span>
            <span style={{ color: 'var(--text-tertiary)' }}>Commit</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{APP_SHA}</span>
          </div>
        </Card>
      )}

      {tab === 'recovery' && <Recovery api={api} onToast={onToast} />}
    </div>
  );
}
