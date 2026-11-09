import { useEffect, useState } from 'react';
import { acceptAccountInvitation, invitationPassword, setupState, type ClientTheme } from '../api';
import { Card, Centered, Field } from '../primitives';
import { BankIdSignIn } from './SignIn';
import { useT } from './locale';
import { PhoneFactor } from './PhoneFactor';
import { saveInvitation, type InvitationRecovery } from './invitation-recovery';

export function Invitation({ recovery, theme }: { recovery: InvitationRecovery; theme: ClientTheme }) {
  const t = useT();
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
  if (phase === 'bankid') return <BankIdSignIn link oauthQuery={null} theme={theme} onDone={complete} onBack={() => setPhase('choose')} />;
  if (phase === 'phone') return <PhoneFactor oauthQuery={null} theme={theme} onDone={complete} onBack={() => { window.location.assign('/login'); }} />;
  return <Centered><Card title={t('invite.title')} logo={theme.logoUrl}>
    {phase === 'accept' && <>
      <p>{t('invite.confirm')}</p>
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
      })}>{t('invite.accept')}</button>
    </>}
    {phase === 'choose' && <>
      <p>{t('invite.verified', { email })}</p>
      {bankid && <button className="btn primary" disabled={busy} onClick={() => setPhase('bankid')}>{t('invite.connectBankid')}</button>}
      <Field label={t('invite.createPassword')} type="password" value={password} onChange={setPassword} hint={t('common.passwordHint')} />
      <button className="btn" disabled={busy} onClick={() => void act(async () => { await invitationPassword(password); setPassword(''); saveInvitation({ phase: 'phone', email }); setPhase('phone'); })}>{t('invite.passwordAndSms')}</button>
    </>}
    {phase === 'failed' && <p className="error">{t('invite.failed')}</p>}
    {phase === 'done' && <p className="notice">{t('invite.done')}</p>}
    {err && <p className="error">{err}</p>}
  </Card></Centered>;
}
