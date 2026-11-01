import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, DetailHeader, EmptyState, LinkTabs, initials } from '@substrat-run/ui';
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
import { USERS_PATH, USER_TABS, userPath, type UserTab } from '../console/routes';
import { LogTable } from './Logs';
import { RawJson } from './RawJson';
import { CopyId } from './applications/CopyId';

const TAB_LABELS: Record<UserTab, string> = {
  details: 'Details',
  identities: 'Identities',
  sessions: 'Sessions',
  logs: 'Logs',
  raw: 'Raw',
};

/**
 * `/users/:id[/<tab>]` — one person. A row in the directory used to be a dead end: an operator
 * could ban or remove somebody straight from the list and could not look at them first, so the
 * questions that actually arrive at a support desk — how do they sign in, are they signed in
 * right now, why is their address not verified — had no screen.
 *
 * Auth0's shape (spec/console-redesign.md §3): a header naming the person and holding the
 * levers that act on the whole account, over tabs that are places. The person is read ONCE —
 * the view is keyed by id at its call site and the tab is a prop, so switching tabs re-reads
 * nothing. Their sign-in methods and sessions are separate reads, owned by their tabs, and kept
 * independent on purpose: sessions failing must not blank the header an operator is reading
 * the user id out of. Each tab states its own loading, empty and error state.
 *
 * The nav is not the gate here either — every call below is refused server-side by session +
 * the `admin` role, and this component simply is not rendered for anyone else.
 */
export function UserDetailView({ userId, tab, me }: { userId: string; tab: UserTab; me: string }) {
  const [user, setUser] = useState<AdminUser | null | 'missing'>(null);
  const [err, setErr] = useState<string | null>(null);
  // Bumped by anything that changes this person, and read by the tabs that do not own the
  // change. Setting a password creates the credential account the Identities tab is listing,
  // so that tab has to hear about an edit made on Details.
  const [changed, setChanged] = useState(0);
  // Held here, not on Details, because the Ban… button that opens it is in the header and the
  // header is on every tab.
  const [banning, setBanning] = useState(false);

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
          <button className="btn primary" style={{ width: 'auto' }} onClick={() => navigate(USERS_PATH)}>
            Back to Users
          </button>
        }
      />
    );
  }

  return (
    <>
      {err && <p className="error">{err}</p>}
      {/* A failed read is an error state, not a pending one. Saying "Loading…" underneath the
          error would tell an operator to keep waiting for a request that already came back. */}
      {user === null ? (
        !err && <p className="muted">Loading this user…</p>
      ) : (
        <>
          <UserHeader
            user={user}
            me={me}
            onChanged={onChanged}
            onBan={() => {
              setBanning(true);
              navigate(userPath(userId));
            }}
          />
          <LinkTabs
            label="User"
            value={tab}
            onNavigate={navigate}
            tabs={USER_TABS.map((t) => ({ value: t, label: TAB_LABELS[t], href: userPath(userId, t) }))}
          />
          {/* Details stays mounted while another tab is shown, so a half-typed password or ban
              reason is still there on the way back rather than silently dropped. */}
          <div hidden={tab !== 'details'} style={{ display: tab === 'details' ? 'flex' : undefined, flexDirection: 'column', gap: 20 }}>
            <DetailsTab user={user} me={me} onChanged={onChanged} banning={banning} setBanning={setBanning} />
          </div>
          {tab === 'identities' && <SignInMethodsPanel userId={userId} email={user.email} reloadKey={changed} onChanged={onChanged} />}
          {tab === 'sessions' && <SessionsPanel userId={userId} />}
          {tab === 'logs' && <LogTable userId={userId} />}
          {tab === 'raw' && <RawJson value={user} />}
        </>
      )}
    </>
  );
}

/* ---- who they are, and the levers that act on the whole account ---- */

