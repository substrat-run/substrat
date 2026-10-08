import { useEffect, useState } from 'react';
import { acceptAccountInvitation, invitationPassword, setupState } from '../api';
import { Card, Centered, Field } from '../primitives';
import { BankIdSignIn } from './SignIn';
import { PhoneFactor } from './PhoneFactor';
import { saveInvitation, type InvitationRecovery } from './invitation-recovery';

export function Invitation({ recovery }: { recovery: InvitationRecovery }) {
  const [phase, setPhase] = useState<'accept' | 'choose' | 'bankid' | 'phone' | 'done' | 'failed'>(recovery.phase);
  const [email, setEmail] = useState('email' in recovery ? recovery.email : '');
  const [password, setPassword] = useState('');
  const [bankid, setBankid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (recovery.phase === 'choose') void setupState().then((state) => {
      if (active) setBankid(state.providers.some((p) => p.id === 'bankid'));
    }).catch((e) => { if (active) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [recovery.phase]);
  const complete = () => { saveInvitation({ phase: 'done', email }); setPhase('done'); };
  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  if (phase === 'bankid') return <BankIdSignIn link oauthQuery={null} theme={{}} onDone={complete} onBack={() => setPhase('choose')} />;
  if (phase === 'phone') return <PhoneFactor oauthQuery={null} onDone={complete} onBack={() => { window.location.assign('/login'); }} />;
  return <Centered><Card title="Set up your account">
    {phase === 'accept' && <>
      <p>Confirm your email invitation to choose BankID or a password with SMS verification.</p>
      <button className="btn primary" disabled={busy} onClick={() => void act(async () => {
        const state = await setupState();
        if (recovery.phase !== 'accept') return;
        let result;
        try {
          result = await acceptAccountInvitation(recovery.token);
        } catch (error) {
          // Acceptance may have consumed the capability before a later server step failed.
          saveInvitation({ phase: 'failed' });
          window.history.replaceState({}, '', '/accept-invitation');
          setPhase('failed');
          throw error;
        }
        saveInvitation({ phase: 'choose', email: result.email });
        window.history.replaceState({}, '', '/accept-invitation');
        setEmail(result.email); setBankid(state.providers.some((p) => p.id === 'bankid')); setPhase('choose');
      })}>Accept invitation</button>
    </>}
    {phase === 'choose' && <>
      <p>{email} is verified. Choose how to sign in.</p>
      {bankid && <button className="btn primary" disabled={busy} onClick={() => setPhase('bankid')}>Connect BankID</button>}
      <Field label="Create a password" type="password" value={password} onChange={setPassword} hint="At least 8 characters" />
      <button className="btn" disabled={busy} onClick={() => void act(async () => { await invitationPassword(password); setPassword(''); saveInvitation({ phase: 'phone', email }); setPhase('phone'); })}>Continue with password and SMS</button>
    </>}
    {phase === 'failed' && <p className="error">Invitation acceptance could not be completed. The link may already have been used. Try signing in, or ask your administrator for help with a new invitation.</p>}
    {phase === 'done' && <p className="notice">Your account is ready. Return to your publisher’s invitation or sign-in page to continue.</p>}
    {err && <p className="error">{err}</p>}
  </Card></Centered>;
}
