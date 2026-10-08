import { useState } from 'react';
import { acceptAccountInvitation, invitationPassword, setupState } from '../api';
import { Card, Centered, Field } from '../primitives';
import { BankIdSignIn } from './SignIn';
import { PhoneFactor } from './PhoneFactor';

export function Invitation({ token }: { token: string }) {
  const [phase, setPhase] = useState<'accept' | 'choose' | 'bankid' | 'phone' | 'done'>('accept');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [bankid, setBankid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  if (phase === 'bankid') return <BankIdSignIn link oauthQuery={null} theme={{}} onDone={() => setPhase('done')} onBack={() => setPhase('choose')} />;
  if (phase === 'phone') return <PhoneFactor oauthQuery={null} onDone={() => setPhase('done')} onBack={() => { window.location.assign('/login'); }} />;
  return <Centered><Card title="Set up your account">
    {phase === 'accept' && <>
      <p>Confirm your email invitation to choose BankID or a password with SMS verification.</p>
      <button className="btn primary" disabled={busy} onClick={() => void act(async () => {
        const state = await setupState();
        const result = await acceptAccountInvitation(token);
        window.history.replaceState({}, '', '/accept-invitation');
        setEmail(result.email); setBankid(state.providers.some((p) => p.id === 'bankid')); setPhase('choose');
      })}>Accept invitation</button>
    </>}
    {phase === 'choose' && <>
      <p>{email} is verified. Choose how to sign in.</p>
      {bankid && <button className="btn primary" disabled={busy} onClick={() => setPhase('bankid')}>Connect BankID</button>}
      <Field label="Create a password" type="password" value={password} onChange={setPassword} hint="At least 8 characters" />
      <button className="btn" disabled={busy} onClick={() => void act(async () => { await invitationPassword(password); setPassword(''); setPhase('phone'); })}>Continue with password and SMS</button>
    </>}
    {phase === 'done' && <p className="notice">Your account is ready. Return to your publisher’s invitation or sign-in page to continue.</p>}
    {err && <p className="error">{err}</p>}
  </Card></Centered>;
}
