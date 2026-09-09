import { useCallback, useEffect, useState } from 'react';
import {
  connectProvider,
  disconnectProvider,
  linkErrorFrom,
  setupState,
  signInMethods,
  type PublicProvider,
  type SignInMethod,
} from '../api';

/**
 * `/account` — the one screen everybody who can sign into this issuer reaches, administrator
 * or not. For a non-administrator it is the whole console, which is why the nav still renders
 * around it with this single item in it: a person here is not locked out of anything they
 * were meant to see, and a lone card floating on a page said otherwise.
 */
export function AccountView({ admin }: { admin: boolean }) {
  return (
    <section className="panel">
      <div className="panel-head"><h2>Your sign-in methods</h2></div>
      {!admin && (
        <p className="muted">
          This account does not hold the<code> admin</code> role, so the issuer's own settings
          are not yours to change — but its sign-in methods are.
        </p>
      )}
      <SignInMethods />
    </section>
  );
}

/* ---- the sign-in methods on your own account ---- */

/** What a stored account row's provider id is called on screen. `credential` is Better Auth's
 *  name for a password; every other id is a provider's, so the configured label wins and the
 *  raw id is the fallback for a provider that has since been removed. */
function methodLabel(provider: string, providers: PublicProvider[]): string {
  if (provider === 'credential') return 'Password';
  return providers.find((p) => p.id === provider)?.label ?? provider;
}

/**
 * The ways THIS account can be signed into, and the one screen where a person joins another
 * one to it.
 *
 * It exists because of a refusal. Signing in with a provider whose address already belongs to
 * an account here does not silently claim that account — Better Auth answers "account not
 * linked", and rightly: a verified address at an upstream is not by itself permission to
 * become whoever holds it here. The safe join is this one, made from inside a session that
 * already proves who you are. The account keeps its id, so every relying party's `sub` goes on
 * meaning the same person — which is the whole difference between linking and ending up with
 * two accounts.
 *
 * The other lever — trusting a provider, so the join happens at sign-in — is in the Sign-in
 * providers panel, and is an administrator's decision about a directory. This one is each
 * person's decision about their own account, so it is offered to everyone who can sign in,
 * administrator or not. It also clears a gate that trusting cannot: an implicit join needs the
 * LOCAL address verified as well, which an administrator-created account has never been, while
 * a link made from inside a session asks nothing of it. What it still needs is the provider's
 * own half — an upstream that reports the address verified, or one an administrator trusts.
 */
export function SignInMethods() {
  const [methods, setMethods] = useState<SignInMethod[] | null>(null);
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  // Whether a read has *finished*, which is not the same question as what it returned. The
  // loading line hangs off this rather than off `methods`, so a failed read can stop the
  // loading line without having to claim the account has no sign-in methods.
  const [loaded, setLoaded] = useState(false);
  // A refused link comes back as a redirect, so the reason is in the URL rather than in a
  // response this code could catch — read once, then cleared below so a reload stops repeating
  // a failure that has already been read.
  const [err, setErr] = useState<string | null>(() => linkErrorFrom(new URL(window.location.href)));

  const reload = useCallback(async () => {
    try {
      // `setupState` is the same read the signed-out screen makes for its provider buttons:
      // which upstreams this issuer offers, id and label only. Nothing about the account.
      const [mine, state] = await Promise.all([signInMethods(), setupState()]);
      setMethods(mine);
      setProviders(state.providers);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      // What was on screen stays on screen. `reload` also runs after a disconnect, and a
      // refresh that fails there says nothing about the account — blanking the list would
      // announce an account with no way into it and offer “Connect” for providers that are
      // still linked. The error says what happened; the stale rows are the last thing the
      // server actually reported.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('link_error')) return;
    for (const key of ['link_error', 'error', 'error_description']) url.searchParams.delete(key);
    window.history.replaceState({}, '', `${url.pathname}${url.search}`);
  }, []);

  const linked = new Set((methods ?? []).map((m) => m.provider));
  // BankID is left out on purpose: it is a sign-in method, not an OAuth upstream, and there is
  // no redirect-link flow to start for it — offering a button that cannot work would be worse
  // than not offering one.
  const connectable = providers.filter((p) => p.id !== 'bankid' && !linked.has(p.id));
  // The server refuses to remove the last one; saying so beside a disabled button is kinder
  // than letting someone press it and read an error about it.
  const onlyOne = (methods?.length ?? 0) < 2;

  return (
    <>
      {err && <p className="error">{err}</p>}
      <p className="muted">
        Every way this account can be signed into. Connecting a provider here attaches it to the
        account you are already signed in as — the account keeps its identity, so nothing you
        have signed into through this issuer sees a new person.
      </p>
      {!loaded ? (
        <p className="muted">Loading sign-in methods…</p>
      ) : !methods ? null : (
        <table className="grid">
          <thead>
            <tr><th>Method</th><th>Connected</th><th></th></tr>
          </thead>
          <tbody>
            {methods.map((method) => (
              <tr key={method.id} className={busy === method.id ? 'busy' : ''}>
                <td>{methodLabel(method.provider, providers)}</td>
                <td>{method.createdAt ? new Date(method.createdAt).toLocaleDateString() : ''}</td>
                <td className="actions">
                  <button
                    className="btn tiny danger"
                    disabled={onlyOne || busy !== null}
                    title={onlyOne ? 'This is the only way into the account.' : undefined}
                    onClick={async () => {
                      if (!window.confirm(`Remove ${methodLabel(method.provider, providers)} as a way to sign in?`)) return;
                      setErr(null);
                      setBusy(method.id);
                      try {
                        await disconnectProvider(method.id);
                        await reload();
                      } catch (e) {
                        setErr(e instanceof Error ? e.message : String(e));
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    Disconnect
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {connectable.length > 0 && (
        <div className="add-provider">
          {connectable.map((provider) => (
            <button
              key={provider.id}
              className="btn"
              disabled={busy !== null}
              onClick={async () => {
                setErr(null);
                setBusy(provider.id);
                try {
                  // Navigates away on success, so there is deliberately no reload here.
                  await connectProvider(provider.id);
                } catch (e) {
                  setErr(e instanceof Error ? e.message : String(e));
                  setBusy(null);
                }
              }}
            >
              + Connect {provider.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
