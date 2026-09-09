import type { Discovery } from '../api';

export function IssuerPanel({ disc }: { disc: Discovery | null }) {
  return (
    <section className="panel">
      <div className="panel-head"><h2>OIDC issuer</h2></div>
      {!disc ? (
        <p className="muted">Discovery unavailable.</p>
      ) : (
        <dl className="kv">
          <dt>Issuer</dt><dd><code>{disc.issuer}</code></dd>
          <dt>Discovery</dt><dd><code>{disc.issuer.replace(/\/$/, '')}/.well-known/openid-configuration</code></dd>
          <dt>Authorize</dt><dd><code>{disc.authorization_endpoint}</code></dd>
          <dt>Token</dt><dd><code>{disc.token_endpoint}</code></dd>
          <dt>JWKS</dt><dd><code>{disc.jwks_uri}</code></dd>
          <dt>Signing</dt><dd><code>{(disc.id_token_signing_alg_values_supported ?? []).join(', ') || '—'}</code></dd>
        </dl>
      )}
      <p className="muted small">
        Point any OIDC relying party at the issuer above. New clients can self-register at the
        registration endpoint, or be added by an admin.
      </p>
    </section>
  );
}
