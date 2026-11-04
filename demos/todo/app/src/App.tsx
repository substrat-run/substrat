/**
 * Three screens, one per line of spec/concept.md §8: your lists, a list, and who
 * it is shared with. Hash routing, so a refresh keeps the screen.
 *
 * Your lists come in three views (#119): the active ones, the archive and the trash,
 * each its own read on the server — `my-lists`, `my-lists?view=archived` and
 * `trashed-lists`. Archive is "done with it, keep it"; trash is the delete you can
 * take back. The moves are the server's: a list you may not archive or bin is
 * refused there, and the refusal is shown, not predicted.
 *
 * Switching user is a real sign-in at the issuer, not a header swap, and it is how
 * the permission model becomes visible: the same screen, a different answer, and no
 * filtering anywhere in this file. The picker itself lives at the issuer — this app
 * has no list of who exists, exactly as a deployed one would not.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAutoRefresh } from '@substrat-run/ui';
import { api, ApiError, auth, me, type Item, type List, type Paged, type Session, type Share } from './api.js';
import { ListsTable } from './elements.js';
import { Settings } from './settings.js';

/** The wall, as opposed to a blip: the server said no, not "try again". */
const denied = (error: unknown) => error instanceof ApiError && error.status === 403;

/** The current value of a `wa-input` (or any control) an input event came from. */
const valueOf = (e: { target: EventTarget | null }) => (e.target as HTMLInputElement).value;

/** A move against a list that is no longer where this screen shows it (#119). */
const stale = (error: unknown) => error instanceof ApiError && (error.status === 409 || error.status === 404);

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
    <wa-callout class="error" variant={denied(error) ? 'warning' : 'danger'} size="s">
      <strong>{denied(error) ? 'Not allowed. ' : 'Something went wrong. '}</strong>
      {error instanceof Error ? error.message : String(error)}
    </wa-callout>
  );
}

/** Which of your lists a screen shows: `#/`, `#/archived` or `#/trash`. */
export type ListsShown = 'active' | 'archived' | 'trash';

const VIEW_HASH: Record<ListsShown, string> = { active: '#/', archived: '#/archived', trash: '#/trash' };

/** The same active lists, drawn by the `@substrat-run/elements` prototype. */
const TABLE_HASH = '#/table';

/** Theme and light/dark, from the account menu. */
const SETTINGS_HASH = '#/settings';

function shownOf(hash: string): ListsShown {
  return hash === VIEW_HASH.archived ? 'archived' : hash === VIEW_HASH.trash ? 'trash' : 'active';
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
          <wa-tag size="s" appearance="outlined">
            on Substrat
          </wa-tag>
        </header>
        <main>
          <p>Sign in to see your lists.</p>
          <wa-button variant="brand" onClick={() => auth.login('/')}>
            Sign in
          </wa-button>
        </main>
      </>
    );
  }

  const who = session.principal;
  return (
    <>
      <header>
        <h1>Todo</h1>
        <wa-tag size="s" appearance="outlined">
            on Substrat
          </wa-tag>
        <span className="who">
          <wa-dropdown>
            <wa-button slot="trigger" size="s" appearance="outlined" with-caret>
              {session.display}
            </wa-button>
            <wa-dropdown-item onClick={() => auth.switchUser()}>Switch user</wa-dropdown-item>
            <wa-dropdown-item onClick={() => (window.location.hash = SETTINGS_HASH)}>Settings</wa-dropdown-item>
            <wa-dropdown-item onClick={() => auth.logout()}>Sign out</wa-dropdown-item>
          </wa-dropdown>
        </span>
      </header>
      <main>
        {match ? (
          <ListView key={`${who}:${match[1]}`} listId={match[1]!} />
        ) : hash === SETTINGS_HASH ? (
          <Settings />
        ) : hash === TABLE_HASH ? (
          <>
            <ViewsNav current="table" />
            <ListsTable key={who} />
          </>
        ) : (
          <Lists key={`${who}:${shownOf(hash)}`} shown={shownOf(hash)} />
        )}
      </main>
    </>
  );
}

