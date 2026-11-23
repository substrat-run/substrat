import { useState } from 'react';
import { Switch } from '@substrat-run/ui';
import {
  setDatabaseConnectionSettings,
  setIssuerSettings,
  type DatabaseConnectionSettings,
  type IssuerSettings,
} from '../../api';

/**
 * The Settings tab of the Username-Password connection: whether a STRANGER may make an account
 * with a password. It lives here rather than on Security because it switches this connection
 * and no other — an upstream's "create accounts" decision is on that upstream's own tab, and
 * Auth0 puts "Disable sign ups" on the database connection for the same reason. It is written
 * to its declared config key (`ALLOW_SIGNUP`), the one the platform's Env tab and a `wrangler`
 * var write to.
 *
 * Beside it, whether a password needs a verified address before it signs anyone in — the
 * same connection's question, asked of everyone who holds a password rather than of strangers.
 * That one is the connection's OWN setting (#3344), stored on the connection rather than in the
 * environment. Until the connection has a value it falls back to the deprecated
 * `REQUIRE_EMAIL_VERIFICATION` key, and the hint says so; pressing the switch gives it one.
 *
 * The issuer rebuilds Better Auth per request, so either change applies to the very next attempt.
 */
export function DatabaseSettings({
  settings, connection, onChanged, onConnectionChanged,
}: {
  settings: IssuerSettings;
  connection: DatabaseConnectionSettings;
  onChanged: (s: IssuerSettings) => void;
  onConnectionChanged: (c: DatabaseConnectionSettings) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (write: () => Promise<void>) => {
    setErr(null);
    setBusy(true);
    try {
      await write();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Partial PATCHes: only the switch pressed is named, so it cannot revert anything else in
  // the same document — the linking mode Security writes, say.
  const toggleSignup = (on: boolean) =>
    run(async () => onChanged(await setIssuerSettings({ allowSignup: on })));
  const toggleVerification = (on: boolean) =>
    run(async () => onConnectionChanged(await setDatabaseConnectionSettings({ requireEmailVerification: on })));

  return (
    <section className="panel">
      <div className="panel-head"><h2>Sign-ups</h2></div>
      {err && <p className="error">{err}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Switch label="Allow sign-up" checked={settings.allowSignup} disabled={busy} onChange={(on) => void toggleSignup(on)} />
        <em className="hint">
          {settings.allowSignup
            ? 'Anyone who reaches this issuer can create an account — including someone a relying party sent to sign in.'
            : 'Only administrators can create accounts. The sign-up screen is hidden and the endpoint refuses.'}
        </em>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        <Switch
          label="Require email verification"
          checked={connection.requireEmailVerification}
          disabled={busy}
          onChange={(on) => void toggleVerification(on)}
        />
        <em className="hint">
          {connection.requireEmailVerification
            ? 'A password signs nobody in until its address is verified. A new account is signed in by the link in its verification mail, which carries them on to the application that sent them; an unverified sign-in is refused and sent a fresh link. Turning this on also stops anyone already holding an unverified password account from signing in with it.'
            : 'A password signs its holder in whether or not the address is verified. A verification mail still goes out at sign-up.'}
        </em>
        {connection.requireEmailVerificationSource === 'env' && (
          <p className="muted small">
            Currently read from the deprecated <code>REQUIRE_EMAIL_VERIFICATION</code> environment
            setting. Changing this switch saves it on the connection, and from then on the
            environment setting is ignored.
          </p>
        )}
      </div>
      <p className="muted small">
        Which applications accept a password at all is on the Applications tab — that is each
        application’s own sign-in policy, seen from this connection.
      </p>
    </section>
  );
}
