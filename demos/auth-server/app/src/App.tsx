import { useCallback, useEffect, useState } from 'react';
import {
  answerConsent,
  authClient,
  banUser,
  createFirstAdmin,
  createUser,
  currentSession,
  discovery,
  listUsers,
  oauthClient,
  pendingConsent,
  removeUser,
  requestPasswordReset,
  setRole,
  setupState,
  signIn,
  signOut,
  unbanUser,
  type AdminUser,
  type ConsentRequest,
  type Discovery,
  type OAuthClient,
  type Session,
} from './api';

type Phase =
  | { t: 'loading' }
  | { t: 'reset'; token: string }
  | { t: 'setup' }
  | { t: 'signin' }
  | { t: 'consent'; request: ConsentRequest }
  | { t: 'not-admin'; session: Session }
  | { t: 'dashboard'; session: Session };

/**
 * This app is TWO surfaces behind one origin: the admin dashboard, and the issuer's own
 * user-facing OIDC pages. `src/auth.ts` configures `loginPage: '/login'` and
 * `consentPage: '/consent'`, and Better Auth redirects people there mid-authorize — so those
 * two paths are part of the OIDC contract, not client routes we happen to own.
 *
 * Picking the screen from session state ALONE is what broke that (#898): `/consent` with a
 * session rendered the dashboard, so every relying party outside `trustedClients` was dropped
 * mid-round-trip and the user landed on an admin page they had not asked for. Path first,
 * then session.
 */
