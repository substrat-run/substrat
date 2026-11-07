/**
 * The screens: "My lists", "Shared with me", a list detail with items, and the owner's
 * share dialog. Every action goes through `invoke`; every read through `loaded`.
 */
import { html, nothing, type TemplateResult } from 'lit';
import { ApiError, invoke, loaded } from './api.js';

export interface Screen {
  path: string;
  label: string;
  render(): TemplateResult;
  /** Not shown in the top bar. */
  hidden?: boolean;
}

interface ListRow {
  id: string;
  owner_id: string;
  name: string;
  created_at: string;
}
interface ItemRow {
  id: string;
  text: string;
  done: number;
  done_by: string | null;
  created_by: string;
}
interface ShareRow {
  id: string;
  email: string;
}
type Entries<T> = { entries: T[] } | T[];
const rows = <T>(r: Entries<T>): T[] => (Array.isArray(r) ? r : r.entries);

const redraw = (): void => {
  dispatchEvent(new HashChangeEvent('hashchange'));
};
const fail = (err: unknown): void => {
  alert(
    err instanceof ApiError && err.status === 403
      ? 'You do not have access to do that.'
      : err instanceof Error
        ? err.message
        : String(err),
  );
};
async function act(op: string, input: unknown): Promise<void> {
  try {
    await invoke(op, input);
  } catch (err) {
    fail(err);
    return;
  }
  redraw();
}

const me = async (): Promise<string> => (await (await fetch('/api/me')).json()).principal as string;
const listIdFromHash = (): string => new URLSearchParams(location.hash.split('?')[1] ?? '').get('id') ?? '';

async function createList(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const name = String(new FormData(form).get('name') ?? '');
  form.reset();
  await act('lists/create-list', { name });
}

const listLink = (l: ListRow) => html`<a href="#/list?id=${l.id}">${l.name}</a>`;

function listsView(mine: boolean): TemplateResult {
  return html`${loaded(
    async () => {
      const [who, page] = await Promise.all([me(), invoke<Entries<ListRow>>('lists/my-lists', {})]);
      return rows(page).filter((l) => (l.owner_id === who) === mine);
    },
    (lists) =>
      lists.length === 0
        ? html`<p>${mine ? 'You have no lists yet.' : 'Nothing has been shared with you.'}</p>`
        : html`<ul>${lists.map((l) => html`<li>${listLink(l)}</li>`)}</ul>`,
  )}`;
}

const shareDialog = (): HTMLDialogElement | null => document.querySelector<HTMLDialogElement>('#share-dialog');

async function share(event: SubmitEvent, listId: string): Promise<void> {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const email = String(new FormData(form).get('email') ?? '');
  try {
    await invoke('lists/invite', { listId, email });
  } catch (err) {
    fail(err);
    return;
  }
  form.reset();
  redraw();
}

function detail(): TemplateResult {
  const listId = listIdFromHash();
  if (!listId) return html`<p>Pick a list.</p>`;
  return html`${loaded(
    async () => {
      const [who, lists, items] = await Promise.all([
        me(),
        invoke<Entries<ListRow>>('lists/my-lists', {}),
        invoke<Entries<ItemRow>>('lists/list-items', { listId }),
      ]);
      const list = rows(lists).find((l) => l.id === listId);
      const isOwner = list?.owner_id === who;
      let shares: ShareRow[] = [];
      let invites: ShareRow[] = [];
      if (isOwner) {
        shares = rows(await invoke<Entries<ShareRow>>('lists/list-shares', { listId }));
        invites = rows(await invoke<Entries<ShareRow>>('lists/list-invites', { listId }));
      }
      return { who, list, isOwner, items: rows(items), shares, invites };
    },
    ({ who, list, isOwner, items, shares, invites }) => html`
      <h1>${list?.name ?? 'List'}</h1>
      ${isOwner
        ? html`<wa-button @click=${() => shareDialog()?.showModal()}>Share…</wa-button>
            <wa-button
              variant="danger"
              @click=${async () => {
                if (!confirm('Delete this list and its items?')) return;
                await act('lists/delete-list', { listId });
                location.hash = '#/mine';
              }}
              >Delete list</wa-button
            >`
        : nothing}
      <form class="row" @submit=${async (e: SubmitEvent) => {
        e.preventDefault();
        const form = e.target as HTMLFormElement;
        const text = String(new FormData(form).get('text') ?? '');
        form.reset();
        await act('lists/add-item', { listId, text });
      }}>
        <wa-input name="text" label="New item" required></wa-input>
        <wa-button type="submit" variant="brand">Add</wa-button>
      </form>
      <ul class="items">
        ${items.map(
          (i) => html`<li>
            <wa-checkbox
              ?checked=${i.done === 1}
              @change=${(e: Event) =>
                act('lists/set-item-done', { itemId: i.id, done: (e.target as HTMLInputElement).checked })}
              >${i.text}</wa-checkbox
            >
            ${isOwner || i.created_by === who
              ? html`<wa-button size="small" @click=${() => act('lists/delete-item', { itemId: i.id })}
                  >Delete</wa-button
                >`
              : nothing}
          </li>`,
        )}
      </ul>
      ${isOwner
        ? html`<dialog id="share-dialog" aria-label="Share this list">
            <h2>Share this list</h2>
            <form class="row" @submit=${(e: SubmitEvent) => share(e, listId)}>
              <wa-input name="email" type="email" label="Their email" required></wa-input>
              <wa-button type="submit" variant="brand">Share</wa-button>
            </form>
            <ul>
              ${shares.map(
                (s) => html`<li>
                  ${s.email}
                  <wa-button size="small" @click=${() => act('lists/revoke-share', { shareId: s.id })}
                    >Remove</wa-button
                  >
                </li>`,
              )}
              ${invites.map(
                (i) => html`<li>
                  ${i.email} (invited)
                  <wa-button size="small" @click=${() => act('lists/cancel-invite', { inviteId: i.id })}
                    >Cancel</wa-button
                  >
                </li>`,
              )}
            </ul>
            <wa-button @click=${() => shareDialog()?.close()}>Close</wa-button>
          </dialog>`
        : nothing}
    `,
  )}`;
}

export const screens: Screen[] = [
  {
    path: 'mine',
    label: 'My lists',
    render: () => html`
      <h1>My lists</h1>
      <form class="row" @submit=${createList}>
        <wa-input name="name" label="New list" required></wa-input>
        <wa-button type="submit" variant="brand">Create</wa-button>
      </form>
      ${listsView(true)}
    `,
  },
  {
    path: 'shared',
    label: 'Shared with me',
    render: () => html`<h1>Shared with me</h1>${listsView(false)}`,
  },
  { path: 'list', label: 'List', hidden: true, render: detail },
];
