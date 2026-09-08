import { Fragment, useEffect, useState } from 'react';
import type { IssueEntry, IssueStatus, IssueStatusInput } from '@substrat-run/contracts';
import { Badge, Button, Card, Input, Select } from '../components';
import type { Api } from '../lib/api';

export interface IssuesProps {
  api: Api;
  /** Jump to Operations → Failures narrowed to one issue's exemplar rows. */
  onExemplars: (fingerprint: string) => void;
  onToast: (message: string) => void;
}

const STATUS_BADGE: Record<IssueStatus, 'danger' | 'warning' | 'success' | 'neutral'> = {
  new: 'danger',
  regressed: 'warning',
  resolved: 'success',
  ignored: 'neutral',
};

/** The fingerprint joins its parts with U+001F — render it with a visible seam. */
function fingerprintLabel(fp: string): string {
  return fp.split('\u001f').filter(Boolean).join(' · ');
}

/**
 * Operations → Issues (#1233): failures grouped by fingerprint — operation +
 * stage + taxonomy code — into counted defects with a lifecycle, Sentry's core
 * object. The unit of attention stops being a log line: a retried intent that
 * fails 577 times is ONE row here with a rising count, not 577 rows nobody
 * read. Resolve says "over"; a fresh arrival flips it to regressed. Ignore says
 * "stop telling me", and ingest respects it.
 */