export default function App() {
  const [phase, setPhase] = useState<Phase>({ t: 'loading' });

  const refresh = useCallback(async () => {
    // A password-reset link lands the user here with a token — handle that first.
    const url = new URL(window.location.href);
    if (url.pathname === '/reset-password') {
      const token = url.searchParams.get('token');
      if (token) return setPhase({ t: 'reset', token });
    }
    const { needsSetup } = await setupState();
    if (needsSetup) return setPhase({ t: 'setup' });
    const session = await currentSession();

    // An authorize request is waiting on an answer. Without a session the consent code cannot
    // be honoured, so fall back to sign-in — Better Auth resumes from its own prompt cookie.
    if (url.pathname === '/consent') {
      const request = pendingConsent(url);
      if (session && request) return setPhase({ t: 'consent', request });
      return setPhase({ t: 'signin' });
    }
    // `/login` means an RP asked for a sign-in, and that stays true when a session already
    // exists: `prompt=login` (and an expired `max_age`) is a re-authentication request, and
    // answering it with the dashboard strands the flow exactly as `/consent` did.
    if (url.pathname === '/login') return setPhase({ t: 'signin' });

    if (!session) return setPhase({ t: 'signin' });
    setPhase(session.role === 'admin' ? { t: 'dashboard', session } : { t: 'not-admin', session });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Sign-in finished without an OIDC request to resume — leave `/login` for the dashboard. */
  const doneSigningIn = useCallback(() => {
    if (window.location.pathname !== '/') window.history.replaceState({}, '', '/');
    void refresh();
  }, [refresh]);

  switch (phase.t) {
    case 'loading':
      return <Centered>Loading…</Centered>;
    case 'reset':
      return <ResetPassword token={phase.token} onDone={() => { window.history.replaceState({}, '', '/'); void refresh(); }} />;
    case 'setup':
      return <Setup onDone={doneSigningIn} />;
    case 'signin':
      return <SignIn onDone={doneSigningIn} />;
    case 'consent':
      return <Consent request={phase.request} />;
    case 'not-admin':
      return (
        <Centered>
          <Card title="Not an administrator">
            <p className="muted">
              Signed in as <strong>{phase.session.email}</strong>, but this account does not hold the
              <code> admin</code> role, so the dashboard is unavailable.
            </p>
            <button className="btn" onClick={async () => { await signOut(); void refresh(); }}>Sign out</button>
          </Card>
        </Centered>
      );
    case 'dashboard':
      return <Dashboard session={phase.session} onSignOut={async () => { await signOut(); void refresh(); }} />;
  }
}

function Setup({ onDone }: { onDone: () => void }) {
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
              // resume applies here too — see `signIn`.
              const { resumed } = await signIn(email, password);
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

function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Reached at `/login` ⇒ a relying party sent this person here, not an operator opening the
  // console. `/consent` reaches it too, when the session expired under a pending request.
  // Same form either way, but promising the dashboard would be a lie about where they end up.
  const forOidc = window.location.pathname === '/login' || window.location.pathname === '/consent';
  return (
    <Centered>
      <Card title="Substrat Auth">
        <p className="muted">
          {forOidc ? 'Sign in to continue to the application that sent you here.' : 'Sign in to the admin dashboard.'}
        </p>
        <Field label="Email" value={email} onChange={setEmail} type="email" />
        <Field label="Password" value={password} onChange={setPassword} type="password" />
        {err && <p className="error">{err}</p>}
        {notice && <p className="notice">{notice}</p>}
        <button
          className="btn primary"
          onClick={async () => {
            setErr(null);
            try {
              // `resumed` ⇒ an authorize request took over and the browser is already on its
              // way back to the relying party; re-rendering here would flash the dashboard.
              const { resumed } = await signIn(email, password);
              if (!resumed) onDone();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Sign in
        </button>
        <button
          className="btn link"
          onClick={async () => {
            setErr(null);
            setNotice(null);
            if (!email) return setErr('Enter your email first, then request a reset.');
            try {
              await requestPasswordReset(email);
              setNotice('If that email has an account, a reset link is on its way.');
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Forgot password?
        </button>
      </Card>
    </Centered>
  );
}

function ResetPassword({ token, onDone }: { token: string; onDone: () => void }) {
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

/**
 * What each requested scope means, in the words of the person being asked. An unknown scope
 * is shown verbatim rather than hidden: consenting to something unnamed is not consent.
 */
const SCOPE_TEXT: Record<string, string> = {
  openid: 'Confirm who you are',
  profile: 'Your name and profile details',
  email: 'Your email address',
  offline_access: 'Stay signed in while you are away',
};

/**
 * The consent screen — the answer to an authorize request that Better Auth parked at
 * `/consent?consent_code=…`. Approving mints the authorization code and sends the browser to
 * the relying party's own callback; denying sends it there too, carrying `access_denied`.
 * Either way the RP hears back, which is the whole point: before this existed, both answers
 * were "you are now looking at an admin dashboard" (#898).
 */
function Consent({ request }: { request: ConsentRequest }) {
  const [client, setClient] = useState<OAuthClient | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void oauthClient(request.clientId).then(setClient).catch(() => setClient(null));
  }, [request.clientId]);

  const answer = async (accept: boolean) => {
    setErr(null);
    setBusy(true);
    try {
      // A full navigation, not a fetch — this URL belongs to the relying party.
      window.location.href = await answerConsent({ accept, consentCode: request.consentCode });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  // A dynamically registered client picks its own name, so it is a claim, not an identity.
  // The client id underneath is the part the issuer actually vouches for.
  const who = client?.name?.trim() || request.clientId;

  return (
    <Centered>
      <Card title="Authorize access">
        <p className="muted">
          <strong>{who}</strong> wants to sign you in with your Substrat Auth account.
        </p>
        {request.scopes.length > 0 && (
          <ul className="scopes">
            {request.scopes.map((scope) => (
              <li key={scope}>{SCOPE_TEXT[scope] ?? scope}</li>
            ))}
          </ul>
        )}
        {err && <p className="error">{err}</p>}
        <div className="consent-actions">
          <button className="btn primary" disabled={busy} onClick={() => void answer(true)}>
            {busy ? 'Working…' : 'Allow'}
          </button>
          <button className="btn" disabled={busy} onClick={() => void answer(false)}>
            Deny
          </button>
        </div>
        <p className="muted small">
          Requested by client <code>{request.clientId}</code>. Only continue if you started this
          from an application you trust.
        </p>
      </Card>
    </Centered>
  );
}

function Dashboard({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [disc, setDisc] = useState<Discovery | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setUsers(await listUsers());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    void discovery().then(setDisc);
  }, [reload]);

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">Substrat Auth</div>
        <div className="who">
          <span className="muted">{session.email}</span>
          <button className="btn link" onClick={onSignOut}>Sign out</button>
        </div>
      </header>
      <main className="content">
        {err && <p className="error">{err}</p>}
        <section className="panel">
          <div className="panel-head">
            <h2>Users</h2>
            <NewUser onCreated={reload} />
          </div>
          <UserTable users={users} me={session.sub} onChanged={reload} />
        </section>
        <IssuerPanel disc={disc} />
      </main>
    </div>
  );
}

function UserTable({ users, me, onChanged }: { users: AdminUser[] | null; me: string; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!users) return <p className="muted">Loading users…</p>;
  const act = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
      await onChanged();
    } finally {
      setBusy(null);
    }
  };
  return (
    <table className="grid">
      <thead>
        <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr>
      </thead>
      <tbody>
        {users.map((u) => (
          <tr key={u.id} className={busy === u.id ? 'busy' : ''}>
            <td>{u.name}{u.id === me && <span className="tag">you</span>}</td>
            <td>{u.email}{u.emailVerified ? '' : <span className="tag warn">unverified</span>}</td>
            <td>{u.role ?? 'user'}</td>
            <td>{u.banned ? <span className="tag warn">banned</span> : 'active'}</td>
            <td className="actions">
              {u.role === 'admin'
                ? <button className="btn tiny" disabled={u.id === me} onClick={() => act(u.id, () => setRole(u.id, 'user'))}>Demote</button>
                : <button className="btn tiny" onClick={() => act(u.id, () => setRole(u.id, 'admin'))}>Make admin</button>}
              {u.banned
                ? <button className="btn tiny" onClick={() => act(u.id, () => unbanUser(u.id))}>Unban</button>
                : <button className="btn tiny" disabled={u.id === me} onClick={() => act(u.id, () => banUser(u.id))}>Ban</button>}
              <button className="btn tiny danger" disabled={u.id === me} onClick={() => act(u.id, () => removeUser(u.id))}>Remove</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NewUser({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRoleState] = useState<'admin' | 'user'>('user');
  const [err, setErr] = useState<string | null>(null);
  if (!open) return <button className="btn" onClick={() => setOpen(true)}>+ New user</button>;
  return (
    <div className="new-user">
      <Field label="Name" value={name} onChange={setName} />
      <Field label="Email" value={email} onChange={setEmail} type="email" />
      <Field label="Password" value={password} onChange={setPassword} type="password" />
      <label className="field">
        <span>Role</span>
        <select value={role} onChange={(e) => setRoleState(e.target.value as 'admin' | 'user')}>
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
      </label>
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button
          className="btn primary"
          onClick={async () => {
            setErr(null);
            try {
              await createUser({ name, email, password, role });
              setOpen(false);
              setName(''); setEmail(''); setPassword(''); setRoleState('user');
              onCreated();
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Create
        </button>
        <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

function IssuerPanel({ disc }: { disc: Discovery | null }) {
  return (
    <section className="panel">
      <div className="panel-head"><h2>OIDC issuer</h2></div>
      {!disc ? (
        <p className="muted">Discovery unavailable.</p>
      ) : (
        <dl className="kv">
          <dt>Issuer</dt><dd><code>{disc.issuer}</code></dd>
          <dt>Discovery</dt><dd><code>{disc.issuer.replace(/\/$/, '')}/.well-known/openid-configuration</code></dd>
          <dt>Authorize</dt><dd><code>{disc.authorization_endpoint}</code></dd>
          <dt>Token</dt><dd><code>{disc.token_endpoint}</code></dd>
          <dt>JWKS</dt><dd><code>{disc.jwks_uri}</code></dd>
          <dt>Signing</dt><dd><code>{(disc.id_token_signing_alg_values_supported ?? []).join(', ') || '—'}</code></dd>
        </dl>
      )}
      <p className="muted small">
        Point any OIDC relying party at the issuer above. New clients can self-register at the
        registration endpoint, or be added by an admin.
      </p>
    </section>
  );
}

/* ---- little building blocks ---- */

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="centered">{children}</div>;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h1>{title}</h1>
      {children}
    </div>
  );
}

function Field({
  label, value, onChange, type = 'text', hint,
}: { label: string; value: string; onChange: (v: string) => void; type?: string; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
      {hint && <em className="hint">{hint}</em>}
    </label>
  );
}
