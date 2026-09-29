import { useEffect, useState } from 'react';

/**
 * The request slide-over's address (#1752 §7a, #1916) — one opener for every page.
 *
 * The panel is part of the URL (`req`, `reqAt`, and `reqScope` when the call belongs to a
 * scope other than the page's own), so a request can be linked to, survives a reload, and
 * Back closes it. Opening adds those keys to whatever page is showing, keeping its own; the
 * page renders the panel from them. Any component can therefore open a request — a
 * transition card in a record's timeline, deep inside a panel — without owning one.
 */

export interface RequestInUrl {
  invocationId: string;
  atMs: number;
  scopeId: string | null;
}

/** Read the open request from a query string; null unless it names a call and a usable instant. */
export function requestInUrl(search: string): RequestInUrl | null {
  const p = new URLSearchParams(search);
  const invocationId = p.get('req');
  const at = Number(p.get('reqAt'));
  // A hand-edited `reqAt` outside what a Date can hold would throw inside the panel.
  if (!invocationId || !Number.isFinite(at) || Number.isNaN(new Date(at).getTime())) return null;
  return { invocationId, atMs: at, scopeId: p.get('reqScope') || null };
}

function push(url: URL): void {
  window.history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function openRequestInUrl(invocationId: string, atMs: number, scopeId?: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('req', invocationId);
  url.searchParams.set('reqAt', String(Math.round(atMs)));
  if (scopeId) url.searchParams.set('reqScope', scopeId);
  else url.searchParams.delete('reqScope');
  push(url);
}

export function closeRequestInUrl(): void {
  const url = new URL(window.location.href);
  for (const k of ['req', 'reqAt', 'reqScope']) url.searchParams.delete(k);
  push(url);
}

/** The open request, kept current across navigation — for a page that hosts the panel. */
export function useRequestInUrl(): RequestInUrl | null {
  const [search, setSearch] = useState(() => window.location.search);
  useEffect(() => {
    const sync = () => setSearch(window.location.search);
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  return requestInUrl(search);
}
