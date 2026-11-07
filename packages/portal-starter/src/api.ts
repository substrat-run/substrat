/**
 * The two ways a screen reaches the API. `pagedRead` is an entity table's source over a
 * paged GET route; `invoke` runs any operation, and the kernel checks its permission.
 */
import type { Page, TableQuery, TableSource } from '@substrat-run/elements';
import { html, type TemplateResult } from 'lit';
import { until } from 'lit/directives/until.js';

/** A request the server refused or failed; `status` tells a 403 from anything else. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * A read the screen makes itself, outside a table: its view once it answers, a refusal or a
 * failure said as one, never "Loading…" for ever and never an empty list.
 */
export function loaded<T>(load: () => Promise<T>, view: (value: T) => TemplateResult): unknown {
  const failed = (err: unknown): TemplateResult =>
    html`<p role="alert">${err instanceof ApiError && err.status === 403 ? 'You do not have access to this.' : 'This could not be loaded.'}</p>`;
  return until(load().then(view, failed), html`<p>Loading…</p>`);
}

/** The `rel="next"` URL out of an RFC 8288 `Link` header, or null. */
const nextFrom = (link: string | null): string | null => link?.match(/<([^>]+)>\s*;\s*rel="next"/)?.[1] ?? null;

async function pageAt<T>(url: string): Promise<Page<T>> {
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(`${url} answered ${res.status}`, res.status);
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
  if (!res.ok) throw new ApiError(`${op} answered ${res.status}`, res.status);
  return (await res.json()) as T;
}
