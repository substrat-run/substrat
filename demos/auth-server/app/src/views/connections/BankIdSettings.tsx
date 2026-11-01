import { useState } from 'react';
import { removeBankid, saveBankidSettings, testBankid, type BankIdSettings } from '../../api';
import { bankIdStatus } from './model';

/* ---- BankID's Settings tab ---- */

/**
 * The Settings tab of the BankID connection — the one BankID configuration this issuer has.
 * Moved from the old `/bankid/settings` screen with its behaviour intact.
 *
 * Always a place, configured or not: either "configured" (facts, the connection test, then the
 * form, then Actions) or "not configured yet", where the same form is what enables BankID.
 * There is no "no such connection" answer for this id, which is the whole difference from an
 * upstream keyed by an id somebody may have removed.
 */
export function BankIdSettingsTab({
  settings, onChanged, onTested,
}: {
  settings: BankIdSettings | null;
  /** Re-read after a save or a removal. */
  onChanged: () => Promise<void>;
  /** The test answers with the whole row; set it rather than read again. */
  onTested: (s: BankIdSettings) => void;
}) {
  return (
    <>
      {settings && <BankIdFacts settings={settings} />}
      {settings && <BankIdConnection settings={settings} onTested={onTested} />}
      <section className="panel">
        <div className="panel-head">
          <h2>{settings ? 'Certificate and environment' : 'Enable BankID'}</h2>
        </div>
        {!settings && (
          <p className="muted">
            Swedish e-ID sign-in. Paste the mTLS certificate your bank issued — or the shared
            test one from the BankID developer portal — and the login screen grows a BankID
            button.
          </p>
        )}
        {/* Keyed by whether a configuration exists, which is the only transition that has
            to reach fields the editor does NOT reset itself. It resets the certificate and
            key after every save; the environment and the two toggles it does not, because
            they are what the operator just chose. Enabling and removing are the two moments
            where that is the wrong answer — a removal must not leave the gone row's
            environment selected — and both cross this key. */}
        <BankIdEditor key={settings ? 'configured' : 'new'} settings={settings} onSaved={onChanged} />
      </section>
      {settings && <BankIdActions onRemoved={onChanged} />}
    </>
  );
}

/**
 * The certificate, the environment, and the two decisions that come with them.
 */
