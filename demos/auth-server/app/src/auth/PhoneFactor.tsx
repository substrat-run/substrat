import { useEffect, useState } from 'react';
import { authClient, phoneStatus, sendPhoneCode, verifyPhoneCode } from '../api';
import { Card, Centered, Field } from '../primitives';

export function PhoneFactor({ oauthQuery, onDone, onBack }: { oauthQuery: string | null; onDone: () => void; onBack: () => void }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof phoneStatus>> | null>(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => { void phoneStatus().then(setStatus).catch((e: Error) => setErr(e.message)); }, []);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return <Centered><Card title="Verify your phone">
    {!status && !err && <p>Loading…</p>}
    {status && !status.available && <p className="notice">SMS verification is unavailable. Contact your publisher or use BankID.</p>}
    {status?.available && <>
      <p>{status.enrolled ? `Send a code to your registered phone ending in ${status.suffix}.` : 'Register your phone using an international number, then enter the SMS code.'}</p>
      {!status.enrolled && <Field label="Phone number" value={phone} onChange={setPhone} type="tel" hint="For example +46701234567" />}
      <button className="btn" disabled={busy || (!status.enrolled && !status.emailVerified)} onClick={() => void act(async () => { await sendPhoneCode(status.enrolled ? undefined : phone); setSent(true); })}>{sent ? 'Send another code' : 'Send SMS code'}</button>
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