/** What each view says about itself, above its rows. */
const VIEW_COPY: Record<ListsShown, { tab: string; title: string; sub: string; empty: string }> = {
  active: {
    tab: 'Active',
    title: 'Your lists',
    sub: 'The ones you own, and the ones someone shared with you. A list nobody shared is not filtered out here — it never comes back from the server at all.',
    empty: 'Nothing yet. Create a list, or ask someone to share one with you.',
  },
  archived: {
    tab: 'Archived',
    title: 'Archived',
    sub: 'Lists filed away. Still yours, still shared, just out of the way.',
    empty: 'Nothing archived.',
  },
  trash: {
    tab: 'Trash',
    title: 'Trash',
    sub: 'Lists you binned. Restore one and it comes back as it was, items and shares included; after 30 days it is deleted for good.',
    empty: 'The trash is empty.',
  },
};

function ViewsNav({ current }: { current: ListsShown | 'table' }) {
  return (
    <nav className="views">
      {(Object.keys(VIEW_HASH) as ListsShown[]).map((v) => (
        <a key={v} href={VIEW_HASH[v]} aria-current={v === current ? 'page' : undefined}>
          {VIEW_COPY[v].tab}
        </a>
      ))}
      <a href={TABLE_HASH} aria-current={current === 'table' ? 'page' : undefined}>
        Table
      </a>
    </nav>
  );
}

/** Each view is its own read: the server decides what is in it. */
function readOf(shown: ListsShown): () => Promise<Paged<List>> {
  if (shown === 'trash') return () => api.trashedLists();
  return () => api.myLists(shown === 'archived' ? { view: 'archived' } : {});
}

