/**
 * Typed wrappers over the API — one per operation the model declares.
 *
 * Every path here matches an `http` declaration in `spec/model.ts`, because the
 * server derives its route table from those same declarations. There is no
 * second list of URLs to keep in step.
 */
export interface List {
  id: string;
  owner_id: string;
  name: string;
  created_at: string;
}
export interface Item {
  id: string;
  list_id: string;
  text: string;
  done: number;
  added_by: string;
  created_at: string;
}
export interface Share {
  id: string;
  list_id: string;
  principal: string;
  email: string;
  created_at: string;
}
export interface Me {
  id: string;
  email: string;
  display_name: string;
}

/** The dev persona picker: `x-principal` is what `server.ts` authenticates on. */
let principal = localStorage.getItem('todo.principal') ?? 'ada';
export const getPrincipal = () => principal;
export const setPrincipal = (who: string) => {
  principal = who;
  localStorage.setItem('todo.principal', who);
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'x-principal': principal,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = (body as { error?: string })?.error ?? res.statusText;
    // 403 is the interesting one in this app — it is the permission model
    // answering, not a bug, so it is surfaced rather than swallowed.
    throw new ApiError(res.status, message);
  }
  return body as T;
}

export const api = {
  join: (email: string, displayName: string) =>
    call<Me>('/join', { method: 'POST', body: JSON.stringify({ email, displayName }) }),
  lists: () => call<List[]>('/lists'),
  createList: (name: string) =>
    call<List>('/lists', { method: 'POST', body: JSON.stringify({ name }) }),
  renameList: (listId: string, name: string) =>
    call<List>(`/lists/${listId}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteList: (listId: string) => call<unknown>(`/lists/${listId}`, { method: 'DELETE' }),
  items: (listId: string) => call<Item[]>(`/lists/${listId}/items`),
  addItem: (listId: string, text: string) =>
    call<Item>(`/lists/${listId}/items`, { method: 'POST', body: JSON.stringify({ text }) }),
  setDone: (itemId: string, done: boolean) =>
    call<Item>(`/items/${itemId}/done`, { method: 'POST', body: JSON.stringify({ done }) }),
  deleteItem: (itemId: string) => call<unknown>(`/items/${itemId}`, { method: 'DELETE' }),
  shares: (listId: string) => call<Share[]>(`/lists/${listId}/shares`),
  shareList: (listId: string, email: string) =>
    call<Share>(`/lists/${listId}/shares`, { method: 'POST', body: JSON.stringify({ email }) }),
  revokeShare: (shareId: string) => call<unknown>(`/shares/${shareId}`, { method: 'DELETE' }),
};
