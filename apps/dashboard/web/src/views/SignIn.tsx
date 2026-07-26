import { useState } from 'react';
import { Button, Input } from '@substrat-run/ui';
import { StrataGlyph } from '../lib/icons';
import { signIn } from '../lib/api';

/**
 * The login-failed retry card. Signed-out visits normally redirect straight to the
 * platform's AuthHero instance (App.tsx hands off to `/api/auth/login` without
 * rendering anything local) — this card only renders after a failed OIDC round-trip
 * (`?error=auth`), where auto-redirecting again could loop. "Continue" retries the
 * hand-off; the email field seeds `login_hint`. First login bootstraps the tenant
 * (worker `resolveAccount`), so there is no separate sign-up call here.
 */
export function SignIn({ error }: { error?: boolean }) {
  const [email, setEmail] = useState('');
  return (
    <div style={{ minHeight: '100vh', background: 'var(--surface-page)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StrataGlyph size={20} />
        <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>substrat</span>
      </div>
      <div style={{ width: 352, maxWidth: '100%', background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 12, boxShadow: 'var(--shadow-sm)', padding: 24, display: 'flex', flexDirection: 'column', gap: 14, boxSizing: 'border-box' }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>Sign in</div>
        {error && (
          <div style={{ background: 'var(--status-danger-bg)', color: 'var(--status-danger-fg)', borderRadius: 6, padding: '8px 12px', fontSize: 12.5, lineHeight: 1.45 }}>
            Sign-in didn’t complete. Try again or <a href="#" style={{ color: 'var(--status-danger-fg)', textDecoration: 'underline' }}>reset your password</a>.
          </div>
        )}
        <Input label="Email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Button style={{ width: '100%', justifyContent: 'center' }} onClick={() => signIn({ loginHint: email || undefined })}>
          Continue
        </Button>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', textAlign: 'center' }}>
          New to Substrat? <a href="#" onClick={(e) => { e.preventDefault(); signIn(); }}>Create an account</a>
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>SSO options land here later — room reserved.</div>
    </div>
  );
}

/**
 * Shown when someone follows an invite link while signed in as the WRONG account —
 * the accept was refused because the verified email doesn't match the invited one.
 * A dead-end into "create a team" would be baffling here; this names the mismatch and
 * offers the two real ways out: sign out to use the invited email, or keep this account.
 */
export function InviteBlocked({
  teamName,
  invitedEmail,
  signedInAs,
  onSignOut,
  onContinue,
}: {
  teamName?: string;
  invitedEmail?: string;
  signedInAs?: string;
  onSignOut: () => void;
  onContinue: () => void;
}) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--surface-page)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <StrataGlyph size={20} />
        <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>substrat</span>
      </div>
      <div style={{ width: 380, maxWidth: '100%', background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 12, boxShadow: 'var(--shadow-sm)', padding: 24, display: 'flex', flexDirection: 'column', gap: 14, boxSizing: 'border-box' }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>
          This invite is for a different email
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
          {teamName ? <>The invitation to <strong>{teamName}</strong> was sent to </> : <>This invitation was sent to </>}
          {invitedEmail ? <strong>{invitedEmail}</strong> : 'another address'}
          {signedInAs ? <>, but you’re signed in as <strong>{signedInAs}</strong>.</> : '.'}
          {' '}Sign out to continue as {invitedEmail ? <strong>{invitedEmail}</strong> : 'the invited email'} — we’ll take you to sign-up if you don’t have an account yet.
        </div>
        <Button style={{ width: '100%', justifyContent: 'center' }} onClick={onSignOut}>
          Sign out &amp; continue as {invitedEmail ?? 'the invited email'}
        </Button>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', textAlign: 'center' }}>
          <a href="#" onClick={(e) => { e.preventDefault(); onContinue(); }}>Stay signed in as {signedInAs ?? 'this account'}</a>
        </div>
      </div>
    </div>
  );
}

/** The post-sign-up interstitial (screen 1c) — reused as the session-check state. */
export function Interstitial() {
  const steps = [
    { label: 'Creating your organization', done: true },
    { label: 'Provisioning your dashboard', done: true },
    { label: 'Granting you the owner role', done: false },
  ];
  return (
    <div style={{ minHeight: '100vh', background: 'var(--surface-page)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20, padding: 24 }}>
      <div style={{ animation: 'sub-pulse 1.6s ease-in-out infinite' }}>
        <StrataGlyph size={28} />
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)' }}>Setting up your workspace…</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, color: 'var(--text-secondary)', minWidth: 230 }}>
        {steps.map((s) => (
          <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 8, color: s.done ? undefined : 'var(--text-primary)' }}>
            {s.done ? (
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--status-success-fg)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            ) : (
              <span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid var(--border-strong)', borderTopColor: 'var(--brand-600)', animation: 'sub-spin 0.9s linear infinite', boxSizing: 'border-box' }} />
            )}
            {s.label}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>This usually takes a few seconds.</div>
    </div>
  );
}
