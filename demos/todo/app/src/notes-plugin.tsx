/**
 * The Notes plugin, inside this app: notes on each item, and a workspace notepad on its own page.
 *
 * Notes is another app of the workspace, with its own data, and no screens of its own: what a
 * person sees of it is drawn here. Its data never lands in Todo. This app asks the plugin's API
 * for it, from the same origin through the dev proxy (`vite.config.ts`), so the person's session
 * goes with every request and the plugin decides who they are by asking Todo.
 *
 * It appears for exactly the people the plugin lets in. An admin switches a member on under
 * Plugins, and the next time the plugin asks Todo about them (within five minutes, thirty seconds
 * on the dev server) its features turn up here. Someone not switched on, or a workspace where the
 * plugin does not run, sees Todo as it is without it: no notes, and no word about them.
 */
import { useCallback, useEffect, useState } from 'react';
import { useAutoRefresh } from '@substrat-run/ui';

const BASE = '/plugins/notes/api';

export interface Note {
  id: string;
  author_id: string;
  text: string;
  created_at: string;
}

export interface ItemNote extends Note {
  item_id: string;
}

/**
 * Whether the plugin lets this person in, asked by reading one note. Re-asked on focus and on
 * the slow poll, so switching someone on shows up without a reload. Any failure, a plugin that
 * is not running included, is "off": nothing of it is drawn.
 */
export function useNotesPlugin(): boolean {
  const [on, setOn] = useState(false);
  const probe = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/notes?limit=1`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      setOn(res.ok);
    } catch {
      setOn(false);
    }
  }, []);
  useEffect(() => void probe(), [probe]);
  useAutoRefresh(probe);
  return on;
}

/** Why the plugin refused a write, in its own words, else the status. */
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; error?: string } | null;
  return body?.detail ?? body?.error ?? `it answered ${res.status}`;
}

async function send(path: string, text: string): Promise<string | null> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return res.ok ? null : refusal(res);
}

/** A box that adds a note and starts empty again: a fresh input each time (React 18 and `wa-input`). */
function AddNote({ placeholder, add }: { placeholder: string; add: (text: string) => Promise<string | null> }) {
  const [text, setText] = useState('');
  const [draft, setDraft] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const failed = await add(text);
    setProblem(failed);
    if (!failed) {
      setText('');
      setDraft((n) => n + 1);
    }
  };
  return (
    <>
      <form className="inline" onSubmit={submit}>
        <wa-input key={draft} size="s" placeholder={placeholder} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
        <wa-button size="s" type="submit">
          Add
        </wa-button>
      </form>
      {problem ? <p className="sub">Not added: {problem}</p> : null}
    </>
  );
}

/** One list's item notes, grouped by item. `null` until read, and when the plugin will not say. */
export function useItemNotes(listId: string, on: boolean) {
  const [byItem, setByItem] = useState<Map<string, ItemNote[]> | null>(null);
  const load = useCallback(async () => {
    if (!on) return setByItem(null);
    try {
      const res = await fetch(`${BASE}/lists/${encodeURIComponent(listId)}/item-notes`, { credentials: 'same-origin' });
      if (!res.ok) return setByItem(null);
      const { entries } = (await res.json()) as { entries: ItemNote[] };
      const grouped = new Map<string, ItemNote[]>();
      for (const n of entries) grouped.set(n.item_id, [...(grouped.get(n.item_id) ?? []), n]);
      setByItem(grouped);
    } catch {
      setByItem(null);
    }
  }, [listId, on]);
  useEffect(() => void load(), [load]);

  const add = async (itemId: string, text: string) => {
    const failed = await send(`/items/${encodeURIComponent(itemId)}/notes`, text);
    if (!failed) await load();
    return failed;
  };
  return { byItem, add };
}

/** An item's notes: a count that opens them, the notes, and a box to add one. */
export function ItemNotesPanel({
  itemId,
  notes,
}: {
  itemId: string;
  notes: ReturnType<typeof useItemNotes>;
}) {
  const [open, setOpen] = useState(false);
  if (notes.byItem === null) return null;
  const mine = notes.byItem.get(itemId) ?? [];
  return (
    <>
      <wa-button size="s" appearance="plain" onClick={() => setOpen(!open)}>
        {mine.length === 0 ? 'Add note' : `Notes (${mine.length})`}
      </wa-button>
      {open ? (
        <div className="item-notes">
          {mine.map((n) => (
            <div className="item-note" key={n.id}>
              {n.text}
              <span className="muted">{new Date(n.created_at).toLocaleString()}</span>
            </div>
          ))}
          <AddNote placeholder="A note on this item" add={(text) => notes.add(itemId, text)} />
          <p className="sub plugin-credit">From the Notes plugin. Seen by whoever this list is shared with and may use plugins.</p>
        </div>
      ) : null}
    </>
  );
}

/** The workspace notepad: every note not on an item, for everyone the plugin lets in. */
export function NotesPage({ me }: { me: string }) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/notes?order=desc`, { credentials: 'same-origin' });
      if (!res.ok) return setError(await refusal(res));
      setNotes((await res.json()) as Note[]);
      setError(null);
    } catch {
      setError('the Notes plugin is not running');
    }
  }, []);
  useEffect(() => void load(), [load]);

  return (
    <section>
      <h2>Notes</h2>
      <p className="sub">A notepad for everyone in the workspace who may use plugins. From the Notes plugin.</p>
      {error ? (
        <wa-callout class="error" variant="warning" size="s">
          <strong>Notes is not available to you. </strong>
          {error}
        </wa-callout>
      ) : null}
      {notes ? (
        <>
          <div className="card">
            {notes.length === 0 ? <div className="empty">No notes yet.</div> : null}
            {notes.map((n) => (
              <div className="row" key={n.id}>
                <span>
                  {n.text}
                  <span className="muted">
                    {n.author_id === me ? 'you' : 'a colleague'} · {new Date(n.created_at).toLocaleString()}
                  </span>
                </span>
              </div>
            ))}
          </div>
          <AddNote
            placeholder="Write a note"
            add={async (text) => {
              const failed = await send('/notes', text);
              if (!failed) await load();
              return failed;
            }}
          />
        </>
      ) : null}
    </section>
  );
}
