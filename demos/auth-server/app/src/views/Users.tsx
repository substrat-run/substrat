import { useCallback, useEffect, useState } from 'react';
import {
  banUser,
  createUser,
  listUsers,
  removeUser,
  setRole,
  unbanUser,
  type AdminUser,
} from '../api';
import { Field } from '../primitives';

/**
 * The directory, at `/users`. It owns its own read, which the one-page dashboard could not:
 * the list was loaded by the shell and handed down, so an error reading it printed above
 * every other panel as though the whole console had failed.
 *
 * Three states, and they are different questions. `null` is "the read has not answered"
 * (`UserTable` says so). An empty array is a real answer and cannot happen here — an issuer
 * with no users shows the bootstrap screen instead, so there is deliberately no empty state
 * to write. An error leaves whatever the last successful read returned on screen and says
 * what happened above it.
 */
export function UsersView({ me }: { me: string }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setUsers(await listUsers());
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Users</h2>
        <NewUser onCreated={reload} />
      </div>
      {err && <p className="error">{err}</p>}
      <UserTable users={users} me={me} onChanged={reload} />
    </section>
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
