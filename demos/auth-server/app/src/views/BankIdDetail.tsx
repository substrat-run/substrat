import { useCallback, useEffect, useState } from 'react';
import { bankidSettings, removeBankid, type BankIdSettings } from '../api';
import { navigate } from '../console/router';
import { BANKID_PATH } from '../console/routes';
import { BankIdEditor } from './BankId';

/**
 * `/bankid/settings` — the one BankID configuration this issuer has.
 *
 * A fixed path rather than `/bankid/<id>`, because there is nothing to identify: no client id,
 * no registered redirect URI, one mTLS certificate. It is a screen of its own for the reason
 * the other three details are — the certificate form unfolded UNDER the status table with no
 * URL, so it survived neither a reload nor the sign-in a stale session triggered, and an
 * operator halfway through pasting a PEM lost it. Now it is a place: linkable into a support
 * conversation, and `returnTarget` keeps it across the sign-in it triggers.
 *
 * Three states, all of them stated: loading, an error from the read, and — for a path that is
 * always a place — either "configured" (facts, then the form, then Actions) or "not configured
 * yet", where the same form is what enables BankID. There is no "no such screen" answer here,
 * which is the whole difference from a detail keyed by an id somebody may have removed.
 *
 * The nav is not the gate: every call below is refused server-side by session + the `admin`
 * role, and this component simply is not rendered for anyone else.
 */
export function BankIdDetailView() {
  const [settings, setSettings] = useState<BankIdSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setSettings(await bankidSettings());
      setLoaded(true);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <>
      <button
        className="btn link"
        style={{ justifySelf: 'start', padding: 0 }}
        onClick={() => navigate(BANKID_PATH)}
      >
        ← BankID
      </button>
      {err && <p className="error">{err}</p>}
      {/* A failed read is an error state, not a pending one. */}
      {!loaded ? (
        !err && <p className="muted">Loading BankID…</p>
      ) : (
        <>
          {settings && <BankIdFacts settings={settings} />}
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
            <BankIdEditor
              key={settings ? 'configured' : 'new'}
              settings={settings}
              onSaved={async () => {
                await reload();
              }}
            />
          </section>
          {settings && <BankIdActions onRemoved={reload} />}
        </>
      )}
    </>
  );
}

/* ---- what is stored ---- */

function BankIdFacts({ settings }: { settings: BankIdSettings }) {
  return (
    <section className="panel">
      {/* Not "BankID": the topbar already says that, because a detail screen keeps its
          section's label up there. This panel is the stored row, the form below it is what
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
          {settings.disabled ? <span className="tag warn">disabled</span> : 'enabled'}
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
