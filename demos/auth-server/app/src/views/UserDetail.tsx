import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from '@substrat-run/ui';
import {
  adminRemoveSignInMethod,
  adminSignInMethods,
  banUserWithReason,
  getUser,
  listUserSessions,
  markEmailVerified,
  removeUser,
  revokeUserSession,
  revokeUserSessions,
  setRole,
  setUserPassword,
  unbanUser,
  type AdminSession,
  type AdminSignInMethod,
  type AdminUser,
} from '../api';
import { Field } from '../primitives';
import { navigate } from '../console/router';

/**
 * `/users/:id` — one person, which the console has never had. A row in the directory was a
 * dead end: an operator could ban or remove somebody straight from the list and could not
 * look at them first, so the questions that actually arrive at a support desk — how do they
 * sign in, are they signed in right now, why is their address not verified — had no screen.
 *
 * Three independent reads back it (the person, their sign-in methods, their sessions) and
 * they are kept independent on purpose: sessions failing must not blank the identity header
 * an operator is reading the user id out of. Each section states its own loading, empty and
 * error state, and none of them takes the others down.
 *
 * The nav is not the gate here either — every call below is refused server-side by session +
 * the `admin` role, and this component simply is not rendered for anyone else.
 */
export function UserDetailView({ userId, me }: { userId: string; me: string }) {
  const [user, setUser] = useState<AdminUser | null | 'missing'>(null);
  const [err, setErr] = useState<string | null>(null);
  // Bumped by anything that changes this person, and read by the panels that do not own the
  // change. Setting a password creates the credential account the Sign-in methods panel is
  // listing, so that panel has to hear about an edit made two sections below it.
  const [changed, setChanged] = useState(0);

  const reload = useCallback(async () => {
    try {
      const found = await getUser(userId);
      setUser(found ?? 'missing');
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [userId]);

  const onChanged = useCallback(() => {
    void reload();
    setChanged((n) => n + 1);
  }, [reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A pasted link to somebody who has since been removed. It is a real outcome of the feature
  // — the link outlives the account — so it gets an answer rather than a spinner that never
  // resolves.
  if (user === 'missing') {
    return (
      <EmptyState
        title="No such user"
        description={`Nobody here has the id ${userId}. They may have been removed since this link was shared.`}
        action={
          <button className="btn primary" style={{ width: 'auto' }} onClick={() => navigate('/users')}>
            Back to Users
          </button>
        }
      />
    );
  }

  return (
    <>
      <button className="btn link" style={{ justifySelf: 'start', padding: 0 }} onClick={() => navigate('/users')}>
        ← Users
      </button>
      {err && <p className="error">{err}</p>}
      {/* A failed read is an error state, not a pending one. Saying "Loading…" underneath the
          error would tell an operator to keep waiting for a request that already came back. */}
      {user === null ? (
        !err && <p className="muted">Loading this user…</p>
      ) : (
        <>
          <IdentityHeader user={user} me={me} onChanged={onChanged} />
          <SignInMethodsPanel userId={userId} email={user.email} reloadKey={changed} onChanged={onChanged} />
          <SessionsPanel userId={userId} />
          <ActionsPanel user={user} me={me} onChanged={onChanged} />
        </>
      )}
    </>
  );
}

/* ---- who they are ---- */

function IdentityHeader({ user, me, onChanged }: { user: AdminUser; me: string; onChanged: () => void }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          {user.name || '(no name)'} {user.id === me && <span className="tag">you</span>}
        </h2>
      </div>
      {err && <p className="error">{err}</p>}
      <dl className="kv">
        <dt>Email</dt>
        <dd>
          {user.email}{' '}
          {user.emailVerified ? (
            <span className="tag">verified</span>
          ) : (
            <span className="tag warn">unverified</span>
          )}
          {/* Not decoration, and not a `title` either: a native tooltip on a badge is
              unreachable by keyboard and by touch, and this sentence is the answer to a support
              ticket that reads "I cannot sign in with Google". It is the visible text. */}
          {!user.emailVerified && (
            <p className="muted note">
              Until this address is verified, this person cannot join an upstream provider to
              this account at sign-in.
            </p>
          )}
        </dd>
        <dt>Role</dt>
        <dd>{user.role ?? 'user'}</dd>
        <dt>Status</dt>
        <dd>{user.banned ? <span className="tag warn">banned</span> : 'active'}</dd>
        <dt>Created</dt>
        <dd>{user.createdAt ? new Date(user.createdAt).toLocaleString() : '—'}</dd>
        <dt>User id</dt>
        <dd>
          {/* Copyable because it is the `sub` every relying party stored against this person.
              Matching a complaint in a customer's app to a row here starts with this string. */}
          <code>{user.id}</code>{' '}
          <button
            className="btn tiny"
            onClick={async () => {
              // Only claim it was copied if it was. `navigator.clipboard` is absent outside a
              // secure context, and a button that says "Copied" over an empty clipboard is
              // worse than one that does nothing visible.
              try {
                await navigator.clipboard.writeText(user.id);
              } catch {
                return;
              }
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </dd>
      </dl>
      {!user.emailVerified && (
        <div className="row">
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await markEmailVerified(user.id);
                onChanged();
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Mark address verified
          </button>
        </div>
      )}
    </section>
  );
}

/* ---- how they sign in ---- */

/**
 * The method named mid-sentence — what the confirmation and the accessible label both need,
 * and the reason a `credential` row is "password" here and `Password` in the table: one is a
 * column value, the other is part of a sentence about it.
 */
const methodLabel = (m: AdminSignInMethod): string => (m.provider === 'credential' ? 'password' : m.provider);

/**
 * What an operator is agreeing to, written from their side and naming the consequence rather
 * than the verb. Removing a password and disconnecting an upstream are different acts with
 * different aftermaths, so they get different sentences.
 *
 * Both say that sessions survive. It is the fact most likely to be assumed the other way —
 * "I removed their Google account" reads like a sign-out and is not one — and the panel that
 * does end a session is directly below this one.
 */
function removalWarning(m: AdminSignInMethod, email: string): string {
  if (m.provider === 'credential') {
    return `Remove the ${methodLabel(m)} for ${email}? They will not be able to sign in with an email address and password until an administrator sets a new one. Sessions they already have stay open — revoke those under Sessions if that is the point.`;
  }
  return `Disconnect ${methodLabel(m)} from ${email}? Signing in with ${m.provider} will no longer bring them to this account, and reconnecting it is theirs to do, not yours. Sessions they already have stay open — revoke those under Sessions if that is the point.`;
}

function SignInMethodsPanel({
  userId,
  email,
  reloadKey,
  onChanged,
}: {
  userId: string;
  email: string;
  reloadKey: number;
  onChanged: () => void;
}) {
  const [methods, setMethods] = useState<AdminSignInMethod[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Which row is being removed, so its own button says so — a panel-wide spinner would leave an
  // operator who clicked one of four Remove buttons unsure which one took.
  const [removing, setRemoving] = useState<string | null>(null);

  // `reloadKey` is why this panel is not read-only in effect: setting a password under Actions
  // creates the very `credential` row listed here, and without the re-read the screen would go
  // on saying "No way to sign in" about a method it had just been used to create.
  useEffect(() => {
    let live = true;
    // Every read starts from nothing: a re-read after a failed first one has to be able to
    // clear the error, or the panel would keep an obsolete banner above a fresh table.
    setErr(null);
    setMethods(null);
    adminSignInMethods(userId)
      .then((m) => live && setMethods(m))
      .catch((e: unknown) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [userId, reloadKey]);

  // The server refuses the last one and its refusal is the one that counts; this only keeps an
  // operator from meeting that refusal as an error banner. It can be a row out of step with the
  // server — a `credential` row with no hash is listed here and is not a way in there — which is
  // why the button being enabled is never taken as permission.
  const isOnlyMethod = (methods?.length ?? 0) < 2;

  const remove = async (m: AdminSignInMethod) => {
    if (!window.confirm(removalWarning(m, email))) return;
    setRemoving(m.id);
    setErr(null);
    try {
      await adminRemoveSignInMethod(userId, m.id);
      // Through the parent, not a local re-read: removing the password changes what the
      // Actions panel's "Set a password" field means, and the identity header is the other
      // half of the same person.
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head"><h2>Sign-in methods</h2></div>
      {err && <p className="error">{err}</p>}
      {methods === null && !err && <p className="muted">Loading their sign-in methods…</p>}
      {methods?.length === 0 && (
        /* A real state, not an empty list to shrug at: this account has no way in at all, and
           the fix is a password an administrator sets below. */
        <p className="muted">
          No way to sign in. This account has neither a password nor a connected provider — set
          a password under Actions to give them one.
        </p>
      )}
      {methods && methods.length > 0 && (
        <>
          <table className="grid">
            <thead>
              <tr><th>Method</th><th>Account at the provider</th><th>Connected</th><th></th></tr>
            </thead>
            <tbody>
              {methods.map((m) => (
                <tr key={m.id}>
                  <td>{m.provider === 'credential' ? 'Password' : m.provider}</td>
                  {/* For a password row this is the person's own id, not an upstream subject —
                      saying nothing is more honest than repeating it as though it meant more. */}
                  <td>{m.provider === 'credential' ? '—' : <code>{m.accountId}</code>}</td>
                  <td>{m.createdAt ? new Date(m.createdAt).toLocaleDateString() : '—'}</td>
                  <td className="actions">
                    {/* Disabled rather than hidden, for the reason the Actions panel gives about
                        its own row: a missing button reads as "not possible here", and the true
                        answer is "not while it is the only one". */}
                    <button
                      className="btn tiny"
                      disabled={removing !== null || isOnlyMethod}
                      onClick={() => void remove(m)}
                      aria-label={`Remove their ${methodLabel(m)}`}
                    >
                      {removing === m.id ? 'Removing…' : 'Remove'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {isOnlyMethod && (
            <p className="muted note">
              This is their only way to sign in, so it cannot be removed. Set a password under
              Actions, or have them connect a provider, and it becomes removable — to close the
              account entirely, use Remove under Actions.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/* ---- where they are signed in ---- */

function SessionsPanel({ userId }: { userId: string }) {
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setSessions(await listUserSessions(userId));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Sessions</h2>
        {sessions && sessions.length > 0 && (
          <button className="btn danger" disabled={busy} onClick={() => act(() => revokeUserSessions(userId))}>
            Revoke all
          </button>
        )}
      </div>
      {err && <p className="error">{err}</p>}
      {sessions === null && !err && <p className="muted">Loading their sessions…</p>}
      {sessions?.length === 0 && <p className="muted">Not signed in anywhere.</p>}
      {sessions && sessions.length > 0 && (
        <table className="grid">
          <thead>
            <tr><th>Started</th><th>Expires</th><th>From</th><th></th></tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>{s.createdAt ? new Date(s.createdAt).toLocaleString() : '—'}</td>
                <td>{s.expiresAt ? new Date(s.expiresAt).toLocaleString() : '—'}</td>
                {/* The user agent, truncated by CSS rather than by us — an operator matching a
                    session to "the browser I was using" needs the string, not a guess at it.
                    The session TOKEN is never rendered: it is the credential itself. */}
                <td className="muted">{s.ipAddress || '—'} · {s.userAgent || 'unknown client'}</td>
                <td className="actions">
                  <button className="btn tiny" disabled={busy} onClick={() => act(() => revokeUserSession(s.token))}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/* ---- what an operator can do about them ---- */

function ActionsPanel({ user, me, onChanged }: { user: AdminUser; me: string; onChanged: () => void }) {
  const isMe = user.id === me;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [banning, setBanning] = useState(false);
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('');
  const [password, setPassword] = useState('');

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head"><h2>Actions</h2></div>
      {err && <p className="error">{err}</p>}
      {/* Every destructive lever is disabled on your own row rather than hidden. Hiding it
          would read as "this cannot be done here"; the truth is that it cannot be done to
          yourself, and the server refuses it either way. */}
      {isMe && <p className="muted">This is your own account, so the levers below are not yours to pull on it.</p>}
      <div className="row">
        {user.role === 'admin' ? (
          <button className="btn" disabled={busy || isMe} onClick={() => act(() => setRole(user.id, 'user'))}>
            Demote to user
          </button>
        ) : (
          <button className="btn" disabled={busy} onClick={() => act(() => setRole(user.id, 'admin'))}>
            Make administrator
          </button>
        )}
        {user.banned ? (
          <button className="btn" disabled={busy} onClick={() => act(() => unbanUser(user.id))}>
            Lift the ban
          </button>
        ) : (
          <button className="btn" disabled={busy || isMe} onClick={() => setBanning((v) => !v)}>
            Ban…
          </button>
        )}
        <button
          className="btn danger"
          disabled={busy || isMe}
          onClick={() => {
            if (!window.confirm(`Remove ${user.email}? Their account, sessions and sign-in methods go with them, and every relying party holding their user id keeps a reference to nobody. This cannot be undone.`)) return;
            void act(async () => {
              await removeUser(user.id);
              navigate('/users');
            });
          }}
        >
          Remove
        </button>
      </div>

      {banning && (
        <div className="editor">
          {/* A reason and an expiry, because a ban with neither is unreviewable later — and the
              reason is what the person themselves is told at sign-in. */}
          <Field label="Reason" value={reason} onChange={setReason} placeholder="Shown to them when they try to sign in" />
          <Field label="Expires in (days)" value={days} onChange={setDays} type="number" hint="Leave empty for a ban with no end date." />
          <div className="row">
            <button
              className="btn primary"
              disabled={busy || reason.trim().length === 0}
              onClick={() =>
                act(async () => {
                  await banUserWithReason(user.id, reason, days.trim() ? Number(days) : undefined);
                  setBanning(false);
                  setReason('');
                  setDays('');
                })
              }
            >
              Ban this user
            </button>
            <button className="btn" onClick={() => setBanning(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="editor">
        <Field
          label="Set a password"
          value={password}
          onChange={setPassword}
          type="password"
          hint="Replaces any password they have. Existing sessions survive it — revoke them above if that is the point."
        />
        <button
          className="btn"
          disabled={busy || password.length === 0}
          onClick={() =>
            act(async () => {
              await setUserPassword(user.id, password);
              setPassword('');
            })
          }
        >
          Set password
        </button>
      </div>
    </section>
  );
}
