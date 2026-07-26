import { useEffect, useState } from 'react';
import { api, auth, ApiError } from './api';
import { Button } from './ui';

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  borderRadius: 12,
  border: '1px solid var(--card-border)',
  background: 'var(--card)',
  color: 'var(--ink)',
  fontSize: 15,
};

/**
 * Which auth this instance runs, from the worker. `builtin` (Better Auth in the tenant's
 * IdentityDO) renders the email/password forms; `oidc` a redirect to the instance's
 * identity provider — the vertical holds no accounts in that mode
 * (vertical-auth-detach.md §2.3). Defaults to `builtin` if the probe fails, so a
 * transient error never blanks the sign-in screen.
 */
function useAuthMode(): 'builtin' | 'oidc' | null {
  const [mode, setMode] = useState<'builtin' | 'oidc' | null>(null);
  useEffect(() => {
    let alive = true;
    api.authMode().then(
      (r) => { if (alive) setMode(r.mode); },
      () => { if (alive) setMode('builtin'); },
    );
    return () => { alive = false; };
  }, []);
  return mode;
}

/** Send the browser to the issuer, returning to `returnTo` on this origin afterwards. */
function loginAt(returnTo: string): void {
  window.location.assign(`/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
}

/** The centered single-card frame every auth screen uses. */
function AuthFrame({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="phone">
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ width: '100%', maxWidth: 360, display: 'grid', gap: 14 }}>
          <div style={{ textAlign: 'center', marginBottom: 4 }}>
            <div className="brand-mark" style={{ margin: '0 auto 12px' }} />
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)' }}>{title}</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>{subtitle}</div>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * OIDC-mode invite accept: the invitee's ACCOUNT lives at the issuer, so there is nothing
 * to create here — sign in (via the issuer), then claim the invite with the token. On
 * arrival we try the claim straight away (a session may already exist from the redirect
 * back); a 401 means "sign in first" and renders the redirect button.
 */
function AcceptInviteOidc({ token, onDone }: { token: string; onDone: () => void }) {
  const [state, setState] = useState<'trying' | 'needs-login' | 'error'>('trying');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.acceptInvite(token).then(
      () => { if (alive) onDone(); },
      (e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) setState('needs-login');
        else { setErr(e instanceof ApiError ? e.message : String(e)); setState('error'); }
      },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per token
  }, [token]);
  return (
    <AuthFrame title="Join the workspace" subtitle="Sign in with your identity provider to accept the invite">
      {err && <div className="err-banner">{err}</div>}
      {state === 'trying' ? (
        <div className="muted" style={{ textAlign: 'center', fontSize: 13 }}>Checking your invite…</div>
      ) : (
        <Button onClick={() => loginAt(`/?invite=${encodeURIComponent(token)}`)}>Continue to sign-in</Button>
      )}
    </AuthFrame>
  );
}

/**
 * Sign-in / sign-up for a HOSTED instance. Production has no persona switcher — the real
 * user authenticates via Better Auth (the tenant's IdentityDO, behind the AuthProvider
 * contract). On a freshly-installed instance the FIRST sign-in claims the owner seat
 * (→ hr-admin), so the installer lands on the Admin/setup surface. On success we reload
 * so `/api/me` resolves the new session cookie.
 */
/**
 * Accept a member invite: the invitee arrived via `?invite=<token>`, creates their account
 * (sign-up is allowed because the token is valid), and immediately claims the invite so
 * their login binds to the pre-granted member principal. On success the app reloads (with a
 * cleaned URL) and `/api/me` resolves them as that member.
 */
export function AcceptInvite({ token, onDone }: { token: string; onDone: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mode = useAuthMode();
  // Don't flash the account-creation form on an instance whose accounts live at an
  // issuer — wait for the mode, then branch.
  if (mode === null) {
    return <AuthFrame title="Join the workspace" subtitle="One moment…">{null}</AuthFrame>;
  }
  if (mode === 'oidc') return <AcceptInviteOidc token={token} onDone={onDone} />;

  const submit = async () => {
    if (busy || !email.trim() || password.length < 8) return;
    setBusy(true);
    setErr(null);
    try {
      await auth.signUpWithInvite(email.trim(), password, name.trim() || email.trim(), token);
      await api.acceptInvite(token);
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="phone">
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ width: '100%', maxWidth: 360, display: 'grid', gap: 14 }}>
          <div style={{ textAlign: 'center', marginBottom: 4 }}>
            <div className="brand-mark" style={{ margin: '0 auto 12px' }} />
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)' }}>Join the workspace</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>Create your account to accept the invite</div>
          </div>
          {err && <div className="err-banner">{err}</div>}
          <input style={inputStyle} placeholder="Full name" aria-label="Full name" value={name} onChange={(e) => setName(e.target.value)} />
          <input style={inputStyle} type="email" placeholder="Email" aria-label="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input
            style={inputStyle}
            type="password"
            placeholder="Password (8+ characters)"
            aria-label="Password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          />
          <Button disabled={busy || !email.trim() || password.length < 8} onClick={() => void submit()}>
            {busy ? 'Please wait…' : 'Accept invite'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function SignIn({ onDone, firstRun = false }: { onDone: () => void; firstRun?: boolean }) {
  // First run: this instance has no admin yet, so the only path is to CREATE the admin
  // account (which claims the owner seat). Force sign-up and drop the "sign in instead"
  // toggle — there is nothing to sign in to yet.
  const [mode, setMode] = useState<'in' | 'up'>(firstRun ? 'up' : 'in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const authMode = useAuthMode();
  if (authMode === null) {
    return <AuthFrame title="Meridian" subtitle="One moment…">{null}</AuthFrame>;
  }
  // OIDC mode: accounts and passwords live at the identity provider — the only action
  // here is to go there. The first sign-in still claims the owner seat on a fresh
  // instance, so first-run needs no separate form either.
  if (authMode === 'oidc') {
    return (
      <AuthFrame
        title="Meridian"
        subtitle={firstRun ? 'Sign in with your identity provider to claim this workspace' : 'Sign in to your HR workspace'}
      >
        <Button onClick={() => loginAt('/')}>Continue to sign-in</Button>
      </AuthFrame>
    );
  }

  const submit = async () => {
    if (busy || !email.trim() || password.length < 8) return;
    setBusy(true);
    setErr(null);
    try {
      if (mode === 'up') await auth.signUp(email.trim(), password, name.trim() || email.trim());
      else await auth.signIn(email.trim(), password);
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="phone">
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ width: '100%', maxWidth: 360, display: 'grid', gap: 14 }}>
          <div style={{ textAlign: 'center', marginBottom: 4 }}>
            <div className="brand-mark" style={{ margin: '0 auto 12px' }} />
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--ink)' }}>Meridian</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              {firstRun
                ? 'Set up your workspace — create the admin account'
                : mode === 'in'
                  ? 'Sign in to your HR workspace'
                  : 'Create your account'}
            </div>
          </div>
          {err && <div className="err-banner">{err}</div>}
          {mode === 'up' && (
            <input style={inputStyle} placeholder="Full name" aria-label="Full name" value={name} onChange={(e) => setName(e.target.value)} />
          )}
          <input
            style={inputStyle}
            type="email"
            placeholder="Email"
            aria-label="Email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            style={inputStyle}
            type="password"
            placeholder="Password (8+ characters)"
            aria-label="Password"
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          />
          <Button disabled={busy || !email.trim() || password.length < 8} onClick={() => void submit()}>
            {busy ? 'Please wait…' : firstRun ? 'Create admin account' : mode === 'in' ? 'Sign in' : 'Create account'}
          </Button>
          {!firstRun && (
            <button
              type="button"
              onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setErr(null); }}
              style={{ background: 'none', border: 0, color: 'var(--accent)', fontSize: 13, cursor: 'pointer', padding: 4 }}
            >
              {mode === 'in' ? 'New here? Create an account' : 'Have an account? Sign in'}
            </button>
          )}
          {firstRun && (
            <div className="muted" style={{ fontSize: 12, textAlign: 'center', lineHeight: 1.5 }}>
              You’re the first here — this becomes the workspace admin. Teammates join by invite afterwards.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
