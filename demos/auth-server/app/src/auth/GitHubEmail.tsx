import { useEffect, useState } from 'react';
import { githubEmailStatus, sendGithubEmail, verifyGithubEmail } from '../api';
import { Card, Centered, Field } from '../primitives';

export function GitHubEmail() {
  const [pending, setPending] = useState<Awaited<ReturnType<typeof githubEmailStatus>> | null>(null);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token'));
  useEffect(() => {
    const changed = () => {
      setPending(null);
      setToken(new URLSearchParams(window.location.hash.slice(1)).get('token'));
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => {
    let live = true;
    setError(null);
    githubEmailStatus(token).then((value) => { if (live) { setPending(value); setEmail(value.email ?? ''); } }).catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [token]);
  return <Centered><Card title="Verify your email">
    {pending && <>
      <p className="muted">You signed in with the GitHub account <strong>{pending.name}</strong>. {pending.linking ? 'Verify your existing account email to connect GitHub.' : 'Verify your email to continue. This becomes your account email; your GitHub sign-in stays connected.'}</p>
      {token && <p>Verify <strong>{pending.email}</strong> for this account.</p>}
      {token ? <button className="btn primary" disabled={busy} onClick={async () => {
        setBusy(true); setError(null);
        try { await verifyGithubEmail(token, pending.oauthQuery); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
      }}>{busy ? 'Verifying…' : 'Verify email and continue'}</button> : <>
        <Field label={pending.linking ? 'Account email' : 'Email'} type="email" value={email} onChange={setEmail} disabled={pending.linking} hint={pending.linking ? undefined : 'If you are joining a team, use the invited address.'} />
        {sent && <p className="notice">Check your inbox. Open the verification link in this browser within 10 minutes.</p>}
        <button className="btn primary" disabled={busy || !email.includes('@')} onClick={async () => {
          setBusy(true); setError(null);
          try { await sendGithubEmail(email); setSent(true); }
          catch (e) { setError(e instanceof Error ? e.message : String(e)); }
          finally { setBusy(false); }
        }}>{busy ? 'Sending…' : sent ? 'Send another verification email' : 'Send verification email'}</button>
      </>}
    </>}
    {!pending && !error && <p className="muted">Loading…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <button className="btn link" onClick={() => window.location.assign(pending?.oauthQuery ? `/login?${pending.oauthQuery}` : '/login')}>Use another sign-in method</button>
  </Card></Centered>;
}
