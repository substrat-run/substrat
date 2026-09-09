import { useState } from 'react';
import {
  authClient,
} from '../api';
import { Centered, Card, Field } from '../primitives';

export function ResetPassword({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  return (
    <Centered>
      <Card title="Set a new password">
        {done ? (
          <>
            <p className="notice">Your password has been reset. You can sign in now.</p>
            <button className="btn primary" onClick={onDone}>Continue</button>
          </>
        ) : (
          <>
            <Field label="New password" value={password} onChange={setPassword} type="password" hint="At least 8 characters" />
            {err && <p className="error">{err}</p>}
            <button
              className="btn primary"
              onClick={async () => {
                setErr(null);
                const { error } = await authClient.resetPassword({ newPassword: password, token });
                if (error) return setErr(error.message ?? 'reset failed');
                setDone(true);
              }}
            >
              Reset password
            </button>
          </>
        )}
      </Card>
    </Centered>
  );
}