export function Lists({ shown = 'active' }: { shown?: ListsShown }) {
  const [lists, setLists] = useState<List[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState('');
  const copy = VIEW_COPY[shown];

  const load = useCallback(async () => {
    try {
      setLists((await readOf(shown)()).entries);
      setError(null);
    } catch (e) {
      setError(e);
      if (denied(e)) setLists(null);
    }
  }, [shown]);
  useEffect(() => {
    void load();
  }, [load]);
  // The screen outlives the grant: a list shared with you and then un-shared stays
  // on this screen until something re-asks. Focus, visibility and a slow poll do.
  useAutoRefresh(load);

  // A refused move is a 403 about THAT list, not a wall over the screen: the rows stay.
  // A 409 or 404 is this view gone stale — another tab moved or binned the list — so the
  // view is read again and the stale row goes; the message is set after, since a good
  // read clears it.
  const move = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      void load();
    } catch (e) {
      if (stale(e)) await load();
      setError(e);
    }
  };

  const create = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    setError(null);
    try {
      await api.createList({ name: name.trim() });
      setName('');
      form.reset();
      load();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <>
      <ViewsNav current={shown} />
      <h2>{copy.title}</h2>
      <p className="sub">{copy.sub}</p>
      <Problem error={error} />
      {lists === null ? (
        !error && <p className="empty">Loading…</p>
      ) : lists.length === 0 ? (
        <div className="card">
          <p className="empty">{copy.empty}</p>
        </div>
      ) : (
        lists.map((l) => (
          <div className="card" key={l.id}>
            <div className="row">
              {/* A binned list answers not_found to everything but restore, so it is not a link. */}
              {shown === 'trash' ? <span>{l.name}</span> : <a href={`#/list/${l.id}`}>{l.name}</a>}
              <span className="spacer" />
              {shown !== 'trash' && <SharedTag list={l} />}
              {shown === 'active' && (
                <wa-button size="s" appearance="plain" onClick={() => move(() => api.archiveList({ listId: l.id }))}>
                  archive
                </wa-button>
              )}
              {shown === 'archived' && (
                <wa-button size="s" appearance="plain" onClick={() => move(() => api.unarchiveList({ listId: l.id }))}>
                  unarchive
                </wa-button>
              )}
              {shown === 'trash' ? (
                <>
                  <wa-button size="s" appearance="plain" onClick={() => move(() => api.restoreList({ listId: l.id }))}>
                    restore
                  </wa-button>
                  <wa-button size="s" appearance="plain" variant="danger" onClick={() => move(() => api.deleteList({ listId: l.id }))}>
                    delete for good
                  </wa-button>
                </>
              ) : (
                <wa-button size="s" appearance="plain" variant="danger" onClick={() => move(() => api.trashList({ listId: l.id }))}>
                  trash
                </wa-button>
              )}
            </div>
          </div>
        ))
      )}
      {shown === 'active' && (
        <form className="inline" onSubmit={create}>
          <wa-input name="name" placeholder="New list…" label="New list" class="wa-visually-hidden-label" onInput={(e) => setName(valueOf(e))} />
          <wa-button type="submit" variant="brand" disabled={!name.trim() || undefined}>
            Create
          </wa-button>
        </form>
      )}
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
  return mine ? (
    <wa-tag size="s" variant="neutral">
      yours
    </wa-tag>
  ) : (
    <wa-tag size="s" variant="brand">
      shared with you
    </wa-tag>
  );
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

  // Revalidate-and-deny: a read of this list that comes back 403 is a share revoked
  // while this screen was open. What the server just refused leaves with the
  // refusal, so the wall replaces the list instead of sitting above data you may no
  // longer see. Nothing leaked — every action would have failed — but you were
  // looking at it, and for a permission-centric app that is the whole failure.
  // Every read of the list goes through here: the refetch and the walk alike. A
  // refused *mutation* does not — `delete` needs `list:manage`, which a reader never
  // had, so that 403 is the honest answer and not a revoke.
  const refused = useCallback((e: unknown) => {
    setError(e);
    if (denied(e)) {
      setPage(null);
      setShares(null);
    }
  }, []);

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
      refused(e);
      return;
    }
    // Owner-only. A 403 here is the honest answer for someone the list was
    // shared with, so it is not surfaced as an error.
    try {
      setShares((await api.listShares({ listId })).entries);
    } catch {
      setShares(null);
    }
  }, [listId, refused]);
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
      refused(e);
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
          <wa-tag size="s" variant="neutral">
            {page.entries.length} of {page.total}
          </wa-tag>
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
              <wa-checkbox
                checked={i.done === 1 || undefined}
                onInput={() => guard(() => api.setItemDone({ itemId: i.id, done: i.done !== 1 }))}
              >
                <span className={i.done === 1 ? 'done' : undefined}>{i.text}</span>
              </wa-checkbox>
              <span className="spacer" />
              <wa-button size="s" appearance="plain" variant="danger" onClick={() => guard(() => api.deleteItem({ itemId: i.id }))}>
                delete
              </wa-button>
            </div>
          </div>
        ))
      )}

      {/* Absent `next` is how the walk ends, so this button disappears rather than
          going grey — there is no page to be disabled about. */}
      {page?.next && (
        <wa-button size="s" appearance="outlined" onClick={() => void more()}>
          Load more
        </wa-button>
      )}

      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          void guard(() => api.addItem({ listId, text: text.trim() })).then(() => {
            setText('');
            form.reset();
          });
        }}
      >
        <wa-input name="text" placeholder="Add an item…" label="New item" class="wa-visually-hidden-label" onInput={(e) => setText(valueOf(e))} />
        <wa-button type="submit" variant="brand" disabled={!text.trim() || undefined}>
          Add
        </wa-button>
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
                  <wa-button size="s" appearance="plain" variant="danger" onClick={() => guard(() => api.revokeShare({ shareId: s.id }))}>
                    revoke
                  </wa-button>
                </div>
              </div>
            ))
          )}
          <form
            className="inline"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              void guard(() => api.shareList({ listId, email: email.trim() })).then(() => {
                setEmail('');
                form.reset();
              });
            }}
          >
            <wa-input
              name="email"
              type="email"
              placeholder="bjorn@example.com"
              label="Share with (email)"
              class="wa-visually-hidden-label"
              onInput={(e) => setEmail(valueOf(e))}
            />
            <wa-button type="submit" disabled={!email.trim() || undefined}>
              Share
            </wa-button>
          </form>
        </section>
      )}
    </>
  );
}
