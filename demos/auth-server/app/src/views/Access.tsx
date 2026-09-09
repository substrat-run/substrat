import { useEffect, useState } from 'react';
import {
  issuerSettings,
  setIssuerSettings,
  type AccountLinkingMode,
  type IssuerSettings,
} from '../api';

/**
 * Who may get in. Two settings, both written to the SAME declared config keys
 * (`ALLOW_SIGNUP`, `ACCOUNT_LINKING`) the platform's Env tab and a `wrangler` var write to, so
 * there is one answer to each no matter which of the three set it. The issuer rebuilds Better
 * Auth per request, so either applies to the very next attempt.
 *
 * They answer different questions and are deliberately not one control: sign-up is whether a
 * STRANGER may make an account, linking is what happens to someone who arguably already has
 * one.
 */
export function AccessPanel() {
  const [settings, setSettings] = useState<IssuerSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void issuerSettings()
      .then(setSettings)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  // One writer for both controls, patching only the field that changed — the PATCH is partial,
  // so the sign-up decision cannot be reverted by a linking change echoing a stale copy.
  const save = async (patch: Partial<IssuerSettings>) => {
    setErr(null);
    setBusy(true);
    try {
      setSettings(await setIssuerSettings(patch));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (allowSignup: boolean) => save({ allowSignup });

  return (
    <section className="panel">
      <div className="panel-head"><h2>Access</h2></div>
      {err && <p className="error">{err}</p>}
      {!settings ? (
        <p className="muted">Loading…</p>
      ) : (
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.allowSignup}
            disabled={busy}
            onChange={(e) => void toggle(e.target.checked)}
          />
          <span>
            <strong>Allow sign-up</strong>
            <em className="hint">
              {settings.allowSignup
                ? 'Anyone who reaches this issuer can create an account — including someone a relying party sent to sign in.'
                : 'Only administrators can create accounts. The sign-up screen is hidden and the endpoint refuses.'}
            </em>
          </span>
        </label>
      )}
      {settings && (
        <label className="field">
          <span>When a provider’s email already has an account here</span>
          <select
            value={settings.accountLinking}
            disabled={busy}
            onChange={(e) => void save({ accountLinking: e.target.value as AccountLinkingMode })}
          >
            <option value="link">Sign them into it</option>
            <option value="block">Refuse, and let them connect it themselves</option>
          </select>
          <em className="hint">
            {settings.accountLinking === 'link'
              ? 'The provider must vouch for the address (or be trusted in Sign-in providers), and the account here must have a verified address of its own. Both conditions are the library’s, and neither can be turned off from this screen.'
              : 'Nobody is signed into an existing account just for arriving with its address. They sign in the way they already can and connect the provider under “Sign-in methods” — which proves the account in a way a matching address does not.'}
          </em>
          <em className="hint">
            Keeping two separate accounts on one address is not offered, because it is not
            safe here: an email resolves to exactly one user in password sign-in, password
            reset and account recovery, and a second row at that address would make each of
            them pick one arbitrarily.
          </em>
        </label>
      )}
    </section>
  );
}
