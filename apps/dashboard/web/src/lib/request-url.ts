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

/** The page's query string, kept current across navigation. */
function useSearch(): string {
  const [search, setSearch] = useState(() => window.location.search);
  useEffect(() => {
    const sync = () => setSearch(window.location.search);
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  return search;
}

/** The open request, kept current across navigation — for a page that hosts the panel. */
export function useRequestInUrl(): RequestInUrl | null {
  return requestInUrl(useSearch());
}

/**
 * A record's timeline, addressed the same way (#1921): `rec=<entityType>:<id>`, and
 * `recScope` when it lives in a scope other than the page's. What the ⌘K overlay opens for
 * a pasted record id, and what makes a record linkable from anywhere.
 */
export interface RecordInUrl {
  entityType: string;
  entityId: string;
  scopeId: string | null;
}

export function recordInUrl(search: string): RecordInUrl | null {
  const p = new URLSearchParams(search);
  const rec = p.get('rec');
  const i = rec ? rec.indexOf(':') : -1;
  // The type is before the FIRST colon: an id may hold colons, a type does not.
  if (!rec || i <= 0 || i === rec.length - 1) return null;
  return { entityType: rec.slice(0, i), entityId: rec.slice(i + 1), scopeId: p.get('recScope') || null };
}

export function openRecordInUrl(entityType: string, entityId: string, scopeId?: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('rec', `${entityType}:${entityId}`);
  if (scopeId) url.searchParams.set('recScope', scopeId);
  else url.searchParams.delete('recScope');
  push(url);
}

export function closeRecordInUrl(): void {
  const url = new URL(window.location.href);
  for (const k of ['rec', 'recScope']) url.searchParams.delete(k);
  push(url);
}

export function useRecordInUrl(): RecordInUrl | null {
  return recordInUrl(useSearch());
}
