import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import { Button } from './ui';

/**
 * OIDC-only (oidc-only-demos.md): this vertical holds no accounts. Login, sign-up, password,
 * and reset all live at the instance's OIDC issuer. The sign-in screen's only action is to
 * redirect there; the first sign-in on a fresh instance still claims the owner seat
 * (→ hr-admin) via the worker's provider-agnostic sub→principal binding.
 */

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
 * Accept a member invite. The invitee's ACCOUNT lives at the issuer, so there is nothing to
 * create here — sign in (via the issuer), then claim the invite with the token to bind this
 * login to the pre-granted member principal. On arrival we try the claim straight away (a
 * session may already exist from the redirect back); a 401 means "sign in first" and renders
 * the redirect button, carrying the token through the round-trip (`?invite=<token>`).
 */
export function AcceptInvite({ token, onDone }: { token: string; onDone: () => void }) {
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
 * Claim the owner seat by link (#925). Same shape as AcceptInvite: try at once (a session may
 * already exist), and on 401 send them to the issuer with the token riding the round-trip.
 */
export function ClaimOwner({ token, onDone }: { token: string; onDone: () => void }) {
  const [state, setState] = useState<'trying' | 'needs-login' | 'error'>('trying');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api.claimOwner(token).then(
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
    <AuthFrame title="Claim this workspace" subtitle="Sign in with your identity provider to become its owner">
      {err && <div className="err-banner">{err}</div>}
      {state === 'trying' ? (
        <div className="muted" style={{ textAlign: 'center', fontSize: 13 }}>Checking your claim link…</div>
      ) : state === 'needs-login' ? (
        <Button onClick={() => loginAt(`/?claim=${encodeURIComponent(token)}`)}>Continue to sign-in</Button>
      ) : null}
    </AuthFrame>
  );
}

/**
 * Sign-in for a hosted instance. Accounts and passwords live at the identity provider, so the
 * only action here is to go there. On a freshly-installed instance the first sign-in claims the
 * owner seat (→ hr-admin) via the worker binding — for a window after provision (#925). Once it
 * has closed, the seat is claimed by a link from the dashboard instead, and offering a sign-in
 * that binds nobody would only look like a failed login.
 */
export function SignIn({ firstRun = false, firstSignInOpen = true }: { onDone?: () => void; firstRun?: boolean; firstSignInOpen?: boolean }) {
  const closed = firstRun && !firstSignInOpen;
  return (
    <AuthFrame
      title="Meridian"
      subtitle={
        closed
          ? 'This workspace has no owner yet, and the window for claiming it by signing in has closed. Ask whoever installed it for a claim link from the dashboard.'
          : firstRun
            ? 'Sign in with your identity provider to claim this workspace'
            : 'Sign in to your HR workspace'
      }
    >
      {!closed && <Button onClick={() => loginAt('/')}>Continue to sign-in</Button>}
    </AuthFrame>
  );
}
