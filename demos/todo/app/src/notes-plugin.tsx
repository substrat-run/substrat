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

/** A note's item, as Todo has it now: its text and whether it is done, or gone. */
type ItemState = { text: string; done: boolean } | 'deleted';

/**
 * The Notes tab: every note the plugin keeps on items of lists you can see, grouped by list and
 * item, each item read from Todo as it is now.
 *
 * The two halves come from two apps. The notes are the plugin's; the lists and items are Todo's,
 * and the note holds only the item's id. So this is where the dependency shows: tick an item off
 * and its notes follow it as done, delete it and the note is still the plugin's, now on an item
 * Todo no longer has, and bin the list and Todo stops vouching for it, so its notes leave here.
 */
export function NotesPage({ lists }: { lists: () => Promise<{ id: string; name: string }[]>; me: string }) {
  type Group = { listId: string; name: string; items: { itemId: string; state: ItemState; notes: ItemNote[] }[] };
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/item-notes`, { credentials: 'same-origin' });
      if (!res.ok) return setError(await refusal(res));
      const { entries } = (await res.json()) as { entries: (ItemNote & { list_id: string })[] };
      const names = new Map((await lists()).map((l) => [l.id, l.name]));
      const byList = new Map<string, Map<string, ItemNote[]>>();
      for (const n of entries) {
        const items = byList.get(n.list_id) ?? new Map<string, ItemNote[]>();
        items.set(n.item_id, [...(items.get(n.item_id) ?? []), n]);
        byList.set(n.list_id, items);
      }
      const next: Group[] = [];
      for (const [listId, items] of byList) {
        const states = await itemStates(listId);
        next.push({
          listId,
          name: names.get(listId) ?? 'A list',
          items: [...items].map(([itemId, notes]) => ({ itemId, state: states.get(itemId) ?? 'deleted', notes })),
        });
      }
      setGroups(next);
      setError(null);
    } catch {
      setError('the Notes plugin is not running');
    }
  }, [lists]);
  useEffect(() => void load(), [load]);

  return (
    <section>
      <p className="sub">
        Notes on the items of lists you can see, from the Notes plugin. The plugin keeps the notes and only each
        item's id; the item itself is read from Todo as it is now.
      </p>
      {error ? (
        <wa-callout class="error" variant="warning" size="s">
          <strong>Notes is not available to you. </strong>
          {error}
        </wa-callout>
      ) : null}
      {groups && groups.length === 0 ? (
        <div className="card">
          <p className="empty">No notes yet. Open a list and use Add note on an item.</p>
        </div>
      ) : null}
      {(groups ?? []).map((g) => (
        <div className="card note-group" key={g.listId}>
          <div className="row">
            <a href={`#/list/${g.listId}`}>{g.name}</a>
          </div>
          {g.items.map((i) => (
            <div className="row note-item" key={i.itemId}>
              <div>
                {i.state === 'deleted' ? (
                  <span className="muted">An item deleted in Todo. The plugin still keeps its notes.</span>
                ) : (
                  <span className={i.state.done ? 'done' : undefined}>{i.state.text}</span>
                )}
                {i.notes.map((n) => (
                  <div className="item-note" key={n.id}>
                    {n.text}
                    <span className="muted">{new Date(n.created_at).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

/** Each item on a list as Todo has it now, read through Todo's own API. */
async function itemStates(listId: string): Promise<Map<string, ItemState>> {
  const res = await fetch(`/api/lists/${encodeURIComponent(listId)}/items?limit=100`, { credentials: 'same-origin' });
  if (!res.ok) return new Map();
  const items = (await res.json()) as { id: string; text: string; done: number }[];
  return new Map(items.map((i) => [i.id, { text: i.text, done: i.done === 1 }]));
}
