import { useState, type ReactNode } from 'react';
import {
  saveBankidSettings,
  type BankIdSettings,
} from '../api';
import { navigate } from '../console/router';
import { BANKID_SETTINGS_PATH } from '../console/routes';

/* ---- BankID ---- */

/**
 * A real anchor to `/bankid/settings`, not a click handler: the screen is a place, so it has to
 * be copyable, middle-clickable and openable in a tab. The plain click stays same-document.
 * Same shape as `ProviderLink` in `Providers.tsx`, and deliberately not shared with it — that
 * one interpolates an id, this one has a constant path and nothing to interpolate.
 */
export function BankIdSettingsLink({ className, children }: { className?: string; children: ReactNode }) {
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
 * Whether BankID is on the login screen, and if not, why — one answer for the providers list
 * and the BankID page, matching `publicBankIdFrom` on the server: a transport, and through the
 * relay a connection test that passed.
 */
export function bankIdStatus(settings: BankIdSettings): string {
  if (settings.disabled) return 'Disabled';
  if (settings.transport === 'none') return 'Not offered — this deployment cannot present the certificate';
  if (settings.probe?.ok) return 'Enabled';
  if (settings.probe) {
    const failed = `connection test failed at ${settings.probe.stage ?? 'an unknown stage'}`;
    // Only the relay's path waits for a passing test; a deployment presenting the certificate
    // itself still offers BankID, and the failure is a warning about it.
    return settings.transport === 'hop' ? `Not offered — ${failed}` : `Enabled — ${failed}`;
  }
  return settings.transport === 'hop' ? 'Not offered — test the connection' : 'Enabled — not tested';
}

/**
 * The certificate, the environment, and the two decisions that come with them.
 *
 * Exported for `BankIdDetail.tsx`, which is the only screen that renders it — the same
 * arrangement `ProviderEditor` has with `ProviderDetail.tsx`.
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
