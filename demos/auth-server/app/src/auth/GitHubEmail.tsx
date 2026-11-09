import { useEffect, useState } from 'react';
import { githubEmailStatus, sendGithubEmail, verifyGithubEmail, type ClientTheme } from '../api';
import { Card, Centered, Field } from '../primitives';
import { useT } from './locale';

export function GitHubEmail({ theme }: { theme: ClientTheme }) {
  const t = useT();
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
  return <Centered><Card title={t('github.title')} logo={theme.logoUrl}>
    {pending && <>
      <p className="muted">{t('github.signedInAs')} <strong>{pending.name}</strong>. {pending.linking ? t('github.linking') : t('github.joining')}</p>
      {token && <p>{t('github.verifyFor', { email: pending.email ?? '' })}</p>}
      {token ? <button className="btn primary" disabled={busy} onClick={async () => {
        setBusy(true); setError(null);
        try { await verifyGithubEmail(token, pending.oauthQuery); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
      }}>{busy ? t('github.verifying') : t('github.verifyContinue')}</button> : <>
        <Field label={pending.linking ? t('github.accountEmail') : t('common.email')} type="email" value={email} onChange={setEmail} disabled={pending.linking} hint={pending.linking ? undefined : t('github.inviteHint')} />
        {sent && <p className="notice">{t('github.checkInbox')}</p>}
        <button className="btn primary" disabled={busy || !email.includes('@')} onClick={async () => {
          setBusy(true); setError(null);
          try { await sendGithubEmail(email); setSent(true); }
          catch (e) { setError(e instanceof Error ? e.message : String(e)); }
          finally { setBusy(false); }
        }}>{busy ? t('github.sending') : sent ? t('github.sendAnother') : t('github.send')}</button>
      </>}
    </>}
    {!pending && !error && <p className="muted">{t('common.loading')}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <button className="btn link" onClick={() => window.location.assign(pending?.oauthQuery ? `/login?${pending.oauthQuery}` : '/login')}>{t('github.otherMethod')}</button>
  </Card></Centered>;
}
