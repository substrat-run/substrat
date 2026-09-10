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
            {/* Keyed by whether a configuration exists, so the fields that mean "keep the
                stored PEM" are mounted with the right labels the moment there IS one: the
                first save turns "Enable" into an edit, and the placeholders change with it. */}
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
      <div className="panel-head"><h2>BankID</h2></div>
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
        {/* Stored or not is the whole fact available. The PEM went into this issuer's own
            database and is never read back out to a browser, which is why the form below asks
            to REPLACE it rather than showing it. */}
        <dd>
          {settings.certSet ? 'stored' : <span className="tag warn">missing</span>}
          {settings.caSet && <span className="tag">custom CA</span>}
        </dd>
        <dt>Last changed</dt>
        {/* `updatedAt` is epoch milliseconds, and 0 for a row that predates the column. */}
        <dd>{settings.updatedAt ? new Date(settings.updatedAt).toLocaleString() : '—'}</dd>
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