function BankIdEditor({
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
      <p className="hint">
        The bank sends the certificate as a .txt file. Open it and paste its text (it starts with{' '}
        <code>-----BEGIN CERTIFICATE-----</code>) in the certificate box, and the matching private key in the key box.
      </p>
      <label className="field">
        <span>{settings?.certSet ? 'Client certificate (stored — paste to replace)' : 'Client certificate (PEM)'}</span>
        <textarea rows={4} value={cert} onChange={(e) => setCert(e.target.value)} placeholder={'-----BEGIN CERTIFICATE-----'} />
        <em className="hint">
          {environment === 'test' ? (
            <>
              From a .p12: <code>openssl pkcs12 -in FPTestcert5_20240610.p12 -clcerts -nokeys -legacy</code>
              &nbsp;(test passphrase <code>qwerty123</code>).
            </>
          ) : (
            'The certificate the bank issued for your own certificate request; it must match the private key pasted below.'
          )}
        </em>
      </label>
      <label className="field">
        <span>{settings?.certSet ? 'Private key (stored — paste to replace)' : 'Private key (PEM)'}</span>
        <textarea rows={4} value={key} onChange={(e) => setKey(e.target.value)} placeholder={'-----BEGIN PRIVATE KEY-----'} />
        <em className="hint">
          {environment === 'test' && (
            <>
              <code>openssl pkcs12 -in FPTestcert5_20240610.p12 -nocerts -nodes -legacy</code>.{' '}
            </>
          )}
          Stored in this issuer&apos;s own database and never shown again.
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

/* ---- what is stored ---- */

function BankIdFacts({ settings }: { settings: BankIdSettings }) {
  return (
    <section className="panel">
      {/* Not "BankID": the connection header above already says that. This panel is the stored row, the form below it is what
          replaces the row, and the heading is what tells the two apart. */}
      <div className="panel-head"><h2>Stored configuration</h2></div>
      <dl className="kv">
        <dt>Environment</dt>
        {/* Which BankID this issuer calls, and therefore which app a person needs: a test-mode
            BankID app cannot approve a production order, or the other way round. */}
        <dd>
          {settings.environment === 'production' ? (
            <>
              <code>production</code> — appapi2.bankid.com
            </>
          ) : (
            <>
              <code>test</code> — appapi2.test.bankid.com
            </>
          )}
        </dd>
        <dt>Status</dt>
        <dd>
          {settings.disabled ? <span className="tag warn">disabled</span> : bankIdStatus(settings)}
          {settings.allowSignup && <span className="tag">creates accounts</span>}
        </dd>
        <dt>Certificate</dt>
        {/* Stored or not is the whole fact available: the PEM went into this issuer's own
            database and is never read back out to a browser, which is why the form below asks
            to REPLACE it rather than showing it. There is no "missing" to report — the issuer
            refuses to store a configuration without a certificate (`putBankIdConfig` throws)
            and one that somehow lacked it would not parse, so a configuration existing IS a
            certificate existing. The flag is on the wire so this screen never has to assume
            that, not because the other value happens here. */}
        <dd>
          {settings.certSet ? 'stored' : '—'}
          {settings.caSet && <span className="tag">custom CA</span>}
        </dd>
        <dt>Last changed</dt>
        {/* `updatedAt` is epoch milliseconds, stamped on every save and required by the stored
            schema — a row without one reads as no configuration at all rather than as an
            unknown date, so there is no missing case to render here. */}
        <dd>{new Date(settings.updatedAt).toLocaleString()}</dd>
      </dl>
    </section>
  );
}

/* ---- whether BankID accepts the certificate ---- */

const TRANSPORT_LABEL: Record<BankIdSettings['transport'], string> = {
  direct: 'presented by this deployment itself',
  hop: "presented by the platform's sign-in relay, which this deployment sends it to with each call",
  none: 'cannot be presented: this deployment has no certificate binding and no platform relay client',
};

/**
 * The connection test: BankID's `collect` for an order that does not exist, through the same
 * transport a sign-in uses. A pass is BankID accepting the handshake and this certificate; a
 * failure names the stage it stopped at, which is the difference between "the key does not match
 * the certificate" (`tls.config`), "BankID refused it" (`tls.handshake`) and "BankID is not
 * reachable" (`tcp.open`). Run on every save of a certificate; this button re-runs it.
 */
function BankIdConnection({ settings, onTested }: { settings: BankIdSettings; onTested: (s: BankIdSettings) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { probe } = settings;

  return (
    <section className="panel">
      <div className="panel-head"><h2>Connection</h2></div>
      <dl className="kv">
        <dt>Certificate</dt>
        <dd>{TRANSPORT_LABEL[settings.transport]}</dd>
        <dt>Last test</dt>
        <dd>
          {!probe ? (
            'not run since the certificate was saved'
          ) : probe.ok ? (
            <>BankID accepted the certificate · {new Date(probe.at).toLocaleString()}</>
          ) : (
            <>
              <span className="tag warn">failed at {probe.stage ?? 'an unknown stage'}</span> {probe.detail}
              {' · '}{new Date(probe.at).toLocaleString()}
            </>
          )}
        </dd>
        {probe?.stages && probe.stages.length > 0 && (
          <>
            <dt>Stages</dt>
            <dd>
              {probe.stages.map((s) => (
                <span key={s.stage} className="tag">
                  {s.stage} {s.ms} ms{s.protocol ? ` ${s.protocol}` : ''}{s.status ? ` ${s.status}` : ''}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button
          className="btn"
          disabled={busy || settings.transport === 'none'}
          onClick={() =>
            void (async () => {
              setBusy(true);
              setErr(null);
              try {
                onTested(await testBankid());
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            })()
          }
        >
          {busy ? 'Testing…' : 'Test connection'}
        </button>
      </div>
    </section>
  );
}

/* ---- the lever that is not a field ---- */

function BankIdActions({ onRemoved }: { onRemoved: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <section className="panel">
      <div className="panel-head"><h2>Actions</h2></div>
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button
          className="btn danger"
          disabled={busy}
          onClick={() =>
            void (async () => {
              if (!window.confirm('Remove BankID? The stored certificate is deleted and the button leaves the login screen. Accounts people created with it remain.')) return;
              setBusy(true);
              setErr(null);
              try {
                await removeBankid();
                // Stay here rather than going back to the status screen: this path is a place
                // whether or not BankID is configured, and what it now offers is enabling it
                // again — which is what an operator who removed the wrong certificate wants
                // in front of them.
                await onRemoved();
                // Usually unreachable in effect: a successful re-read has no configuration, so
                // this panel is gone by now and the setState is a no-op. It is here for the
                // path where the re-read itself fails — the removal happened, the panel is
                // still on screen showing that error, and a latched-disabled button would be
                // the only thing left to look at.
                setBusy(false);
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
                setBusy(false);
              }
            })()
          }
        >
          Remove BankID
        </button>
      </div>
      <p className="muted small">
        Removing forgets the certificate. To keep it and only take the button off the login
        screen, tick <strong>Disabled</strong> above instead.
      </p>
    </section>
  );
}
