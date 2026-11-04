/**
 * Who is signed in, for `<sub-avatar>` and `<sub-user-menu>` — with no DOM in it, so a
 * second renderer gets the same answers from the same code (as `EntityTableModel` is
 * for the table).
 *
 * One `SessionStore` per URL, shared: an avatar in the corner and the menu beside it
 * read the session once between them, and a refresh of one is a refresh of both.
 *
 * A session read answers 200 with `{ principal, display, … }`, or anything else for
 * "nobody". `email`, `picture` and `team` are read when present and never required —
 * the todo demo's `/api/me` has only the first two.
 */

export interface Session {
  principal: string;
  display: string;
  email?: string;
  picture?: string;
  /** The team (tenant) the session is in, when the read names one. */
  team?: string;
}

/**
 * `loading` until the first read answers, so nothing draws "Sign in" for someone who is
 * signed in and merely not read yet. A later refresh keeps the last answer on screen
 * instead of going back to `loading`.
 */
export type SessionState =
  | { phase: 'loading' }
  | { phase: 'signed-in'; session: Session }
  | { phase: 'signed-out' };

type Fetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>;

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/** A read's body as a session, or null when it is not one. Extra fields are ignored. */
export function parseSession(body: unknown): Session | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const principal = text(b.principal);
  if (!principal) return null;
  const session: Session = { principal, display: text(b.display) ?? text(b.email) ?? principal };
  const email = text(b.email);
  const picture = text(b.picture);
  const team = text(b.team);
  if (email) session.email = email;
  if (picture) session.picture = picture;
  if (team) session.team = team;
  return session;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const firstGrapheme = (word: string) => segmenter.segment(word)[Symbol.iterator]().next().value?.segment ?? '';

/**
 * One or two letters for a name, by grapheme rather than code unit, so an accented or
 * non-Latin first letter, or an emoji, is never cut in half. A single name gives one
 * letter; "Ada Lovelace" gives "AL", "María José García" gives "MG" (first and last).
 * A name with no letter-like start (a bare email local part, say) still gives its
 * first grapheme.
 */
export function initialsOf(display: string): string {
  const name = display.includes('@') ? display.slice(0, display.indexOf('@')) : display;
  const words = name.split(/[\s._-]+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const first = firstGrapheme(words[0]!);
  const last = words.length > 1 ? firstGrapheme(words[words.length - 1]!) : '';
  return (first + last).toLocaleUpperCase();
}

/** The Web Awesome palette hues an avatar may take; gray is left out for "nobody". */
export const HUES = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'indigo', 'purple', 'pink'] as const;
export type Hue = (typeof HUES)[number];

/**
 * A hue chosen by the principal, not the name, so a person keeps their colour when they
 * change how they are called. FNV-1a over the UTF-16 units: stable and cheap, not a
 * security property.
 */
export function hueOf(principal: string): Hue {
  let h = 0x811c9dc5;
  for (let i = 0; i < principal.length; i++) {
    h ^= principal.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return HUES[(h >>> 0) % HUES.length]!;
}

export class SessionStore {
  #state: SessionState = { phase: 'loading' };
  #listeners = new Set<(state: SessionState) => void>();
  #inFlight: Promise<void> | null = null;

  constructor(
    readonly url: string,
    private readonly fetchImpl: Fetch = (u, init) => globalThis.fetch(u, init),
  ) {}

  get state(): SessionState {
    return this.#state;
  }

  /**
   * Called with the current state now and on every change; returns the unsubscribe.
   * The first subscriber starts the first read.
   */
  subscribe(listener: (state: SessionState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    if (this.#state.phase === 'loading' && !this.#inFlight) void this.refresh();
    return () => this.#listeners.delete(listener);
  }

  /** Read again. Calls made while a read is in flight share it. */
  refresh(): Promise<void> {
    this.#inFlight ??= this.#read().finally(() => (this.#inFlight = null));
    return this.#inFlight;
  }

  /**
   * A failed read (network down, a 5xx) is "signed out" only on the first read; after
   * that it keeps the last answer, because a blip must not sign somebody out on screen.
   */
  async #read(): Promise<void> {
    let next: SessionState;
    try {
      const res = await this.fetchImpl(this.url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      const session = res.ok ? parseSession(await res.json()) : null;
      next = session ? { phase: 'signed-in', session } : { phase: 'signed-out' };
    } catch {
      if (this.#state.phase !== 'loading') return;
      next = { phase: 'signed-out' };
    }
    if (sameState(this.#state, next)) return;
    this.#state = next;
    for (const l of this.#listeners) l(next);
  }
}

function sameState(a: SessionState, b: SessionState): boolean {
  if (a.phase !== b.phase) return false;
  if (a.phase !== 'signed-in' || b.phase !== 'signed-in') return true;
  return JSON.stringify(a.session) === JSON.stringify(b.session);
}

const stores = new Map<string, SessionStore>();

/**
 * The shared store for a session URL, resolved against the page. In a browser it reads
 * again whenever the tab comes back into view, so signing out in another tab shows here
 * the next time somebody looks — without polling.
 */
export function sessionAt(url: string): SessionStore {
  const key = typeof location === 'undefined' ? url : new URL(url, location.href).href;
  let store = stores.get(key);
  if (!store) {
    const created = (store = new SessionStore(key));
    stores.set(key, created);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && created.state.phase !== 'loading') void created.refresh();
      });
    }
  }
  return store;
}

/** The auth endpoints a vertical mounts (`@substrat-run/vertical-auth`), as navigations. */
export interface AuthUrls {
  login: string;
  logout: string;
}

/** Where "Sign in" goes: back to this page once the issuer is done. */
export const signInHref = (urls: AuthUrls, returnTo: string) => withParams(urls.login, { returnTo });

/** Where "Switch user" goes: `prompt=select_account` gets past the issuer's SSO session. */
export const switchUserHref = (urls: AuthUrls, returnTo: string) =>
  withParams(urls.login, { prompt: 'select_account', returnTo });

function withParams(base: string, params: Record<string, string>): string {
  const [path, query = ''] = base.split('?', 2) as [string, string?];
  const q = new URLSearchParams(query);
  for (const [k, v] of Object.entries(params)) q.set(k, v);
  return `${path}?${q}`;
}
