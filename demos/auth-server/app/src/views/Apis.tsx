import { useEffect, useState } from 'react';
import { Badge, EmptyState, GridTable, PageHeader, Row } from '@substrat-run/ui';
import { issuerSettings, listApiResources, type ApiResource, type IssuerSettings } from '../api';

const COLUMNS = 'minmax(0, 2.4fr) minmax(0, 1.2fr) 110px minmax(0, 1.6fr)';

const cell = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;

/**
 * `/apis` — Auth0's "APIs" (resource servers): the audiences this issuer will put in an
 * access token's `aud`. Read-only in this phase; creating and editing one is Phase 3's
 * `/resource-servers`.
 *
 * Two halves, because the issuer has two answers to "may a token be minted for X". The table
 * is the RFC 8707 registry the token endpoint refuses `invalid_target` against. The card below
 * it is `MACHINE_SCOPES`, the ceiling a machine client's grant is held to — not a property of
 * any one API, so it is not a column in the table.
 */
export function ApisView() {
  const [resources, setResources] = useState<ApiResource[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    listApiResources().then(setResources, (e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <>
      <PageHeader title="APIs" description="The audiences (RFC 8707 resources) this issuer mints access tokens for." />
      {err && <p className="error">{err}</p>}
      {!resources && !err ? (
        <p className="muted">Loading APIs…</p>
      ) : resources && resources.length === 0 ? (
        <section className="panel">
          <EmptyState
            title="No APIs registered"
            description="A client asking for a token for a resource is refused until that resource is registered. The platform registers a vertical's MCP endpoint here when the vertical is bound to this issuer."
          />
        </section>
      ) : resources ? (
        <>
          <GridTable columns={COLUMNS} header={['Identifier', 'Name', 'Source', 'Scopes']}>
            {resources.map((r, i) => (
              <Row key={r.identifier} columns={COLUMNS} last={i === resources.length - 1}>
                <code style={cell} title={r.identifier}>{r.identifier}</code>
                <span style={{ ...cell, color: r.name ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>{r.name ?? '—'}</span>
                <span>
                  {r.source === 'platform' ? (
                    <Badge status="brand" dot={false}>Platform</Badge>
                  ) : (
                    <Badge status="neutral" dot={false}>Issuer</Badge>
                  )}
                </span>
                <span
                  style={{ ...cell, color: r.scopes.length ? 'var(--text-secondary)' : 'var(--text-tertiary)' }}
                  title={r.scopes.join(' ')}
                >
                  {r.scopes.length ? r.scopes.join(' ') : 'Not narrowed'}
                </span>
              </Row>
            ))}
          </GridTable>
          {resources.some((r) => r.source === 'platform') && (
            // Said once under the table rather than per row: every platform row has the same
            // explanation, and repeating it would push the identifiers off a narrow screen.
            <p className="muted small" style={{ margin: 0 }}>
              <strong>Platform</strong> rows were registered by the Substrat platform for a vertical bound to this
              issuer — its MCP endpoint, one row per hostname it answers on. The platform rewrites them whole on every
              delivery, so they are read-only here. <strong>Not narrowed</strong> means the resource keeps no scope
              list of its own, so a token for it carries whatever the client was granted.
            </p>
          )}
        </>
      ) : null}
      <MachineAccess />
    </>
  );
}

/**
 * The issuer-wide ceiling on what a machine client (`client_credentials`) may be granted.
 * Shown, never edited: `MACHINE_SCOPES` lives in the issuer's environment, so the settings
 * PATCH does not take it, and a console control for it would be one that silently did nothing.
 */
function MachineAccess() {
  const [settings, setSettings] = useState<IssuerSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    issuerSettings().then(setSettings, (e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <section className="panel">
      <div className="panel-head"><h2>Machine access</h2></div>
      <p className="muted">
        The scopes a machine application may be granted. They are set by <code>MACHINE_SCOPES</code> in this
        issuer&apos;s environment, not here; each machine application holds a subset, chosen on its own screen.
      </p>
      {err && <p className="error">{err}</p>}
      {!settings && !err ? (
        <p className="muted">Loading…</p>
      ) : settings && settings.machineScopes.length === 0 ? (
        <p className="error">
          {settings.machineScopesError ??
            'This issuer grants no machine scopes: set MACHINE_SCOPES in its environment before registering a machine application.'}
        </p>
      ) : settings ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {settings.machineScopes.map((s) => (
            <code key={s}>{s}</code>
          ))}
        </div>
      ) : null}
    </section>
  );
}