export function Issues({ api, onExemplars, onToast }: IssuesProps) {
  const [entries, setEntries] = useState<IssueEntry[]>([]);
  const [expanded, setExpanded] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [statusFilter, setStatusFilter] = useState<'all' | IssueStatus>('all');
  const [q, setQ] = useState('');
  // Bump to refetch after a verdict — the server's answer is the truth, not our copy.
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const page = await api.listIssues(statusFilter === 'all' ? {} : { status: statusFilter });
        if (!live) return;
        setEntries(page.entries);
        setError(undefined);
      } catch (e) {
        if (!live) return;
        setEntries([]);
        setError((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [api, statusFilter, generation]);

  async function verdict(fingerprint: string, status: IssueStatusInput) {
    setBusy(fingerprint);
    try {
      const updated = await api.setIssueStatus(fingerprint, status);
      onToast(`Issue ${status === 'new' ? 'reopened' : status}: ${fingerprintLabel(updated.fingerprint)}`);
      setGeneration((g) => g + 1);
    } catch (e) {
      onToast(`Verdict failed: ${(e as Error).message}`);
    } finally {
      setBusy(undefined);
    }
  }

  const visible = entries.filter((e) => {
    if (!q) return true;
    const hay = `${e.operation}${e.stage ?? ''}${e.code ?? ''}${e.lastMessage}${e.lastVertical ?? ''}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  const th: React.CSSProperties = {
    textAlign: 'left',
    padding: '0 16px',
    height: 36,
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--text-tertiary)',
    borderBottom: '1px solid var(--border-default)',
    background: 'var(--surface-inset)',
    whiteSpace: 'nowrap',
  };
  const td: React.CSSProperties = {
    padding: '0 16px',
    height: 40,
    borderBottom: '1px solid var(--border-subtle)',
    fontSize: 12.5,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
          Issues
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-tertiary)', maxWidth: 640 }}>
          Failures grouped by shape (#1233): operation + stage + error code, counted, with a
          lifecycle. A <em>resolved</em> issue that fails again comes back as <em>regressed</em>;
          an <em>ignored</em> one stays quiet. The count survives the 90-day evidence beneath it.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Input placeholder="Filter by operation, code, message, or vertical…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 320 }} />
        <Select
          options={[
            { value: 'all', label: 'All statuses' },
            { value: 'new', label: 'new' },
            { value: 'regressed', label: 'regressed' },
            { value: 'resolved', label: 'resolved' },
            { value: 'ignored', label: 'ignored' },
          ]}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          style={{ width: 150 }}
        />
      </div>

      {error && (
        <Card>
          <span style={{ fontSize: 13, color: 'var(--status-danger-fg)' }}>{error}</span>
        </Card>
      )}

      <Card
        padding={0}
        footer="One row per failure shape, most recently seen first. Issues outlive their evidence: rows prune 180 days after the last occurrence. No pagination — grouping is the compression."
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-sans)', fontSize: 14 }}>
          <thead>
            <tr>
              {['Status', 'Count', 'Operation', 'Code', 'Last seen', 'Vertical'].map((h) => (
                <th key={h} style={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((e) => (
              <Fragment key={e.fingerprint}>
                <tr
                  onClick={() => setExpanded(expanded === e.fingerprint ? undefined : e.fingerprint)}
                  style={{ cursor: 'pointer', background: expanded === e.fingerprint ? 'var(--surface-hover)' : 'transparent' }}
                >
                  <td style={td}>
                    <Badge status={STATUS_BADGE[e.status]}>{e.status}</Badge>
                  </td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {e.count}
                  </td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {/* The keyboard path into the detail row — the tr's onClick is pointer-only. */}
                    <button
                      type="button"
                      aria-expanded={expanded === e.fingerprint}
                      aria-controls={expanded === e.fingerprint ? `issue-detail-${e.fingerprint}` : undefined}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setExpanded(expanded === e.fingerprint ? undefined : e.fingerprint);
                      }}
                      style={{ background: 'none', border: 0, padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}
                    >
                      {e.operation}
                      {e.stage && <span style={{ color: 'var(--text-tertiary)' }}> · {e.stage}</span>}
                    </button>
                  </td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
                    {e.code ?? <span style={{ color: 'var(--text-placeholder)' }}>—</span>}
                  </td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                    {e.lastSeen.slice(0, 19).replace('T', ' ')}
                  </td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
                    {e.lastVertical ?? <span style={{ color: 'var(--text-placeholder)' }}>—</span>}
                  </td>
                </tr>
                {expanded === e.fingerprint && (
                  <tr id={`issue-detail-${e.fingerprint}`}>
                    <td colSpan={6} style={{ padding: 12, background: 'var(--surface-hover)', borderBottom: '1px solid var(--border-subtle)' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12.5 }}>
                        <div style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-primary)' }}>
                          {e.lastMessage}
                        </div>
                        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                          {e.origin && <span>origin {e.origin}</span>}
                          <span>first seen {e.firstSeen.slice(0, 19).replace('T', ' ')}</span>
                          {e.resolvedAt && <span>resolved {e.resolvedAt.slice(0, 19).replace('T', ' ')}</span>}
                          {e.lastVersion && <span>seen under {e.lastVersion}</span>}
                          {e.status === 'regressed' && e.resolvedVersion && (
                            <span style={{ color: 'var(--status-warning-fg)' }}>
                              resolved under {e.resolvedVersion} — came back
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          {e.status !== 'resolved' && (
                            <Button size="sm" disabled={busy === e.fingerprint} onClick={() => void verdict(e.fingerprint, 'resolved')}>
                              Resolve
                            </Button>
                          )}
                          {e.status !== 'ignored' && (
                            <Button size="sm" variant="ghost" disabled={busy === e.fingerprint} onClick={() => void verdict(e.fingerprint, 'ignored')}>
                              Ignore
                            </Button>
                          )}
                          {(e.status === 'resolved' || e.status === 'ignored') && (
                            <Button size="sm" variant="ghost" disabled={busy === e.fingerprint} onClick={() => void verdict(e.fingerprint, 'new')}>
                              Reopen
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => onExemplars(e.fingerprint)}>
                            View exemplar rows
                          </Button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} style={{ ...td, color: 'var(--text-placeholder)', textAlign: 'center', height: 80 }}>
                  {entries.length === 0 && !error
                    ? 'No issues — nothing has failed in a way the record can group. That is the good state.'
                    : 'No issues match.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
