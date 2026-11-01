import { useState } from 'react';
import { GridTable, PageHeader, Row } from '@substrat-run/ui';
import type { Discovery } from '../api';

const COLUMNS = '150px minmax(0, 1fr) 80px';

/**
 * `/settings` — the issuer itself (the old Issuer panel): everything a relying party is
 * configured with. Read straight from this issuer's own discovery document rather than
 * assembled from settings, so what the screen says is what a client fetching
 * `/.well-known/openid-configuration` is told — the two cannot disagree.
 *
 * The spec's later tabs (signing keys, import / export, advanced) are Phase 3; this is the
 * General tab's content on its own.
 */
export function SettingsView({ disc }: { disc: Discovery | null }) {
  const rows: [string, string][] = disc
    ? [
        ['Issuer', disc.issuer],
        ['Discovery', `${disc.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`],
        ['Authorize', disc.authorization_endpoint],
        ['Token', disc.token_endpoint],
        ...(disc.userinfo_endpoint ? ([['Userinfo', disc.userinfo_endpoint]] as [string, string][]) : []),
        ['JWKS', disc.jwks_uri],
        ...(disc.registration_endpoint ? ([['Registration', disc.registration_endpoint]] as [string, string][]) : []),
      ]
    : [];
  const algs = disc?.id_token_signing_alg_values_supported ?? [];

  return (
    <>
      <PageHeader title="Settings" description="This issuer, as a relying party sees it: the URLs to configure one with." />
      {!disc ? (
        <section className="panel">
          <p className="muted">Discovery unavailable — this issuer did not answer its own discovery document.</p>
        </section>
      ) : (
        <>
          <GridTable columns={COLUMNS} header={['Endpoint', 'URL', '']}>
            {rows.map(([label, url], i) => (
              <Row key={label} columns={COLUMNS} last={i === rows.length - 1 && algs.length === 0}>
                <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
                <code style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={url}>{url}</code>
                <CopyButton value={url} label={label} />
              </Row>
            ))}
            {algs.length > 0 && (
              <Row columns={COLUMNS} last>
                <span style={{ color: 'var(--text-secondary)' }}>Signing</span>
                <code>{algs.join(', ')}</code>
                <span />
              </Row>
            )}
          </GridTable>
          <p className="muted small" style={{ margin: 0 }}>
            Point any OIDC relying party at the issuer URL; it discovers the rest. A new application can register
            itself at the registration endpoint, or be added under Applications.
          </p>
        </>
      )}
    </>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn link"
      aria-label={`Copy the ${label} URL`}
      style={{ justifySelf: 'end', width: 'auto' }}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
