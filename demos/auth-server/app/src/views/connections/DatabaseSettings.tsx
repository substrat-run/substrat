import { useState } from 'react';
import { Switch } from '@substrat-run/ui';
import { setIssuerSettings, type IssuerSettings } from '../../api';

/**
 * The Settings tab of the Username-Password connection: whether a STRANGER may make an account
 * with a password. It lives here rather than on Security because it switches this connection
 * and no other — an upstream's "create accounts" decision is on that upstream's own tab, and
 * Auth0 puts "Disable sign ups" on the database connection for the same reason.
 *
 * Beside it, whether a password needs a verified address before it signs anyone in — the
 * same connection's question, asked of everyone who holds a password rather than of strangers.
 *
 * Each is written to its own declared config key (`ALLOW_SIGNUP`, `REQUIRE_EMAIL_VERIFICATION`)
 * — the ones the platform's Env tab and a `wrangler` var write to, so there is one answer
 * whichever of the three set it. The issuer rebuilds Better Auth per request, so a change
 * applies to the very next attempt.
 */
export function DatabaseSettings({
  settings, onChanged,
}: { settings: IssuerSettings; onChanged: (s: IssuerSettings) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = async (patch: { allowSignup: boolean } | { requireEmailVerification: boolean }) => {
    setErr(null);
    setBusy(true);
    try {
      // A partial PATCH: only the switch pressed is named, so it cannot revert the other one, or
      // the linking mode Security writes to the same settings document.
      onChanged(await setIssuerSettings(patch));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head"><h2>Sign-ups</h2></div>
      {err && <p className="error">{err}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Switch label="Allow sign-up" checked={settings.allowSignup} disabled={busy} onChange={(on) => void toggle({ allowSignup: on })} />
        <em className="hint">
          {settings.allowSignup
            ? 'Anyone who reaches this issuer can create an account — including someone a relying party sent to sign in.'
            : 'Only administrators can create accounts. The sign-up screen is hidden and the endpoint refuses.'}
        </em>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        <Switch
          label="Require email verification"
          checked={settings.requireEmailVerification}
          disabled={busy}
          onChange={(on) => void toggle({ requireEmailVerification: on })}
        />
        <em className="hint">
          {settings.requireEmailVerification
            ? 'A password signs nobody in until its address is verified. A new account is signed in by the link in its verification mail, which carries them on to the application that sent them; an unverified sign-in is refused and sent a fresh link. Turning this on also stops anyone already holding an unverified password account from signing in with it.'
            : 'A password signs its holder in whether or not the address is verified. A verification mail still goes out at sign-up.'}
        </em>
      </div>
      <p className="muted small">
        Which applications accept a password at all is on the Applications tab — that is each
        application’s own sign-in policy, seen from this connection.
      </p>
    </section>
  );
}
