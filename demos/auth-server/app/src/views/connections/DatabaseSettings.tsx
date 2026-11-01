import { useState } from 'react';
import { Switch } from '@substrat-run/ui';
import { setIssuerSettings, type IssuerSettings } from '../../api';

/**
 * The Settings tab of the Username-Password connection: whether a STRANGER may make an account
 * with a password. It lives here rather than on Security because it switches this connection
 * and no other — an upstream's "create accounts" decision is on that upstream's own tab, and
 * Auth0 puts "Disable sign ups" on the database connection for the same reason.
 *
 * Written to the same declared config key (`ALLOW_SIGNUP`) the platform's Env tab and a
 * `wrangler` var write to, so there is one answer whichever of the three set it. The issuer
 * rebuilds Better Auth per request, so it applies to the very next attempt.
 */
export function DatabaseSettings({
  settings, onChanged,
}: { settings: IssuerSettings; onChanged: (s: IssuerSettings) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = async (allowSignup: boolean) => {
    setErr(null);
    setBusy(true);
    try {
      // A partial PATCH: only `allowSignup` is named, so this cannot revert the linking mode
      // Security writes to the same settings document.
      onChanged(await setIssuerSettings({ allowSignup }));
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
        <Switch label="Allow sign-up" checked={settings.allowSignup} disabled={busy} onChange={(on) => void toggle(on)} />
        <em className="hint">
          {settings.allowSignup
            ? 'Anyone who reaches this issuer can create an account — including someone a relying party sent to sign in.'
            : 'Only administrators can create accounts. The sign-up screen is hidden and the endpoint refuses.'}
        </em>
      </div>
      <p className="muted small">
        Which applications accept a password at all is on the Applications tab — that is each
        application’s own sign-in policy, seen from this connection.
      </p>
    </section>
  );
}
