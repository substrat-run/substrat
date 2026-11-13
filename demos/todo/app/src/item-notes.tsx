/**
 * Notes on items, from the Notes plugin: a count on each item and a panel to read and add them.
 *
 * The notes are Notes' data, in Notes' own database, and this app never stores one. It asks the
 * plugin's API for them, and the plugin asks Todo, by its own peer call, whether the person may
 * see the list before it answers: a note on an item follows the item's sharing. Signed in here is
 * signed in there, since both run under one origin through the dev proxy (`vite.config.ts`).
 *
 * Shown only when the plugin runs beside this app (`VITE_NOTES_URL`). When the plugin will not
 * show this person their notes, one line above the items says why and the counts stay away.
 */
import { useCallback, useEffect, useState } from 'react';
import { NOTES_URL } from './plugins.js';

const BASE = '/plugins/notes/api';

export interface ItemNote {
  id: string;
  item_id: string;
  author_id: string;
  text: string;
  created_at: string;
}

type Notes = { phase: 'off' } | { phase: 'loading' } | { phase: 'refused'; why: string } | { phase: 'on'; byItem: Map<string, ItemNote[]> };

/** Why the plugin said no, in the words it said it in: its body's `detail`, else the status. */
async function why(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: string; error?: string } | null;
  if (res.status === 403 && body?.detail?.startsWith('permission denied')) {
    return 'you have not been given plugin access. An admin gives it under Plugins.';
  }
  return body?.detail ?? body?.error ?? `it answered ${res.status}`;
}

/** The plugin's notes on one list's items, grouped by item, and a way to add one. */
export function useItemNotes(listId: string) {
  const [notes, setNotes] = useState<Notes>(NOTES_URL ? { phase: 'loading' } : { phase: 'off' });

  const load = useCallback(async () => {
    if (!NOTES_URL) return;
    try {
      const res = await fetch(`${BASE}/lists/${encodeURIComponent(listId)}/item-notes`, { credentials: 'same-origin' });
      if (!res.ok) return setNotes({ phase: 'refused', why: await why(res) });
      const { entries } = (await res.json()) as { entries: ItemNote[] };
      const byItem = new Map<string, ItemNote[]>();
      for (const n of entries) byItem.set(n.item_id, [...(byItem.get(n.item_id) ?? []), n]);
      setNotes({ phase: 'on', byItem });
    } catch {
      setNotes({ phase: 'refused', why: 'the Notes plugin is not running.' });
    }
  }, [listId]);
  useEffect(() => void load(), [load]);

  const add = async (itemId: string, text: string): Promise<string | null> => {
    const res = await fetch(`${BASE}/items/${encodeURIComponent(itemId)}/notes`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return why(res);
    await load();
    return null;
  };

  return { notes, add };
}

/** The one line above the items when the plugin will not show this person their notes. */
export function ItemNotesStatus({ notes }: { notes: Notes }) {
  if (notes.phase !== 'refused') return null;
  return <p className="sub">Notes plugin: no notes shown, because {notes.why}</p>;
}

/** An item's notes: a count that opens them, the notes, and a box to add one. */
export function ItemNotesPanel({
  itemId,
  notes,
  add,
}: {
  itemId: string;
  notes: Notes;
  add: (itemId: string, text: string) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [draft, setDraft] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  if (notes.phase !== 'on') return null;
  const mine = notes.byItem.get(itemId) ?? [];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    const failed = await add(itemId, text);
    setProblem(failed);
    if (!failed) {
      setText('');
      // A fresh input: React 18 writes `value` as an attribute, which a typed-in `wa-input` ignores.
      setDraft((n) => n + 1);
    }
  };

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
          <form className="inline" onSubmit={submit}>
            <wa-input key={draft} size="s" placeholder="A note on this item" onInput={(e) => setText((e.target as HTMLInputElement).value)} />
            <wa-button size="s" type="submit">
              Add
            </wa-button>
          </form>
          {problem ? <p className="sub">Not added: {problem}</p> : null}
          <p className="sub plugin-credit">From the Notes plugin. Seen by whoever this list is shared with and may use plugins.</p>
        </div>
      ) : null}
    </>
  );
}
