import { useState } from 'react';
import {
  signUp,
  type ClientTheme,
} from '../api';
import { Centered, Card, Field } from '../primitives';
import { useT } from './locale';

/**
 * Self-service registration. Shown only while an administrator has sign-up turned on — and
 * the issuer refuses `/sign-up/email` outright when it is off, so this screen being hidden is
 * the courtesy rather than the control.
 *
 * `onDone` handles the ordinary case; when a relying party sent this person here, creating
 * the account resumes that authorize request and the browser leaves for the app's callback
 * before this component would have re-rendered — the same `resumed` dance as sign-in.
 *
 * When the issuer requires a verified address, creating the account signs nobody in: the card
 * turns into "check your inbox", and the link in that mail finishes the job (and the trip back
 * to the application, when one sent them).
 */
export function SignUp({
  forOidc, oauthQuery, loginHint = null, theme, onDone, onSignIn,
}: {
  forOidc: boolean;
  oauthQuery: string | null;
  /** The relying party's `login_hint` (an invite's address): pre-filled and still editable. It
   *  proves nothing, so the address is verified exactly as a typed one is. */
  loginHint?: string | null;
  theme: ClientTheme;
  onDone: () => void;
  onSignIn: () => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [email, setEmail] = useState(loginHint ?? '');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  if (sentTo) {
    return (
      <Centered>
        <Card title={t('signup.checkInboxTitle')} logo={theme.logoUrl}>
          <p className="notice">{t('signup.checkInbox', { email: sentTo })}</p>
          <button className="btn link" onClick={onSignIn}>
            {t('signup.haveAccount')}
          </button>
        </Card>
      </Centered>
    );
  }
  return (
    <Centered>
      <Card title={t('signup.title')} logo={theme.logoUrl}>
        <p className="muted">
          {forOidc ? t('signup.forOidc') : t('signup.forIssuer')}
        </p>
        <Field label={t('signup.name')} value={name} onChange={setName} />
        <Field label={t('common.email')} value={email} onChange={setEmail} type="email" />
        <Field label={t('common.password')} value={password} onChange={setPassword} type="password" hint={t('common.passwordHint')} />
        {err && <p className="error">{err}</p>}
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setErr(null);
            setBusy(true);
            try {
              const { resumed, verificationSent } = await signUp({ name, email, password }, oauthQuery);
              if (verificationSent) {
                setSentTo(email.trim());
                setBusy(false);
              } else if (!resumed) onDone();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
              setBusy(false);
            }
          }}
        >
          {busy ? t('signup.creating') : t('signup.create')}
        </button>
        <button className="btn link" onClick={onSignIn}>
          {t('signup.haveAccount')}
        </button>
      </Card>
    </Centered>
  );
}
