/**
 * One screen: the workspace's notes, and a box to write one.
 *
 * The interesting part is what stands in front of it. This app has no list of who exists and
 * no way to invite anyone: the server asks the Todo workspace it is a plugin of who each login
 * is, and this file draws its four answers. Signed out, let in, signed in and not let in, and
 * "the workspace did not answer" are different screens, because they are different facts.
 */
import { useCallback, useEffect, useState } from 'react';
import type {} from '@substrat-run/elements/jsx';
import '@substrat-run/elements/controls';
import '@substrat-run/elements/themes/base.css';
import '@substrat-run/elements/themes/native.css';
import { api, ApiError, type Note } from './api.js';

/** Where the workspace's own app is, when the dev server says (`VITE_TODO_URL`). */
const TODO_URL: string | undefined = import.meta.env.VITE_TODO_URL;

type Who =
  | { phase: 'loading' }
  | { phase: 'signed-out' }
  /** Signed in at the issuer, and the workspace has nobody for this login. */
  | { phase: 'refused' }
  /** The kept answer expired and the workspace could not be asked. */
  | { phase: 'unavailable' }
  | { phase: 'in'; principal: string; display: string };

async function whoAmI(): Promise<Who> {
  const res = await fetch('/api/me', { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (res.status === 401) return { phase: 'signed-out' };
  if (res.status === 403) return { phase: 'refused' };
  if (!res.ok) return { phase: 'unavailable' };
  const body = (await res.json()) as { principal: string; display: string };
  return { phase: 'in', principal: body.principal, display: body.display };
}

const valueOf = (e: { target: EventTarget | null }) => (e.target as HTMLInputElement).value;

function Account({ display }: { display?: string }) {
  return (
    <span className="who">
      {display ? <span>{display}</span> : null}
      <a href="/api/auth/login?prompt=select_account">Switch user</a>
      <a href="/api/auth/logout">Sign out</a>
    </span>
  );
}

export function App() {
  const [who, setWho] = useState<Who>({ phase: 'loading' });
  useEffect(() => {
    void whoAmI().then(setWho, () => setWho({ phase: 'unavailable' }));
  }, []);

  return (
    <>
      <header>
        <h1>Notes</h1>
        <wa-tag size="s" appearance="outlined">
          a plugin of Todo
        </wa-tag>
        {TODO_URL ? <a href={TODO_URL}>Open Todo</a> : null}
        {who.phase === 'in' ? <Account display={who.display} /> : who.phase === 'refused' || who.phase === 'unavailable' ? <Account /> : null}
      </header>
      <main>
        {who.phase === 'loading' ? (
          <p>Loading…</p>
        ) : who.phase === 'signed-out' ? (
          <>
            <p>Sign in with the account you use in Todo.</p>
            <wa-button href="/api/auth/login" variant="brand">
              Sign in
            </wa-button>
          </>
        ) : who.phase === 'refused' ? (
          <wa-callout class="error" variant="warning">
            <strong>You are signed in, and not a member of this workspace. </strong>
            Notes has no members of its own: it lets in whoever Todo says is one.
          </wa-callout>
        ) : who.phase === 'unavailable' ? (
          <wa-callout class="error" variant="danger">
            <strong>Todo did not answer. </strong>
            Notes asks it who you are, and admits nobody while it cannot. Try again in a moment.
          </wa-callout>
        ) : (
          <Notes me={who.principal} />
        )}
      </main>
    </>
  );
}

function Notes({ me }: { me: string }) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [text, setText] = useState('');
  // A fresh input after each note: React 18 writes `value` as an attribute, which a `wa-input`
  // the person has typed into no longer follows, so clearing the state alone leaves the text.
  const [draft, setDraft] = useState(0);

  const load = useCallback(async () => {
    try {
      setNotes((await api.listNotes({ order: 'desc' })).entries);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    try {
      await api.addNote({ text });
      setText('');
      setDraft((n) => n + 1);
      await load();
    } catch (err) {
      setError(err);
    }
  };

  // Let in and holding nothing: a member of Todo whom nobody gave plugin access.
  const noAccess = error instanceof ApiError && error.status === 403;
  return (
    <>
      <h2>Notes</h2>
      <p className="sub">Shared by everyone in the workspace who may use its plugins. Who that is, is decided in Todo.</p>
      {noAccess ? (
        <wa-callout class="error" variant="warning">
          <strong>You are a member, and have not been given plugin access. </strong>
          An admin gives it in Todo, under Plugins. It reaches this app the next time it asks Todo, within five minutes
          at most (thirty seconds on the dev server).
        </wa-callout>
      ) : error ? (
        <wa-callout class="error" variant="danger">
          <strong>Something went wrong. </strong>
          {error instanceof Error ? error.message : String(error)}
        </wa-callout>
      ) : null}
      {notes && !noAccess ? (
        <>
          <div className="card">
            {notes.length === 0 ? <div className="empty">No notes yet.</div> : null}
            {notes.map((n) => (
              <div className="row" key={n.id}>
                {n.text}
                <div className="meta">
                  {n.author_id === me ? 'you' : n.author_id} · {new Date(n.created_at).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
          <form className="inline" onSubmit={add}>
            <wa-input key={draft} placeholder="Write a note" onInput={(e) => setText(valueOf(e))} />
            <wa-button type="submit" variant="brand">
              Add
            </wa-button>
          </form>
        </>
      ) : null}
    </>
  );
}
