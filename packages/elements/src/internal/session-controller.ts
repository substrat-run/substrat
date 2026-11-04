/**
 * The session an element draws: its `session` property when the host set one, the
 * shared read at its `sessionUrl` otherwise. A Lit controller so `<sub-avatar>` and
 * `<sub-user-menu>` hold the same rule once.
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { sessionAt, type Session, type SessionState } from '../session.js';

interface Host extends ReactiveControllerHost {
  sessionUrl: string;
  /** `undefined`: read it. `null`: nobody. */
  session: Session | null | undefined;
}

export class SessionController implements ReactiveController {
  #read: SessionState = { phase: 'loading' };
  #unsubscribe: (() => void) | undefined;
  #bound: { url: string; session: Session | null | undefined } | undefined;

  constructor(private readonly host: Host) {
    host.addController(this);
  }

  get state(): SessionState {
    const s = this.host.session;
    if (s === undefined) return this.#read;
    return s === null ? { phase: 'signed-out' } : { phase: 'signed-in', session: s };
  }

  /** Read again; a no-op while the host draws a `session` it was handed. */
  refresh(): Promise<void> {
    return this.host.session === undefined ? sessionAt(this.host.sessionUrl).refresh() : Promise.resolve();
  }

  hostConnected(): void {
    this.#bind();
  }

  hostUpdate(): void {
    const b = this.#bound;
    if (!b || b.url !== this.host.sessionUrl || b.session !== this.host.session) this.#bind();
  }

  hostDisconnected(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#bound = undefined;
  }

  #bind() {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#bound = { url: this.host.sessionUrl, session: this.host.session };
    if (this.host.session !== undefined) return;
    this.#unsubscribe = sessionAt(this.host.sessionUrl).subscribe((s) => {
      this.#read = s;
      this.host.requestUpdate();
    });
  }
}
