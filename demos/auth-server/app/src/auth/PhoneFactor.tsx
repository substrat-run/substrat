import { useEffect, useState } from 'react';
import { authClient, phoneStatus, sendPhoneCode, verifyPhoneCode, type ClientTheme } from '../api';
import { Card, Centered, Field } from '../primitives';
import { useT } from './locale';
import { isExpiredSignIn, restartUrl, signInDeadline } from './sign-in-window';

export function PhoneFactor({ oauthQuery, theme, onDone, onBack }: { oauthQuery: string | null; theme: ClientTheme; onDone: () => void; onBack: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<Awaited<ReturnType<typeof phoneStatus>> | null>(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // On the device's clock, but measured from page load — see `signInDeadline` for why.
  const [deadline] = useState(() => signInDeadline(oauthQuery, Date.now()));
  const [now, setNow] = useState(() => Date.now());
  // The issuer refused the signed query: authoritative, whatever the deadline says.
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    if (deadline === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  const expired = refused || (deadline !== null && now >= deadline);
  useEffect(() => { void phoneStatus().then(setStatus).catch((e: Error) => setErr(e.message)); }, []);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (isExpiredSignIn(message)) setRefused(true);
      else setErr(message);
    } finally { setBusy(false); }
  };
  return <Centered><Card title={t('phone.title')} logo={theme.logoUrl}>
    {!status && !err && <p>{t('common.loading')}</p>}
    {status && !status.available && <p className="notice">{t('phone.unavailable')}</p>}
    {expired && <>
      <p className="error">{t('phone.expired')}</p>
      {oauthQuery && <button className="btn primary" onClick={() => window.location.assign(restartUrl(oauthQuery))}>{t('phone.startAgain')}</button>}
    </>}
    {status?.available && !expired && <>
      <p>{status.enrolled ? t('phone.sendToRegistered', { suffix: String(status.suffix) }) : t('phone.register')}</p>
      {!status.enrolled && <Field label={t('phone.number')} value={phone} onChange={setPhone} type="tel" hint={t('phone.numberHint')} />}
      <button className="btn" disabled={busy || (!status.enrolled && !status.emailVerified)} onClick={() => void act(async () => { await sendPhoneCode(status.enrolled ? undefined : phone, oauthQuery); setSent(true); })}>{sent ? t('phone.sendAnother') : t('phone.send')}</button>
      {sent && <>
        <Field label={t('phone.code')} value={code} onChange={setCode} />
        <button className="btn primary" disabled={busy} onClick={() => void act(async () => { await verifyPhoneCode(code, oauthQuery); if (!oauthQuery) onDone(); })}>{t('phone.verify')}</button>
      </>}
      {!status.emailVerified && <button className="btn" disabled={busy} onClick={() => void act(async () => {
        const { error } = await authClient.sendVerificationEmail({ email: (await authClient.getSession()).data?.user.email ?? '', callbackURL: window.location.href });
        if (error) throw new Error(error.message ?? t('phone.verifyEmailFailed'));
        setNotice(t('phone.checkEmail'));
      })}>{t('phone.verifyEmail')}</button>}
    </>}
    {notice && <p className="notice">{notice}</p>}
    {err && <p className="error">{err}</p>}
    <button className="btn" disabled={busy} onClick={onBack}>{t('common.back')}</button>
  </Card></Centered>;
}
