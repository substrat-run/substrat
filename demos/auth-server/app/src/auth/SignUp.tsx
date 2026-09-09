import { useState } from 'react';
import {
  signUp,
  type ClientTheme,
} from '../api';
import { Centered, Card, Field } from '../primitives';

/**
 * Self-service registration. Shown only while an administrator has sign-up turned on — and
 * the issuer refuses `/sign-up/email` outright when it is off, so this screen being hidden is
 * the courtesy rather than the control.
 *
 * `onDone` handles the ordinary case; when a relying party sent this person here, creating
 * the account resumes that authorize request and the browser leaves for the app's callback
 * before this component would have re-rendered — the same `resumed` dance as sign-in.
 */
export function SignUp({
  forOidc, oauthQuery, theme, onDone, onSignIn,
}: { forOidc: boolean; oauthQuery: string | null; theme: ClientTheme; onDone: () => void; onSignIn: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Centered>
      <Card title="Create your account" logo={theme.logoUrl}>
        <p className="muted">
          {forOidc
            ? 'Create an account to continue to the application that sent you here.'
            : 'Create an account on this issuer.'}
        </p>
        <Field label="Name" value={name} onChange={setName} />
        <Field label="Email" value={email} onChange={setEmail} type="email" />
        <Field label="Password" value={password} onChange={setPassword} type="password" hint="At least 8 characters" />
        {err && <p className="error">{err}</p>}
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setErr(null);
            setBusy(true);
            try {
              const { resumed } = await signUp({ name, email, password }, oauthQuery);
              if (!resumed) onDone();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
              setBusy(false);
            }
          }}
        >
          {busy ? 'Creating…' : 'Create account'}
        </button>
        <button className="btn link" onClick={onSignIn}>
          I already have an account
        </button>
      </Card>
    </Centered>
  );
}
