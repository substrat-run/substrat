import { useCallback, useEffect, useState } from 'react';
import {
  answerConsent,
  authClient,
  banUser,
  APPLICATION_TYPES,
  createFirstAdmin,
  createOAuthClient,
  createUser,
  currentSession,
  deleteOAuthClient,
  discovery,
  issuerSettings,
  listOAuthClients,
  listUsers,
  oauthClient,
  pendingConsent,
  pendingOAuthQuery,
  removeUser,
  requestPasswordReset,
  rotateOAuthClientSecret,
  setIssuerSettings,
  setRole,
  setupState,
  signIn,
  signOut,
  signUp,
  unbanUser,
  updateOAuthClient,
  identityProviders,
  removeIdentityProvider,
  saveIdentityProvider,
  signInSocial,
  socialErrorFrom,
  type AdminUser,
  type ApplicationType,
  type ClientDraft,
  type ConfiguredProvider,
  type ProviderCatalogueEntry,
  type ProviderDraft,
  type PublicProvider,
  type ConsentRequest,
  type Discovery,
  type IssuerSettings,
  type OAuthClient,
  type RegisteredClient,
  type Session,
} from './api';

type Phase =
  | { t: 'loading' }
  | { t: 'reset'; token: string }
  | { t: 'setup' }
  | { t: 'signin'; signupEnabled: boolean; oauthQuery: string | null; providers: PublicProvider[]; socialError: string | null }
  | { t: 'signup'; forOidc: boolean; oauthQuery: string | null }
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
    const { needsSetup, signupEnabled, providers } = await setupState();
    // A social sign-in that was refused comes back to `/` carrying its reason. Read it before
    // anything else re-renders, so the sign-in screen can say what happened.
    const socialError = socialErrorFrom(url);
    if (needsSetup) return setPhase({ t: 'setup' });
    const session = await currentSession();
    // The pending authorize request, if one sent this person here. The server does NOT
    // remember it — it is carried in this signed query and must be handed back with whatever
    // the person does next, or the relying party never hears the answer.
    const oauthQuery = pendingOAuthQuery(url);
    const forOidc = oauthQuery !== null;

    // An authorize request is waiting on an answer. Without a session the consent code cannot
    // be honoured, so fall back to sign-in — Better Auth resumes from its own prompt cookie.
    if (url.pathname === '/consent') {
      const request = pendingConsent(url);
      if (session && request) return setPhase({ t: 'consent', request });
      return setPhase({ t: 'signin', signupEnabled, oauthQuery, providers, socialError });
    }
    // Sign-up is a pre-auth screen like the other two, and reachable mid-authorize: the
    // pending request lives in a cookie, so creating an account resumes it the same way
    // signing in does. A closed issuer sends this path back to sign-in rather than showing
    // a form the endpoint would refuse.
    if (url.pathname === '/signup') {
      return setPhase(signupEnabled ? { t: 'signup', forOidc, oauthQuery } : { t: 'signin', signupEnabled, oauthQuery, providers, socialError });
    }
    // `/login` means an RP asked for a sign-in, and that stays true when a session already
    // exists: `prompt=login` (and an expired `max_age`) is a re-authentication request, and
    // answering it with the dashboard strands the flow exactly as `/consent` did.
    if (url.pathname === '/login') return setPhase({ t: 'signin', signupEnabled, oauthQuery, providers, socialError });

    if (!session) return setPhase({ t: 'signin', signupEnabled, oauthQuery, providers, socialError });
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
      return (
        <SignIn
          onDone={doneSigningIn}
          signupEnabled={phase.signupEnabled}
          oauthQuery={phase.oauthQuery}
          providers={phase.providers}
          socialError={phase.socialError}
          onSignUp={() => setPhase({ t: 'signup', forOidc: phase.oauthQuery !== null, oauthQuery: phase.oauthQuery })}
        />
      );
    case 'signup':
      // The URL is left alone on purpose: a pending authorize request is carried in a cookie,
      // and staying on `/login` keeps the browser's back button on the flow it came from.
      return (
        <SignUp
          forOidc={phase.forOidc}
          oauthQuery={phase.oauthQuery}
          onDone={doneSigningIn}
          onSignIn={() => void refresh()}
        />
      );
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

