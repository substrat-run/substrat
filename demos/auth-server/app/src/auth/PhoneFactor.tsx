import { useEffect, useState } from 'react';
import { authClient, phoneStatus, sendPhoneCode, verifyPhoneCode } from '../api';
import { Card, Centered, Field } from '../primitives';

/** When the signed authorize query this sign-in rides on stops being accepted (its `exp`, in
 *  seconds), or null when there is no such query (account page, invitation). The server is the
 *  authority — it refuses the send and the verify alike — this only lets the screen say so
 *  before the person types a number and waits for an SMS that can no longer be used. */
function expiryOf(oauthQuery: string | null): number | null {
  const exp = Number(new URLSearchParams(oauthQuery ?? '').get('exp'));
  return oauthQuery && Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
}

/** The authorize request the signed query came from, without the signature material, so
 *  starting again yields a fresh login page instead of one that is already dead. */
function restartUrl(oauthQuery: string): string {
  const params = new URLSearchParams(oauthQuery);
  for (const key of ['sig', 'exp', 'ba_iat', 'ba_param', 'ba_pl']) params.delete(key);
  return `/api/auth/oauth2/authorize?${params.toString()}`;
}

const EXPIRED = 'This sign-in has expired. Start again from the application.';
const friendly = (message: string) => (message === 'invalid_signature' ? EXPIRED : message);

export function PhoneFactor({ oauthQuery, onDone, onBack }: { oauthQuery: string | null; onDone: () => void; onBack: () => void }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof phoneStatus>> | null>(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const expiresAt = expiryOf(oauthQuery);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  const expired = expiresAt !== null && now >= expiresAt;
  useEffect(() => { void phoneStatus().then(setStatus).catch((e: Error) => setErr(e.message)); }, []);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr(e instanceof Error ? friendly(e.message) : String(e)); } finally { setBusy(false); }
  };
  return <Centered><Card title="Verify your phone">
    {!status && !err && <p>Loading…</p>}
    {status && !status.available && <p className="notice">SMS verification is unavailable. Contact your publisher or use BankID.</p>}
    {expired && <>
      <p className="error">{EXPIRED}</p>
      {oauthQuery && <button className="btn primary" onClick={() => window.location.assign(restartUrl(oauthQuery))}>Start again</button>}
    </>}
    {status?.available && !expired && <>
      <p>{status.enrolled ? `Send a code to your registered phone ending in ${status.suffix}.` : 'Register your phone using an international number, then enter the SMS code.'}</p>
      {!status.enrolled && <Field label="Phone number" value={phone} onChange={setPhone} type="tel" hint="For example +46701234567" />}
      <button className="btn" disabled={busy || (!status.enrolled && !status.emailVerified)} onClick={() => void act(async () => { await sendPhoneCode(status.enrolled ? undefined : phone, oauthQuery); setSent(true); })}>{sent ? 'Send another code' : 'Send SMS code'}</button>
      {sent && <>
        <Field label="SMS code" value={code} onChange={setCode} />
        <button className="btn primary" disabled={busy} onClick={() => void act(async () => { await verifyPhoneCode(code, oauthQuery); if (!oauthQuery) onDone(); })}>Verify and continue</button>
      </>}
      {!status.emailVerified && <button className="btn" disabled={busy} onClick={() => void act(async () => {
        const { error } = await authClient.sendVerificationEmail({ email: (await authClient.getSession()).data?.user.email ?? '', callbackURL: window.location.href });
        if (error) throw new Error(error.message ?? 'Could not send verification email');
        setNotice('Check your email and verify your address before registering your phone.');
      })}>Verify my email</button>}
    </>}
    {notice && <p className="notice">{notice}</p>}
    {err && <p className="error">{err}</p>}
    <button className="btn" disabled={busy} onClick={onBack}>Back</button>
  </Card></Centered>;
}
