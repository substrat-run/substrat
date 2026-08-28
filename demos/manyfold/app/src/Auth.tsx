import { useEffect, useState } from 'react';
import { api, auth, ApiError } from './api';
import { Button, Card } from './ui';

/**
 * OIDC-only (oidc-only-demos.md): the vertical holds no accounts. Login, sign-up, password, and
 * reset all live at the instance's OIDC issuer. These screens only redirect there; the first
 * sign-in on a fresh instance still claims the owner seat (→ admin) via the worker binding.
 */

function Frame({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)', padding: 24 }}>
      <Card style={{ width: 372 }}>
        <div style={{ textAlign: 'center', marginBottom: 18 }}>
          <span style={{ display: 'inline-block', width: 26, height: 26, borderRadius: 8, background: 'var(--accent)', marginBottom: 10 }} />
          <div style={{ fontSize: 20, fontWeight: 700 }}>{title}</div>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 4 }}>{subtitle}</div>
        </div>
        {children}
      </Card>
    </div>
  );
}

/**
 * Accept an invite. The invitee's account lives at the issuer, so there is nothing to create
 * here — sign in (via the issuer), then claim the invite to bind this login to the pre-granted
 * member principal. On arrival we try the claim straight away (a session may already exist from
 * the redirect back); a 401 means "sign in first" and carries the token through the round-trip.
 */
export function AcceptInvite({ token }: { token: string }) {
  const [state, setState] = useState<'trying' | 'needs-login' | 'error'>('trying');
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    api.acceptInvite(token).then(
      () => {
        window.history.replaceState({}, '', location.pathname + location.hash); // drop ?invite=
        location.reload();
      },
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
    <Frame title="Join the workspace" subtitle="Sign in with your identity provider to accept the invite">
      {err && <div style={{ padding: '9px 12px', borderRadius: 'var(--r-input)', background: 'var(--st-danger-bg)', color: 'var(--st-danger-fg)', fontSize: 13, marginBottom: 12 }}>{err}</div>}
      {state === 'trying' ? (
        <div style={{ color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>Checking your invite…</div>
      ) : (
        <Button variant="primary" onClick={() => auth.login(`/?invite=${encodeURIComponent(token)}`)}>Continue to sign-in</Button>
      )}
    </Frame>
  );
}

/**
 * Claim the owner seat by link (#925). Same shape as AcceptInvite: try at once (a session may
 * already exist), and on 401 send them to the issuer with the token riding the round-trip.
 */
export function ClaimOwner({ token }: { token: string }) {
  const [state, setState] = useState<'trying' | 'needs-login' | 'error'>('trying');
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    api.claimOwner(token).then(
      () => {
        window.history.replaceState({}, '', location.pathname + location.hash); // drop ?claim=
        location.reload();
      },
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
    <Frame title="Claim this workspace" subtitle="Sign in with your identity provider to become its owner">
      {err && <div style={{ padding: '9px 12px', borderRadius: 'var(--r-input)', background: 'var(--st-danger-bg)', color: 'var(--st-danger-fg)', fontSize: 13, marginBottom: 12 }}>{err}</div>}
      {state === 'trying' ? (
        <div style={{ color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}>Checking your claim link…</div>
      ) : state === 'needs-login' ? (
        <Button variant="primary" onClick={() => auth.login(`/?claim=${encodeURIComponent(token)}`)}>Continue to sign-in</Button>
      ) : null}
    </Frame>
  );
}

/**
 * On a fresh instance the first sign-in claims the owner seat (→ admin) — for a window after
 * provision (#925). Once it has closed, the seat is claimed by a link from the dashboard, and
 * offering a sign-in that binds nobody would only look like a failed login.
 */
export function SignIn({ firstRun, firstSignInOpen = true }: { firstRun: boolean; firstSignInOpen?: boolean }) {
  const closed = firstRun && !firstSignInOpen;
  return (
    <Frame
      title="Manyfold"
      subtitle={
        closed
          ? 'This workspace has no owner yet, and the window for claiming it by signing in has closed. Ask whoever installed it for a claim link from the dashboard.'
          : firstRun
            ? 'Sign in with your identity provider to claim this workspace'
            : 'Sign in to your workspace'
      }
    >
      {!closed && <Button variant="primary" onClick={() => auth.login('/')}>Continue to sign-in</Button>}
    </Frame>
  );
}
