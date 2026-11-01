import { useEffect, useState } from 'react';
import { PageHeader } from '@substrat-run/ui';
import { issuerSettings, setIssuerSettings, type AccountLinkingMode, type IssuerSettings } from '../api';

/**
 * What holds across every connection at once. Today that is one decision: what happens to
 * someone arriving through an upstream with an address that already has an account here.
 *
 * Written to the declared config key `ACCOUNT_LINKING` — the same one the platform's Env tab
 * and a `wrangler` var write to, so there is one answer whichever of the three set it. The
 * issuer rebuilds Better Auth per request, so it applies to the very next attempt.
 *
 * Sign-up used to sit beside it and moved to the Username-Password connection, which is the
 * thing it switches. The two were never one control: sign-up is whether a STRANGER may make an
 * account, linking is what happens to someone who arguably already has one.
 */
export function SecurityView() {
  const [settings, setSettings] = useState<IssuerSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void issuerSettings()
      .then(setSettings)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const save = async (accountLinking: AccountLinkingMode) => {
    setErr(null);
    setBusy(true);
    try {
      // A partial PATCH naming only this key, so the sign-up decision on the database
      // connection cannot be reverted by a stale copy echoed back from here.
      setSettings(await setIssuerSettings({ accountLinking }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Security" description="Rules that hold across every connection." />
      <section className="panel">
        <div className="panel-head"><h2>Account linking</h2></div>
        {err && <p className="error">{err}</p>}
        {!settings ? (
          !err && <p className="muted">Loading…</p>
        ) : (
          <label className="field">
            <span>When a provider’s email already has an account here</span>
            <select
              value={settings.accountLinking}
              disabled={busy}
              onChange={(e) => void save(e.target.value as AccountLinkingMode)}
            >
              <option value="link">Sign them into it</option>
              <option value="block">Refuse, and let them connect it themselves</option>
            </select>
            <em className="hint">
              {settings.accountLinking === 'link'
                ? 'The provider must vouch for the address (or be trusted on its connection), and the account here must have a verified address of its own. Both conditions are the library’s, and neither can be turned off from this screen.'
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
    </>
  );
}
