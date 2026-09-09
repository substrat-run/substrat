import { useState } from 'react';
import {
  createFirstAdmin,
  pendingOAuthQuery,
  signIn,
} from '../api';
import { Centered, Card, Field } from '../primitives';

export function Setup({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <Centered>
      <Card title="Create the first administrator">
        <p className="muted">This issuer has no users yet. The account you create here becomes the first admin.</p>
        <Field label="Name" value={name} onChange={setName} />
        <Field label="Email" value={email} onChange={setEmail} type="email" />
        <Field label="Password" value={password} onChange={setPassword} type="password" hint="At least 8 characters" />
        {err && <p className="error">{err}</p>}
        <button
          className="btn primary"
          onClick={async () => {
            setErr(null);
            try {
              await createFirstAdmin({ name, email, password });
              // Bootstrapping can itself be the answer to an RP's authorize request, so the
              // resume applies here too — see `signIn`. Read off the URL rather than passed
              // in: an un-bootstrapped issuer shows this screen wherever the person landed.
              const { resumed } = await signIn(email, password, pendingOAuthQuery(new URL(window.location.href)));
              if (!resumed) onDone();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Create admin & sign in
        </button>
      </Card>
    </Centered>
  );
}
