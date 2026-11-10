import { useState } from 'react';
import {
  authClient,
  type ClientTheme,
} from '../api';
import { Centered, Card, Field } from '../primitives';
import { useT } from './locale';

export function ResetPassword({ token, theme, onDone }: { token: string; theme: ClientTheme; onDone: () => void }) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  return (
    <Centered>
      <Card title={t('reset.title')} logo={theme.logoUrl}>
        {done ? (
          <>
            <p className="notice">{t('reset.done')}</p>
            <button className="btn primary" onClick={onDone}>{t('common.continue')}</button>
          </>
        ) : (
          <>
            <Field label={t('reset.newPassword')} value={password} onChange={setPassword} type="password" hint={t('common.passwordHint')} />
            {err && <p className="error">{err}</p>}
            <button
              className="btn primary"
              onClick={async () => {
                setErr(null);
                const { error } = await authClient.resetPassword({ newPassword: password, token });
                if (error) return setErr(error.message ?? t('reset.failed'));
                setDone(true);
              }}
            >
              {t('reset.submit')}
            </button>
          </>
        )}
      </Card>
    </Centered>
  );
}
