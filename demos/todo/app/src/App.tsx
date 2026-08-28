/**
 * Three screens, one per line of spec/concept.md §8: your lists, a list, and who
 * it is shared with. Hash routing, so a refresh keeps the screen.
 *
 * Switching user is a real sign-in at the issuer, not a header swap, and it is how
 * the permission model becomes visible: the same screen, a different answer, and no
 * filtering anywhere in this file. The picker itself lives at the issuer — this app
 * has no list of who exists, exactly as a deployed one would not.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAutoRefresh } from '@substrat-run/ui';
import { api, ApiError, auth, me, type Item, type List, type Paged, type Session, type Share } from './api.js';

/** The wall, as opposed to a blip: the server said no, not "try again". */
const denied = (error: unknown) => error instanceof ApiError && error.status === 403;

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function Problem({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="error">
      <strong>{denied(error) ? 'Not allowed. ' : 'Something went wrong. '}</strong>
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

export function App() {
  const hash = useHash();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const match = /^#\/list\/(.+)$/.exec(hash);

  useEffect(() => {
    void me().then(setSession);
  }, []);

  if (session === undefined) return <main><p>Loading…</p></main>;
  if (session === null) {
    return (
      <>
        <header>
          <h1>Todo</h1>
          <span className="tag">on Substrat</span>
        </header>
        <main>
          <p>Sign in to see your lists.</p>
          <button onClick={() => auth.login('/')}>Sign in</button>
        </main>
      </>
    );
  }

  const who = session.principal;
  return (
    <>
      <header>
        <h1>Todo</h1>
        <span className="tag">on Substrat</span>
        <span className="who">
          Signed in as <strong>{session.display}</strong>
          <button onClick={() => auth.switchUser()}>Switch user</button>
          <button onClick={() => auth.logout()}>Sign out</button>
        </span>
      </header>
      <main>{match ? <ListView key={`${who}:${match[1]}`} listId={match[1]!} /> : <Lists key={who} />}</main>
    </>
  );
}

function Lists() {
  const [lists, setLists] = useState<List[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState('');

  const load = useCallback(async () => {
    try {
      setLists((await api.myLists()).entries);
      setError(null);
    } catch (e) {
      setError(e);
      if (denied(e)) setLists(null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // The screen outlives the grant: a list shared with you and then un-shared stays
  // on this screen until something re-asks. Focus, visibility and a slow poll do.
  useAutoRefresh(load);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.createList({ name: name.trim() });
      setName('');
      load();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <>
      <h2>Your lists</h2>
      <p className="sub">
        The ones you own, and the ones someone shared with you. A list nobody shared is not
        filtered out here — it never comes back from the server at all.
      </p>
      <Problem error={error} />
      {lists === null ? (
        !error && <p className="empty">Loading…</p>
      ) : lists.length === 0 ? (
        <div className="card">
          <p className="empty">Nothing yet. Create a list, or ask someone to share one with you.</p>
        </div>
      ) : (
        lists.map((l) => (
          <div className="card" key={l.id}>
            <div className="row">
              <a href={`#/list/${l.id}`}>{l.name}</a>
              <span className="spacer" />
              <SharedTag list={l} />
            </div>
          </div>
        ))
      )}
      <form className="inline" onSubmit={create}>
        <input
          type="text"
          value={name}
          placeholder="New list…"
          onChange={(e) => setName(e.target.value)}
        />
        <button className="primary" disabled={!name.trim()}>
          Create
        </button>
      </form>
    </>
  );
}

/** Owned or shared — read off the list's own owner, never a second request. */
function SharedTag({ list }: { list: List }) {
  const [mine, setMine] = useState<boolean | null>(null);
  useEffect(() => {
    // Only the owner may read a list's shares, so this doubles as the answer.
    api
      .listShares({ listId: list.id })
      .then(() => setMine(true))
      .catch(() => setMine(false));
  }, [list.id]);
  if (mine === null) return null;
  return mine ? <span className="tag">yours</span> : <span className="tag shared">shared with you</span>;
}

function ListView({ listId }: { listId: string }) {
  // A PAGE, not an array. `todo/list-items` declares `paged`, so what comes back is
  // the first twenty items plus a link to the next twenty — and an app that kept a
  // bare array would render those twenty as though they were the list.
  const [page, setPage] = useState<Paged<Item> | null>(null);
  const [shares, setShares] = useState<Share[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [text, setText] = useState('');
  const [email, setEmail] = useState('');

  // How far down the walk this screen has gone, so a revalidation refetches the
  // same depth instead of snapping back to the first page under someone's cursor.
  const depth = useRef(1);

  const load = useCallback(async () => {
    try {
      let fresh = await api.listItems({ listId });
      for (let n = 1; n < depth.current && fresh.next; n++) {
        const rest = await api.follow<Item>(fresh.next);
        fresh = { entries: [...fresh.entries, ...rest.entries], next: rest.next, total: rest.total };
      }
      setPage(fresh);
      setError(null);
    } catch (e) {
      setError(e);
      // Revalidate-and-deny: a refetch that comes back 403 is a share revoked while
      // this screen was open. What the server just refused leaves with the refusal,
      // so the wall replaces the list instead of sitting above data you may no
      // longer see. Nothing leaked — every action would have failed — but you were
      // looking at it, and for a permission-centric app that is the whole failure.
      if (denied(e)) {
        setPage(null);
        setShares(null);
      }
      return;
    }
    // Owner-only. A 403 here is the honest answer for someone the list was
    // shared with, so it is not surfaced as an error.
    try {
      setShares((await api.listShares({ listId })).entries);
    } catch {
      setShares(null);
    }
  }, [listId]);
  useEffect(() => {
    void load();
  }, [load]);
  // The re-ask. This screen has no nav item to re-click (the sidebar case lives in
  // demos/shop/app); focus, visibility and the slow poll are what catch a revoke.
  useAutoRefresh(load);

  const guard = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(e);
    }
  };

  /**
   * Follow the walk. `next` is a URL the server handed over, filters and page size
   * already on it, so there is no cursor to reassemble here — which is the whole
   * point of RFC 8288 over a bare cursor field.
   */
  const more = async () => {
    if (!page?.next) return;
    setError(null);
    try {
      const rest = await api.follow<Item>(page.next);
      setPage({ entries: [...page.entries, ...rest.entries], next: rest.next, total: rest.total });
      depth.current += 1;
    } catch (e) {
      setError(e);
    }
  };

  return (
    <>
      <a className="back" href="#/">
        ← all lists
      </a>
      <h2 style={{ marginTop: '.6rem' }}>
        Items
        {/* `paged: { total: true }` is the reason this number exists — it costs a second
            query per request, so it is asked for rather than assumed, and a screen that
            never renders it should stop asking. */}
        {page !== null && page.total !== null && (
          <span className="tag">
            {page.entries.length} of {page.total}
          </span>
        )}
      </h2>
      <p className="sub">Tick things off, add your own. Both are things a share lets you do.</p>
      <Problem error={error} />

      {page === null ? (
        !error && <p className="empty">Loading…</p>
      ) : page.entries.length === 0 ? (
        <div className="card">
          <p className="empty">Nothing on this list yet.</p>
        </div>
      ) : (
        page.entries.map((i) => (
          <div className="card" key={i.id}>
            <div className="row">
              <input
                type="checkbox"
                checked={i.done === 1}
                onChange={() => guard(() => api.setItemDone({ itemId: i.id, done: i.done !== 1 }))}
              />
              <span className={i.done === 1 ? 'done' : undefined}>{i.text}</span>
              <span className="spacer" />
              <button className="link" onClick={() => guard(() => api.deleteItem({ itemId: i.id }))}>
                delete
              </button>
            </div>
          </div>
        ))
      )}

      {/* Absent `next` is how the walk ends, so this button disappears rather than
          going grey — there is no page to be disabled about. */}
      {page?.next && (
        <button className="link" onClick={() => void more()}>
          Load more
        </button>
      )}

      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          void guard(() => api.addItem({ listId, text: text.trim() })).then(() => setText(''));
        }}
      >
        <input
          type="text"
          value={text}
          placeholder="Add an item…"
          onChange={(e) => setText(e.target.value)}
        />
        <button className="primary" disabled={!text.trim()}>
          Add
        </button>
      </form>

      {shares !== null && (
        <section className="share">
          <h3>Shared with</h3>
          {shares.length === 0 ? (
            <div className="card">
              <p className="empty">Nobody yet — this list is private.</p>
            </div>
          ) : (
            shares.map((s) => (
              <div className="card" key={s.id}>
                <div className="row">
                  <span>{s.email}</span>
                  <span className="spacer" />
                  <button className="link" onClick={() => guard(() => api.revokeShare({ shareId: s.id }))}>
                    revoke
                  </button>
                </div>
              </div>
            ))
          )}
          <form
            className="inline"
            onSubmit={(e) => {
              e.preventDefault();
              void guard(() => api.shareList({ listId, email: email.trim() })).then(() => setEmail(''));
            }}
          >
            <input
              type="email"
              value={email}
              placeholder="bjorn@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
            <button disabled={!email.trim()}>Share</button>
          </form>
        </section>
      )}
    </>
  );
}