function SignIn({
  onDone, signupEnabled, oauthQuery, onSignUp, providers, socialError,
}: {
  onDone: () => void;
  signupEnabled: boolean;
  oauthQuery: string | null;
  onSignUp: () => void;
  providers: PublicProvider[];
  socialError: string | null;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(socialError);
  const [notice, setNotice] = useState<string | null>(null);
  // A signed authorize query ⇒ a relying party sent this person here, not an operator opening
  // the console. Same form either way, but promising the dashboard would be a lie about where
  // they end up.
  const forOidc = oauthQuery !== null;
  return (
    <Centered>
      <Card title="Substrat Auth">
        <p className="muted">
          {forOidc ? 'Sign in to continue to the application that sent you here.' : 'Sign in to the admin dashboard.'}
        </p>
        {providers.length > 0 && (
          <div className="providers">
            {providers.map((provider) => (
              <button
                key={provider.id}
                className="btn"
                onClick={async () => {
                  setErr(null);
                  try {
                    // Nothing follows: the response is a redirect to the provider and the
                    // browser client follows it. The pending authorize request goes along.
                    await signInSocial(provider.id, oauthQuery);
                  } catch (e) {
                    setErr(e instanceof Error ? e.message : String(e));
                  }
                }}
              >
                Continue with {provider.label}
              </button>
            ))}
            <div className="or"><span>or</span></div>
          </div>
        )}
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
              const { resumed } = await signIn(email, password, oauthQuery);
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
        {signupEnabled && (
          <button className="btn link" onClick={onSignUp}>
            Create an account
          </button>
        )}
      </Card>
    </Centered>
  );
}

/**
 * Self-service registration. Shown only while an administrator has sign-up turned on — and
 * the issuer refuses `/sign-up/email` outright when it is off, so this screen being hidden is
 * the courtesy rather than the control.
 *
 * `onDone` handles the ordinary case; when a relying party sent this person here, creating
 * the account resumes that authorize request and the browser leaves for the app's callback
 * before this component would have re-rendered — the same `resumed` dance as sign-in.
 */
function SignUp({
  forOidc, oauthQuery, onDone, onSignIn,
}: { forOidc: boolean; oauthQuery: string | null; onDone: () => void; onSignIn: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Centered>
      <Card title="Create your account">
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
 * The consent screen — the answer to an authorize request the plugin parked at `/consent?…`.
 * The request itself is the signed query in that URL (there is no server-side consent code
 * any more), and it must be handed back with the answer. Approving mints the authorization
 * code and sends the browser to the relying party's own callback; denying sends it there too,
 * carrying `access_denied`. Either way the RP hears back, which is the whole point: before
 * this screen existed, both answers were "you are now looking at an admin dashboard" (#898).
 */
function Consent({ request }: { request: ConsentRequest }) {
  const [client, setClient] = useState<OAuthClient | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void oauthClient(request.clientId, request.oauthQuery)
      .then(setClient)
      .catch(() => setClient(null));
  }, [request.clientId, request.oauthQuery]);

  const answer = async (accept: boolean) => {
    setErr(null);
    setBusy(true);
    try {
      // A full navigation, not a fetch — this URL belongs to the relying party.
      window.location.href = await answerConsent({ accept, oauthQuery: request.oauthQuery });
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
        <AccessPanel />
        <ProvidersPanel issuer={disc?.issuer ?? null} />
        <ClientsPanel />
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

/**
 * Who may get in. One setting today — self-service sign-up — written to the SAME declared
 * config key (`ALLOW_SIGNUP`) the platform's Env tab and a `wrangler` var write, so there is
 * one answer to "is sign-up open" no matter which of the three set it. The issuer rebuilds
 * Better Auth per request, so the toggle applies to the very next sign-up attempt.
 */
function AccessPanel() {
  const [settings, setSettings] = useState<IssuerSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void issuerSettings()
      .then(setSettings)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const toggle = async (allowSignup: boolean) => {
    setErr(null);
    setBusy(true);
    try {
      setSettings(await setIssuerSettings({ allowSignup }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head"><h2>Access</h2></div>
      {err && <p className="error">{err}</p>}
      {!settings ? (
        <p className="muted">Loading…</p>
      ) : (
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.allowSignup}
            disabled={busy}
            onChange={(e) => void toggle(e.target.checked)}
          />
          <span>
            <strong>Allow sign-up</strong>
            <em className="hint">
              {settings.allowSignup
                ? 'Anyone who reaches this issuer can create an account — including someone a relying party sent to sign in.'
                : 'Only administrators can create accounts. The sign-up screen is hidden and the endpoint refuses.'}
            </em>
          </span>
        </label>
      )}
    </section>
  );
}

/* ---- the upstream identity providers ---- */

/**
 * The directories this issuer will sign people in THROUGH — the other end of the registry
 * below. "Applications" holds the apps that send people here; this holds the providers this
 * issuer itself is a relying party of.
 *
 * The catalogue is closed on purpose (`src/providers.ts`): each entry is a provider Better
 * Auth ships endpoints and a profile mapping for, so enabling one is a credential and two
 * decisions rather than a form full of URLs to get subtly wrong.
 */
function ProvidersPanel({ issuer }: { issuer: string | null }) {
  const [catalogue, setCatalogue] = useState<ProviderCatalogueEntry[] | null>(null);
  const [providers, setProviders] = useState<ConfiguredProvider[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setErr(null);
    try {
      const state = await identityProviders();
      setCatalogue(state.catalogue);
      setProviders(state.providers);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const configured = (id: string) => providers.find((p) => p.id === id);
  const unconfigured = (catalogue ?? []).filter((entry) => !configured(entry.id));

  return (
    <section className="panel">
      <div className="panel-head"><h2>Sign-in providers</h2></div>
      {err && <p className="error">{err}</p>}
      {!catalogue ? (
        <p className="muted">Loading providers…</p>
      ) : (
        <>
          <p className="muted">
            Directories this issuer signs people in through. Enabling one adds a “Continue with
            …” button to the login screen — including for people a relying party sent here.
          </p>
          {providers.length > 0 && (
            <table className="grid">
              <thead>
                <tr><th>Provider</th><th>Client ID</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {providers.map((provider) => {
                  const entry = catalogue.find((e) => e.id === provider.id);
                  return (
                    <tr key={provider.id}>
                      <td>
                        <div>
                          {entry?.label ?? provider.id}
                          {provider.allowSignup && <span className="tag">creates accounts</span>}
                          {provider.trustEmail && <span className="tag">trusted email</span>}
                        </div>
                        {provider.tenantId && <code className="client-id">{provider.tenantId}</code>}
                      </td>
                      <td><code>{provider.clientId}</code></td>
                      <td>{provider.disabled ? 'Disabled' : 'Enabled'}</td>
                      <td className="actions">
                        <button className="btn tiny" onClick={() => setEditing(provider.id)}>Edit</button>
                        <button
                          className="btn tiny danger"
                          onClick={async () => {
                            if (!window.confirm(`Remove ${entry?.label ?? provider.id}? People who signed in with it will need another way in.`)) return;
                            try {
                              await removeIdentityProvider(provider.id);
                              // Close the editor if it was showing THIS provider. The table
                              // stays clickable while it is open, so Remove can be pressed on
                              // the row being edited — and the key that fixes provider-to-
                              // provider switching cannot help here, because the id has not
                              // changed. Without this the form survives its own row, flips to
                              // "Enable", and keeps the deleted client id and toggles.
                              // Functional, so a newer editor opened meanwhile is left alone.
                              setEditing((current) => (current === provider.id ? null : current));
                              await reload();
                            } catch (e) {
                              setErr(e instanceof Error ? e.message : String(e));
                            }
                          }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {unconfigured.length > 0 && !editing && (
            <div className="add-provider">
              {unconfigured.map((entry) => (
                <button key={entry.id} className="btn" onClick={() => setEditing(entry.id)}>
                  + {entry.label}
                </button>
              ))}
            </div>
          )}
          {editing && (
            <ProviderEditor
              // The table stays clickable while the editor is open, so Edit on a second
              // provider changes `editing` without unmounting this. Same element type in the
              // same position ⇒ React keeps the instance and its `useState` initialisers do
              // not re-run, so the form would still hold the FIRST provider's credentials and
              // save them onto the second one's row. The key is what makes it a remount.
              key={editing}
              issuer={issuer}
              entry={catalogue.find((e) => e.id === editing)!}
              provider={configured(editing) ?? null}
              onCancel={() => setEditing(null)}
              onSaved={async () => {
                setEditing(null);
                await reload();
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

/**
 * One provider's credentials and the two decisions that come with it.
 *
 * The redirect URI is SHOWN, not asked for: it is derived from the provider id and this
 * issuer's own origin, and every upstream refuses the sign-in outright if what is registered
 * there differs by so much as a trailing slash. Making an operator retype it would only
 * introduce a way to get it wrong.
 */
function ProviderEditor({
  issuer, entry, provider, onCancel, onSaved,
}: {
  /**
   * The issuer's OWN origin, from discovery — not `window.location.origin`. In production they
   * are the same host; in dev the dashboard is served by Vite on another port, and printing
   * that one would tell an operator to register a redirect URI the issuer will never send.
   */
  issuer: string | null;
  entry: ProviderCatalogueEntry;
  provider: ConfiguredProvider | null;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [clientId, setClientId] = useState(provider?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [tenantId, setTenantId] = useState(provider?.tenantId ?? '');
  const [allowSignup, setAllowSignup] = useState(provider?.allowSignup ?? false);
  const [trustEmail, setTrustEmail] = useState(provider?.trustEmail ?? false);
  const [disabled, setDisabled] = useState(provider?.disabled ?? false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setErr(null);
    const draft: ProviderDraft = {
      clientId: clientId.trim(),
      // Empty means "leave the stored secret alone" — an edit that only flips a toggle must
      // not require re-pasting a credential the operator may no longer have.
      ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      tenantId: tenantId.trim() || null,
      allowSignup,
      trustEmail,
      disabled,
    };
    setBusy(true);
    try {
      await saveIdentityProvider(entry.id, draft);
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="editor">
      <h3>{provider ? `Edit ${entry.label}` : `Enable ${entry.label}`}</h3>
      <label className="field">
        <span>Redirect URI</span>
        <code>
          {(issuer ?? window.location.origin).replace(/\/$/, '')}
          {provider?.callbackPath ?? `/api/auth/callback/${entry.id}`}
        </code>
        <em className="hint">Register this exactly, at {entry.console}. Matched character for character.</em>
      </label>
      <Field label="Client ID" value={clientId} onChange={setClientId} />
      <Field
        label={provider?.clientSecretSet ? 'Client secret (stored — type to replace)' : 'Client secret'}
        value={clientSecret}
        onChange={setClientSecret}
        type="password"
        hint={provider?.clientSecretSet ? 'Leave blank to keep the secret already stored.' : undefined}
      />
      {entry.tenantField && (
        <Field
          label={entry.tenantField.label}
          value={tenantId}
          onChange={setTenantId}
          hint={entry.tenantField.hint}
        />
      )}
      <label className="toggle">
        <input type="checkbox" checked={allowSignup} onChange={(e) => setAllowSignup(e.target.checked)} />
        <span>
          <strong>Let this provider create accounts</strong>
          <em className="hint">
            On, anyone who can sign in upstream gets an account here — for a directory you own,
            that is usually the point. Off, only people who already have an account can use it.
            Separate from the issuer-wide sign-up toggle, which is about passwords.
          </em>
        </span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={trustEmail} onChange={(e) => setTrustEmail(e.target.checked)} />
        <span>
          <strong>Trust this provider’s email addresses</strong>
          <em className="hint">
            Lets someone sign in to an account that already exists here with the same address.
            Without it they are refused with “account not linked” — Microsoft in particular does
            not assert that an address is verified. The local account must also have a verified
            email. Only turn this on for a directory that controls its addresses.
          </em>
        </span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
        <span>
          <strong>Disabled</strong>
          <em className="hint">Keeps the credentials but takes the button off the login screen.</em>
        </span>
      </label>
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : provider ? 'Save changes' : 'Enable'}
        </button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/* ---- the relying-party registry ---- */

const EMPTY_DRAFT: ClientDraft = {
  client_name: '',
  application_type: 'web',
  redirect_uris: [],
  logo_uri: '',
  metadata: {},
  skip_consent: false,
  disabled: false,
};

/**
 * The applications this issuer will answer for. Better Auth registers clients (dynamically,
 * or from `trustedClients` in code) but offers no way to see or change them afterwards — so
 * before this panel, the only record of a registered app was a row in the platform's
 * read-only Data tab.
 */
function ClientsPanel() {
  const [clients, setClients] = useState<RegisteredClient[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<RegisteredClient | 'new' | null>(null);
  /** A freshly minted secret, held until dismissed — the only moment it is knowable. */
  const [secret, setSecret] = useState<{ clientId: string; clientSecret: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      setClients(await listOAuthClients());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (fn: () => Promise<void>) => {
    setErr(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Applications</h2>
        {!editing && <button className="btn" onClick={() => setEditing('new')}>+ New client</button>}
      </div>
      {err && <p className="error">{err}</p>}
      {secret && <SecretOnce {...secret} onDismiss={() => setSecret(null)} />}
      {editing && (
        <ClientEditor
          // Same reason as the providers panel above: Edit on a second client while this is
          // open would otherwise keep the first one's form state and save it onto the second.
          key={editing === 'new' ? 'new' : editing.client_id}
          client={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={async (result) => {
            setEditing(null);
            if (result) setSecret(result);
            await reload();
          }}
        />
      )}
      {!clients ? (
        <p className="muted">Loading applications…</p>
      ) : clients.length === 0 ? (
        <p className="muted">
          No applications yet. Register one here, or let it register itself at the issuer’s
          registration endpoint.
        </p>
      ) : (
        <table className="grid">
          <thead>
            <tr><th>Application</th><th>Redirect URIs</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {clients.map((client) => (
              <tr key={client.client_id}>
                <td>
                  <div>
                    {client.client_name ?? 'Unnamed application'}
                    <span className="tag">{client.application_type ?? 'web'}</span>
                    {client.skip_consent && <span className="tag">no consent screen</span>}
                    {!client.user_id && <span className="tag">self-registered</span>}
                  </div>
                  <code className="client-id">{client.client_id}</code>
                </td>
                <td className="uris">
                  {client.redirect_uris.map((uri) => <div key={uri}><code>{uri}</code></div>)}
                </td>
                <td>
                  {client.disabled ? <span className="tag warn">disabled</span> : 'active'}
                  {!client.client_secret_set && <span className="tag">public</span>}
                </td>
                <td className="actions">
                  <button className="btn tiny" onClick={() => setEditing(client)}>Edit</button>
                  <button
                    className="btn tiny"
                    onClick={() =>
                      void act(async () => {
                        await updateOAuthClient(client.client_id, { disabled: !client.disabled });
                      })
                    }
                  >
                    {client.disabled ? 'Enable' : 'Disable'}
                  </button>
                  {client.client_secret_set && (
                    <button
                      className="btn tiny"
                      onClick={() =>
                        void act(async () => {
                          if (!confirm(`Rotate the secret for “${client.client_name ?? client.client_id}”? The current one stops working immediately.`)) return;
                          setSecret(
                            await rotateOAuthClientSecret(client.client_id).then((r) => ({
                              clientId: r.client.client_id,
                              clientSecret: r.clientSecret,
                            })),
                          );
                        })
                      }
                    >
                      Rotate secret
                    </button>
                  )}
                  <button
                    className="btn tiny danger"
                    onClick={() =>
                      void act(async () => {
                        if (!confirm(`Remove “${client.client_name ?? client.client_id}”? Its tokens and consents go with it.`)) return;
                        await deleteOAuthClient(client.client_id);
                        // Same as the providers panel: the editor outlives the row it edits
                        // unless it is told, and its next save would PATCH a client that is
                        // gone.
                        setEditing((current) =>
                          current !== 'new' && current?.client_id === client.client_id ? null : current,
                        );
                      })
                    }
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">
        Each application connects with its own client ID, so the login and consent screens can
        tell them apart — the name and icon here are what a person sees when that application
        asks them to sign in.
      </p>
    </section>
  );
}

/** A minted secret, shown once. There is no route that can show it again — that is deliberate. */
function SecretOnce({
  clientId, clientSecret, onDismiss,
}: { clientId: string; clientSecret: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="secret-once">
      <p><strong>Copy this secret now.</strong> It is not stored anywhere you can read it again.</p>
      <dl className="kv">
        <dt>Client ID</dt><dd><code>{clientId}</code></dd>
        <dt>Client secret</dt><dd><code>{clientSecret}</code></dd>
      </dl>
      <div className="row">
        <button
          className="btn"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(clientSecret);
              setCopied(true);
            } catch {
              // Clipboard access can be refused; the value is on screen to select either way.
              setCopied(false);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy secret'}
        </button>
        <button className="btn" onClick={onDismiss}>Done</button>
      </div>
    </div>
  );
}

/**
 * The new/edit form. Redirect URIs are one per line and must match the application's callback
 * EXACTLY — the issuer compares them as strings, so a trailing slash is a different URI.
 * Metadata is free-form JSON the issuer stores and never interprets; it is there for the
 * login and consent screens to read per client.
 */
function ClientEditor({
  client, onCancel, onSaved,
}: {
  client: RegisteredClient | null;
  onCancel: () => void;
  onSaved: (secret: { clientId: string; clientSecret: string } | null) => void | Promise<void>;
}) {
  const [name, setName] = useState(client?.client_name ?? '');
  const [type, setType] = useState<ApplicationType>(
    (client?.application_type as ApplicationType | undefined) ?? EMPTY_DRAFT.application_type,
  );
  const [icon, setIcon] = useState(client?.logo_uri ?? '');
  const [uris, setUris] = useState((client?.redirect_uris ?? []).join('\n'));
  const [skipConsent, setSkipConsent] = useState(Boolean(client?.skip_consent));
  const [meta, setMeta] = useState(
    client?.metadata && Object.keys(client.metadata).length ? JSON.stringify(client.metadata, null, 2) : '',
  );
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setErr(null);
    let metadata: Record<string, unknown> = {};
    if (meta.trim()) {
      try {
        const value: unknown = JSON.parse(meta);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('must be a JSON object');
        metadata = value as Record<string, unknown>;
      } catch (e) {
        return setErr(`Metadata: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const draft: ClientDraft = {
      client_name: name.trim(),
      application_type: type,
      redirect_uris: uris.split('\n').map((u) => u.trim()).filter(Boolean),
      metadata,
      skip_consent: skipConsent,
      disabled: client?.disabled ?? false,
      ...(icon.trim() ? { logo_uri: icon.trim() } : {}),
    };
    setBusy(true);
    try {
      if (client) {
        await updateOAuthClient(client.client_id, draft);
        await onSaved(null);
      } else {
        const created = await createOAuthClient(draft);
        await onSaved({ clientId: created.client.client_id, clientSecret: created.clientSecret });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="editor">
      <h3>{client ? `Edit ${client.client_name ?? client.client_id}` : 'Register an application'}</h3>
      <Field label="Name" value={name} onChange={setName} hint="Shown on the consent screen — this is what people read." />
      <label className="field">
        <span>Application type</span>
        <select value={type} onChange={(e) => setType(e.target.value as ApplicationType)}>
          {APPLICATION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <em className="hint">
          A <code>web</code> client keeps its secret on a server. A <code>native</code> one is public — PKCE, and
          loopback or private-scheme redirect URIs are allowed.
        </em>
      </label>
      <label className="field">
        <span>Redirect URIs</span>
        <textarea rows={3} value={uris} onChange={(e) => setUris(e.target.value)} />
        <em className="hint">One per line, matched exactly. A `web` client needs HTTPS unless it is on loopback.</em>
      </label>
      <Field label="Logo URL" value={icon} onChange={setIcon} hint="Optional. Shown beside the name on the consent screen." />
      <label className="toggle">
        <input type="checkbox" checked={skipConsent} onChange={(e) => setSkipConsent(e.target.checked)} />
        <span>
          <strong>Skip the consent screen</strong>
          <em className="hint">
            For a first-party application you already trust. Nobody will be asked to approve the scopes it requests.
          </em>
        </span>
      </label>
      <label className="field">
        <span>Metadata (JSON)</span>
        <textarea rows={4} value={meta} onChange={(e) => setMeta(e.target.value)} placeholder={'{\n  "theme": "dark"\n}'} />
        <em className="hint">Stored as-is and handed to your login/consent pages. The issuer never reads it.</em>
      </label>
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : client ? 'Save changes' : 'Register'}
        </button>
        <button className="btn" onClick={onCancel}>Cancel</button>
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