function UserHeader({ user, me, onChanged, onBan }: { user: AdminUser; me: string; onChanged: () => void; onBan: () => void }) {
  const isMe = user.id === me;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
    <>
      <DetailHeader
        icon={<span style={{ fontSize: 14, fontWeight: 600 }}>{initials(user.name || user.email)}</span>}
        title={
          <>
            {user.name || '(no name)'} {isMe && <span className="tag">you</span>}
          </>
        }
        meta={
          <>
            <span>{user.email}</span>
            {user.emailVerified ? <Badge status="success">verified</Badge> : <Badge status="warning">unverified</Badge>}
            <span>{user.role ?? 'user'}</span>
            {user.banned && <Badge status="danger">banned</Badge>}
            {/* Copyable because it is the `sub` every relying party stored against this person.
                Matching a complaint in a customer's app to a row here starts with this string. */}
            <CopyId value={user.id} label="user id" />
          </>
        }
        actions={
          <>
            {/* Every destructive lever is disabled on your own row rather than hidden. Hiding it
                would read as "this cannot be done here"; the truth is that it cannot be done to
                yourself, and the server refuses it either way. */}
            {user.role === 'admin' ? (
              <Button variant="secondary" disabled={busy || isMe} onClick={() => void act(() => setRole(user.id, 'user'))}>
                Demote to user
              </Button>
            ) : (
              <Button variant="secondary" disabled={busy} onClick={() => void act(() => setRole(user.id, 'admin'))}>
                Make administrator
              </Button>
            )}
            {user.banned ? (
              <Button variant="secondary" disabled={busy} onClick={() => void act(() => unbanUser(user.id))}>
                Lift the ban
              </Button>
            ) : (
              <Button variant="secondary" disabled={busy || isMe} onClick={onBan}>
                Ban…
              </Button>
            )}
            <Button
              variant="danger"
              disabled={busy || isMe}
              onClick={() => {
                if (!window.confirm(`Remove ${user.email}? Their account, sessions and sign-in methods go with them, and every relying party holding their user id keeps a reference to nobody. This cannot be undone.`)) return;
                void act(async () => {
                  await removeUser(user.id);
                  navigate(USERS_PATH);
                });
              }}
            >
              Remove
            </Button>
          </>
        }
      />
      {isMe && <p className="muted" style={{ margin: 0 }}>This is your own account, so the levers above are not yours to pull on it.</p>}
      {err && <p className="error">{err}</p>}
    </>
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
 * The accessible name of one Remove button, which needs more than the method's name: somebody
 * CAN hold two accounts at the same provider, and telling those apart is the whole reason the
 * table has an "Account at the provider" column. Two buttons both announcing "Remove their
 * google" would drop exactly the distinction the screen exists to draw.
 */
const removeLabel = (m: AdminSignInMethod): string =>
  m.provider === 'credential'
    ? `Remove their ${methodLabel(m)}`
    : `Remove their ${methodLabel(m)} account ${m.accountId}`;

/**
 * What an operator is agreeing to, written from their side and naming the consequence rather
 * than the verb. Removing a password and disconnecting an upstream are different acts with
 * different aftermaths, so they get different sentences.
 *
 * Both say that sessions survive. It is the fact most likely to be assumed the other way —
 * "I removed their Google account" reads like a sign-out and is not one — and the panel that
 * does end a session is the Sessions tab beside this one.
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

  // `reloadKey` is why this panel is not read-only in effect: setting a password under Details
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

  // The same question the server asks, over the same fact: does removing THIS row take away
  // their last way in. Counting rows would answer differently — a `credential` row with no
  // password is listed here and is not a way in — so the screen would disable a button the
  // server would have allowed, and enable one it will refuse. `usable` is on the wire so that
  // both ends read one predicate. The server's refusal is still the one that counts; this only
  // keeps an operator from meeting it as an error banner.
  const removable = (m: AdminSignInMethod): boolean =>
    !m.usable || (methods ?? []).some((other) => other.id !== m.id && other.usable);

  const remove = async (m: AdminSignInMethod) => {
    if (!window.confirm(removalWarning(m, email))) return;
    setRemoving(m.id);
    setErr(null);
    try {
      await adminRemoveSignInMethod(userId, m.id);
      // Through the parent, not a local re-read: removing the password changes what the
      // Details tab's "Set a password" field means, and the header is the other half of the
      // same person.
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
           the fix is a password an administrator sets on the Details tab. */
        <p className="muted">
          No way to sign in. This account has neither a password nor a connected provider — set
          a password under Details to give them one.
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
                  <td>
                    {m.provider === 'credential' ? 'Password' : m.provider}{' '}
                    {/* A row that is listed and is not a way in — today only a `credential` row
                        whose password was cleared. Saying so is what makes the Remove button
                        beside it make sense: it is enabled because there is nothing to lose. */}
                    {!m.usable && <span className="tag warn">no password set</span>}
                  </td>
                  {/* For a password row this is the person's own id, not an upstream subject —
                      saying nothing is more honest than repeating it as though it meant more. */}
                  <td>{m.provider === 'credential' ? '—' : <code>{m.accountId}</code>}</td>
                  <td>{m.createdAt ? new Date(m.createdAt).toLocaleDateString() : '—'}</td>
                  <td className="actions">
                    {/* Disabled rather than hidden, for the reason the header gives about your own
                        account: a missing button reads as "not possible here", and the true
                        answer is "not while it is the only way in". */}
                    <button
                      className="btn tiny"
                      disabled={removing !== null || !removable(m)}
                      onClick={() => void remove(m)}
                      aria-label={removeLabel(m)}
                    >
                      {removing === m.id ? 'Removing…' : 'Remove'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {methods.some((m) => !removable(m)) && (
            <p className="muted note">
              Their only way to sign in cannot be removed. Set a password under Details, or have
              them connect a provider, and it becomes removable — to close the account entirely,
              use Remove at the top of this screen.
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

/* ---- Details: who they are, and what an operator can change about them ---- */

function DetailsTab({
  user, me, onChanged, banning, setBanning,
}: {
  user: AdminUser;
  me: string;
  onChanged: () => void;
  banning: boolean;
  setBanning: (on: boolean) => void;
}) {
  const isMe = user.id === me;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
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
    <>
      {err && <p className="error">{err}</p>}
      {banning && !user.banned && !isMe && (
        <section className="panel">
          <div className="panel-head"><h2>Ban this user</h2></div>
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
        </section>
      )}

      <section className="panel">
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
        </dl>
        {!user.emailVerified && (
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => void act(() => markEmailVerified(user.id))}>
              Mark address verified
            </button>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Password</h2></div>
        <div className="editor">
          <Field
            label="Set a password"
            value={password}
            onChange={setPassword}
            type="password"
            hint="Replaces any password they have. Existing sessions survive it — revoke them under Sessions if that is the point."
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
    </>
  );
}
