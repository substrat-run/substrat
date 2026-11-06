/**
 * The two ways a screen reaches the API. `pagedRead` is an entity table's source over a
 * paged GET route; `invoke` runs any operation, and the kernel checks its permission.
 */
import type { Page, TableQuery, TableSource } from '@substrat-run/elements';

/** The `rel="next"` URL out of an RFC 8288 `Link` header, or null. */
const nextFrom = (link: string | null): string | null => link?.match(/<([^>]+)>\s*;\s*rel="next"/)?.[1] ?? null;

async function pageAt<T>(url: string): Promise<Page<T>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const total = res.headers.get('X-Total-Count');
  return {
    entries: (await res.json()) as T[],
    next: nextFrom(res.headers.get('Link')),
    total: total === null ? null : Number(total),
  };
}

/**
 * What `<sub-entity-table>` reads from: the paged route in `spec/model.ts`, e.g. `/api/items`.
 * It passes on sort, order and limit only. A table that declares views, filters or search
 * needs a source written for its route, as `LISTS` is in `todo`'s `app/src/elements.tsx`.
 */
export function pagedRead<T, S extends string = string>(path: string): TableSource<T, S> {
  return {
    read({ sort, order, limit }: TableQuery<S>) {
      const params = new URLSearchParams();
      if (sort) params.set('sort', sort);
      if (order) params.set('order', order);
      if (limit) params.set('limit', String(limit));
      return pageAt<T>(`${path}?${params}`);
    },
    follow: (next) => pageAt<T>(next),
  };
}

/** Run an operation by its name in `spec/model.ts`, e.g. `invoke('acme/add-item', { name })`. */
export async function invoke<T>(op: string, input?: unknown): Promise<T> {
  const res = await fetch('/api/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, input }),
  });
  if (!res.ok) throw new Error(`${op} answered ${res.status}`);
  return (await res.json()) as T;
}
