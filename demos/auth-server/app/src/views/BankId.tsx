import { useCallback, useEffect, useState } from 'react';
import {
  bankidSettings,
  removeBankid,
  saveBankidSettings,
  type BankIdSettings,
} from '../api';

/* ---- BankID ---- */

/**
 * BankID sits beside the OAuth providers but is configured on its own terms: an environment,
 * an mTLS client certificate, and one decision (may it create accounts). No redirect URI to
 * register and no client id — the issuer CALLS BankID, presenting the certificate.
 */
export function BankIdPanel() {
  const [settings, setSettings] = useState<BankIdSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setErr(null);
    try {
      setSettings(await bankidSettings());
      setLoaded(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>BankID</h2>
        {loaded && !settings && !editing && (
          <button className="btn" onClick={() => setEditing(true)}>+ Enable BankID</button>
        )}
      </div>
      {err && <p className="error">{err}</p>}
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <p className="muted">
            Swedish e-ID sign-in. People approve in the BankID app — by scanning an animated QR
            code, or on the same device — and their verified personal number is the account key.
          </p>
          {settings && (
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
                    <button className="btn tiny" onClick={() => setEditing(true)}>Edit</button>
                    <button
                      className="btn tiny danger"
                      onClick={async () => {
                        if (!window.confirm('Remove BankID? The stored certificate is deleted and the button leaves the login screen. Accounts people created with it remain.')) return;
                        try {
                          await removeBankid();
                          setEditing(false);
                          await reload();
                        } catch (e) {
                          setErr(e instanceof Error ? e.message : String(e));
                        }
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          )}
          {editing && (
            <BankIdEditor
              settings={settings}
              onCancel={() => setEditing(false)}
              onSaved={async () => {
                setEditing(false);
                await reload();
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

function BankIdEditor({
  settings, onCancel, onSaved,
}: { settings: BankIdSettings | null; onCancel: () => void; onSaved: () => void | Promise<void> }) {
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
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="editor">
      <h3>{settings ? 'Edit BankID' : 'Enable BankID'}</h3>
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
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
