import { useEffect, useState, type ReactNode } from 'react';
import {
  bankidSettings,
  saveBankidSettings,
  type BankIdSettings,
} from '../api';
import { navigate } from '../console/router';
import { BANKID_SETTINGS_PATH } from '../console/routes';

/* ---- BankID ---- */

/**
 * `/bankid` — whether this issuer offers Swedish e-ID sign-in, and on what terms.
 *
 * BankID sits beside the OAuth providers but is configured on its own terms: an environment,
 * an mTLS client certificate, and one decision (may it create accounts). No redirect URI to
 * register and no client id — the issuer CALLS BankID, presenting the certificate.
 *
 * The status is here and the configuration is at `/bankid/settings`, the same split the other
 * three sections got: the certificate form used to unfold under this table with no URL of its
 * own, so an operator halfway through pasting a PEM lost it to a reload, and the screen could
 * not be linked to in a support conversation. Three states, all of them stated: loading, no
 * BankID configured, and one configured.
 */
export function BankIdPanel() {
  const [settings, setSettings] = useState<BankIdSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setSettings(await bankidSettings());
        setLoaded(true);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>BankID</h2>
        {/* A link, not a button that unfolds a form: enabling BankID and editing it are the
            same screen, and that screen is a place. */}
        {loaded && !settings && (
          <BankIdSettingsLink className="btn">+ Enable BankID</BankIdSettingsLink>
        )}
      </div>
      {err && <p className="error">{err}</p>}
      {/* A failed read is an error state, not a pending one — no "Loading…" underneath it
          telling an operator to keep waiting for a request that already came back. */}
      {!loaded ? (
        !err && <p className="muted">Loading…</p>
      ) : (
        <>
          <p className="muted">
            Swedish e-ID sign-in. People approve in the BankID app — by scanning an animated QR
            code, or on the same device — and their verified personal number is the account key.
          </p>
          {settings ? (
            <>
              <table className="grid">
                <thead>
                  <tr><th>Environment</th><th>Certificate</th><th>Status</th><th></th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      {settings.environment === 'production' ? 'Production' : 'Test'}
                      {settings.allowSignup && <span className="tag">creates accounts</span>}
                    </td>
                    <td>{settings.certSet ? 'stored' : '—'}{settings.caSet && <span className="tag">custom CA</span>}</td>
                    <td>{settings.disabled ? 'Disabled' : 'Enabled'}</td>
                    <td className="actions">
                      <BankIdSettingsLink className="btn tiny">Open</BankIdSettingsLink>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="muted small">
                Open BankID to replace the certificate, switch environment, or remove it. Removing
                it takes the button off the login screen; accounts people created with it remain.
              </p>
            </>
          ) : (
            <p className="muted small">
              No certificate stored, so the login screen offers no BankID button. Enabling it
              needs an mTLS certificate — the shared test one from the BankID developer portal,
              or the one your bank issued to your organisation.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * A real anchor to `/bankid/settings`, not a click handler: the screen is a place, so it has to
 * be copyable, middle-clickable and openable in a tab. The plain click stays same-document.
 * Same shape as `ProviderLink` in `Providers.tsx`, and deliberately not shared with it — that
 * one interpolates an id, this one has a constant path and nothing to interpolate.
 */
function BankIdSettingsLink({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <a
      href={BANKID_SETTINGS_PATH}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(BANKID_SETTINGS_PATH);
      }}
    >
      {children}
    </a>
  );
}

/**
 * The certificate, the environment, and the two decisions that come with them.
 *
 * Exported for `BankIdDetail.tsx`, which is the only screen that renders it — the same
 * arrangement `ProviderEditor` has with `ProviderDetail.tsx`. It stays in this file because
 * the read it is edited against (`bankidSettings`) is the one the status table above shows.
 */
export function BankIdEditor({
  settings, onSaved,
}: { settings: BankIdSettings | null; onSaved: () => void | Promise<void> }) {
  const [environment, setEnvironment] = useState<'test' | 'production'>(settings?.environment ?? 'test');
  const [cert, setCert] = useState('');
  const [key, setKey] = useState('');
  const [allowSignup, setAllowSignup] = useState(settings?.allowSignup ?? true);
  const [disabled, setDisabled] = useState(settings?.disabled ?? false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setErr(null);
    // The issuer refuses half a credential too; saying it here saves a round-trip. A cert
    // and its key only work as the pair they were issued as.
    if (Boolean(cert.trim()) !== Boolean(key.trim())) {
      return setErr('The certificate and key replace each other as a pair — paste both, or leave both blank to keep the stored ones.');
    }
    setBusy(true);
    try {
      await saveBankidSettings({
        environment,
        // Empty means "keep the stored PEMs" — flipping a toggle must not require re-pasting
        // a credential, same convention as the OAuth providers' secret field.
        ...(cert.trim() ? { clientCert: cert.trim() } : {}),
        ...(key.trim() ? { clientKey: key.trim() } : {}),
        allowSignup,
        disabled,
      });
      // Whatever was pasted is now stored, and the fields go back to meaning "keep it". Left
      // as they were, a second Save would re-send a credential the operator can no longer see
      // in full — and the labels beside them would be lying about what blank means.
      setCert('');
      setKey('');
      setBusy(false);
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="editor">
      <label className="field">
        <span>Environment</span>
        <select value={environment} onChange={(e) => setEnvironment(e.target.value as 'test' | 'production')}>
          <option value="test">test — appapi2.test.bankid.com</option>
          <option value="production">production — appapi2.bankid.com</option>
        </select>
        <em className="hint">
          The test environment takes the shared test certificate (FPTestcert5, from the BankID
          developer portal) and test-mode BankID apps. Production requires the certificate your
          bank issued to your organisation.
        </em>
      </label>
      <label className="field">
        <span>{settings?.certSet ? 'Client certificate (stored — paste to replace)' : 'Client certificate (PEM)'}</span>
        <textarea rows={4} value={cert} onChange={(e) => setCert(e.target.value)} placeholder={'-----BEGIN CERTIFICATE-----'} />
        <em className="hint">
          From a .p12: <code>openssl pkcs12 -in FPTestcert5_20240610.p12 -clcerts -nokeys -legacy</code>
          &nbsp;(test passphrase <code>qwerty123</code>).
        </em>
      </label>
      <label className="field">
        <span>{settings?.certSet ? 'Private key (stored — paste to replace)' : 'Private key (PEM)'}</span>
        <textarea rows={4} value={key} onChange={(e) => setKey(e.target.value)} placeholder={'-----BEGIN PRIVATE KEY-----'} />
        <em className="hint">
          <code>openssl pkcs12 -in FPTestcert5_20240610.p12 -nocerts -nodes -legacy</code>. Stored
          in this issuer&apos;s own database and never shown again.
        </em>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={allowSignup} onChange={(e) => setAllowSignup(e.target.checked)} />
        <span>
          <strong>Let BankID create accounts</strong>
          <em className="hint">
            On, a first sign-in creates an account keyed by the verified personal number. Off,
            only personal numbers an administrator already linked can get in — BankID carries no
            email, so there is nothing else to match a person by.
          </em>
        </span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
        <span>
          <strong>Disabled</strong>
          <em className="hint">Keeps the certificate but takes the button off the login screen.</em>
        </span>
      </label>
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : settings ? 'Save changes' : 'Enable'}
        </button>
      </div>
    </div>
  );
}
