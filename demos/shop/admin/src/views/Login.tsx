import { auth } from '../api';

/**
 * The back-office gate. Unlike the storefront there is no sign-up: staff accounts are
 * provisioned, not self-served. A shopper who authenticates here gets in as far as the
 * shell and no further — every operation still checks.
 *
 * There is no password field, because this app owns no password. Signing in leaves for
 * `OIDC_ISSUER`, and what comes back is a session cookie over an id_token. `denied` is the
 * other half of that story: authenticating tells the shop WHO you are, and holding
 * `stock:manage` or `catalog:manage` is a separate question the kernel answers.
 */
export function Login({ denied }: { denied?: string | null }) {
  return (
    <div className="gate">
      <div className="gate-card">
        <div className="brand">
          <span className="drop" aria-hidden="true" />
          <span className="mark">
            Kallkälla
            <small>Back-office</small>
          </span>
        </div>
        <h2>Logga in</h2>
        <p className="sub">Personalinloggning för lager och administration.</p>
        {denied && <div className="gate-err" style={{ marginBottom: 10 }}>{denied}</div>}
        <button className="btn" onClick={() => auth.login('/')}>
          Logga in
        </button>
        <p className="hint">
          Demo: välj <code>Astrid</code> (butikschef) eller <code>Gustav</code> (lager) i listan
          hos utfärdaren. Gustav har <code>stock:manage</code> men inte <code>catalog:manage</code>:
          samma dashboard, färre knappar.
        </p>
      </div>
    </div>
  );
}
