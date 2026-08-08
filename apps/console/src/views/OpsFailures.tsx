import { Fragment, useEffect, useState } from 'react';
import type { OpsFailureEntry, Tenant, TenantId } from '@substrat-run/contracts';
import { Badge, Button, Card, Input, Select, Tag } from '../components';
import { ActorCell } from '../patterns/ActorCell';
import type { Api } from '../lib/api';

const PAGE = 20;

/** Debounce a text filter so an exact-match server param isn't refetched per keystroke. */
function useDebounced(value: string, ms = 400): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export interface OpsFailuresProps {
  api: Api;
  tenants: Map<TenantId, Tenant>;
  /** Pre-narrow to one vertical — the jump from a vertical's failures strip. */
  initialVertical?: string;
}

/**
 * Operations → Failures (#559): what the platform could NOT do — durable rows the
 * admin log deliberately does not hold (it audits successful mutations; a failure
 * changed nothing). Each row carries the upstream `reference = <id>` when one was
 * extracted, so the handle a CI log prints finally resolves to something on our
 * side — and copies out for a Cloudflare support ticket, which is the only place
 * a redacted storage fault's reference actually resolves.
 */
export function OpsFailures({ api, tenants, initialVertical }: OpsFailuresProps) {
  const [entries, setEntries] = useState<OpsFailureEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string>();
  const [error, setError] = useState<string>();
  const [copied, setCopied] = useState<string>();

  const [tenantFilter, setTenantFilter] = useState('all');
  const [verticalInput, setVerticalInput] = useState(initialVertical ?? '');
  const [referenceInput, setReferenceInput] = useState('');
  // Server-side narrowing is EXACT match (vertical slug, upstream reference) —
  // debounced so typing doesn't refetch per keystroke. Free-text stays client-side.
  const vertical = useDebounced(verticalInput.trim());
  const reference = useDebounced(referenceInput.trim());
  const [q, setQ] = useState('');

  const serverFilter = {
    tenantId: tenantFilter === 'all' ? undefined : (tenantFilter as TenantId),
    vertical: vertical || undefined,
    reference: reference || undefined,
  };

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const page = await api.listOpsFailures({ limit: PAGE, ...serverFilter });
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
  }, [api, tenantFilter, vertical, reference]);

  async function loadOlder() {
    if (!cursor) return;
    const page = await api.listOpsFailures({ limit: PAGE, cursor, ...serverFilter });
    setEntries((prev) => [...prev, ...page.entries]);
    setCursor(page.nextCursor);
  }

  function copyReference(ref: string) {
    void navigator.clipboard.writeText(ref).then(() => {
      setCopied(ref);
      setTimeout(() => setCopied(undefined), 1500);
    });
  }

  const visible = entries.filter((e) => {
    if (!q) return true;
    const hay = `${e.operation}${e.stage ?? ''}${e.message}${e.actor}${e.scopeId ?? ''}`.toLowerCase();
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
          Failures
        </h1>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-tertiary)', maxWidth: 640 }}>
          Operational failures — what the platform could <em>not</em> do, newest first. Distinct from the
          admin log, which audits what succeeded. A <code>reference</code> is Cloudflare's redacted-fault
          handle: copy it into a CF support ticket; it resolves nowhere else.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <Input placeholder="Filter by operation, message, or scope…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 280 }} />
        <Select
          options={[
            { value: 'all', label: 'All tenants' },
            ...[...tenants.values()].map((t) => ({ value: t.id, label: t.slug })),
          ]}
          value={tenantFilter}
          onChange={(e) => setTenantFilter(e.target.value)}
          style={{ width: 160 }}
        />
        <Input placeholder="Vertical (exact slug)" mono value={verticalInput} onChange={(e) => setVerticalInput(e.target.value)} style={{ width: 200 }} />
        <Input placeholder="reference = …" mono value={referenceInput} onChange={(e) => setReferenceInput(e.target.value)} style={{ width: 220 }} />
      </div>

      {error && (
        <Card>
          <span style={{ fontSize: 13, color: 'var(--status-danger-fg)' }}>{error}</span>
        </Card>
      )}

      <Card
        padding={0}
        footer="Rows are pruned after the retention horizon (90 days). Row click shows the full message. Cursor-paginated."
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-sans)', fontSize: 14 }}>
          <thead>
            <tr>
              {['Time', 'Operation', 'Vertical', 'Tenant', 'Status', 'Reference'].map((h) => (
                <th key={h} style={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((e) => (
              <Fragment key={e.id}>
                <tr
                  onClick={() => setExpanded(expanded === e.id ? undefined : e.id)}
                  style={{ cursor: 'pointer', background: expanded === e.id ? 'var(--surface-hover)' : 'transparent' }}
                >
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                    {e.at.slice(0, 19).replace('T', ' ')}
                  </td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
                    {e.operation}
                    {e.stage && <span style={{ color: 'var(--text-tertiary)' }}> · {e.stage}</span>}
                  </td>
                  <td style={td}>
                    {e.vertical ? <Tag mono>{e.vertical}</Tag> : <span style={{ color: 'var(--text-placeholder)' }}>—</span>}
                  </td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
                    {e.tenantId ? (
                      (tenants.get(e.tenantId)?.slug ?? e.tenantId.slice(0, 8))
                    ) : (
                      <span style={{ color: 'var(--text-placeholder)' }}>platform</span>
                    )}
                  </td>
                  <td style={td}>
                    {e.status !== null ? (
                      <Badge status={e.status >= 500 ? 'danger' : 'warning'}>{e.status}</Badge>
                    ) : (
                      <span style={{ color: 'var(--text-placeholder)' }}>—</span>
                    )}
                  </td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                    {e.reference ? (
                      <button
                        title="Copy for a Cloudflare support ticket"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          copyReference(e.reference!);
                        }}
                        style={{
                          background: 'none',
                          border: '1px solid var(--border-default)',
                          borderRadius: 4,
                          padding: '2px 6px',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11.5,
                          color: 'var(--text-secondary)',
                          cursor: 'pointer',
                        }}
                      >
                        {copied === e.reference ? 'copied' : e.reference}
                      </button>
                    ) : (
                      <span style={{ color: 'var(--text-placeholder)' }}>—</span>
                    )}
                  </td>
                </tr>
                {expanded === e.id && (
                  <tr>
                    <td colSpan={6} style={{ padding: 12, background: 'var(--surface-hover)', borderBottom: '1px solid var(--border-subtle)' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12.5 }}>
                        <div style={{ fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-primary)' }}>
                          {e.message}
                        </div>
                        <div style={{ display: 'flex', gap: 16, alignItems: 'center', color: 'var(--text-tertiary)' }}>
                          <ActorCell actor={e.actor} />
                          {e.scopeId && (
                            <span style={{ fontFamily: 'var(--font-mono)' }}>scope {e.scopeId}</span>
                          )}
                          {e.reference && (
                            <Button size="sm" variant="secondary" onClick={() => copyReference(e.reference!)}>
                              {copied === e.reference ? 'Copied' : 'Copy reference for CF support'}
                            </Button>
                          )}
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
                  {entries.length === 0 && !error ? 'No failures recorded — a quiet fleet.' : 'No entries match.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {cursor && (
          <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}>
            <Button variant="ghost" size="sm" onClick={() => void loadOlder()}>
              Load older entries
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
