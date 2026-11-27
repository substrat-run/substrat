/**
 * `<sub-user-menu>` — the account menu in a vertical's header: who is signed in, the
 * vertical's own account items, and switching user and signing out, which it owns
 * because it is the one place that knows the auth endpoints.
 *
 * A `wa-dropdown` around a `<sub-avatar>`. Signed out, it draws "Sign in" instead; while
 * the first session read is in flight it draws the avatar's empty circle, never "Sign in".
 *
 * Slots (each has a default; slot something in to replace it):
 *   (default)     — your items, `<wa-dropdown-item value="…">`; their `wa-select` reaches
 *                   you as usual
 *   `trigger`     — what is clicked (default: the avatar, with `show` beside it). It is
 *                   put inside the menu's own `<button>`, so put no button in it
 *   `header`      — the top of the menu (default: picture, name, then email and team)
 *   `teams`       — between the header and your items; empty until team switching exists
 *   `switch-user` — default "Switch user" (`hide-switch-user` drops it)
 *   `sign-out`    — default "Sign out"; a replacement is yours to handle
 *   `signed-out`  — what shows when nobody is signed in (default: a "Sign in" button);
 *                   an empty `<span slot="signed-out">` shows nothing
 *
 * Attributes: `show` (`avatar` | `name` | `email`, default `avatar`), `size`,
 *   `session-url` (`/api/me`; empty reads nothing, for a host that sets `session`), `login-url` (`/api/auth/login`), `logout-url`
 *   (`/api/auth/logout`), `account-url` (adds "Manage account" when set),
 *   `hide-switch-user`, `placement` (default `bottom-end`).
 * Properties: `session` — set it to draw a session the host already read; `labels` —
 *   `Partial<UserMenuLabels>`, any of its words in place of the registered language's or
 *   English (`USER_MENU_LABELS`).
 * Function: `registerUserMenuLabels(code, labels)` — the menu's words for a language.
 * Events, both cancelable — `preventDefault()` keeps the navigation from happening:
 *   `sub-sign-out`, `sub-switch-user`. The built-in items send no `wa-select`.
 * Method: `refresh()` — read the session again.
 *
 * Sign-out is a top-level navigation, never a `fetch`: the logout route sends the
 * browser on to the issuer, and the cookie carrying the logout hint is scoped to that
 * one path.
 *
 * Every word it shows or announces resolves as: its own `labels`, then the words registered
 * for its language in Web Awesome's translation registry, then English. Its language is the
 * nearest `lang` up from it, then the page's, then the browser's; it sets that on the Web
 * Awesome components it draws, which would otherwise read only their own or the page's. A
 * slotted `signed-out`, `switch-user` or `sign-out` replacement is the host's, words included.
 */
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/divider/divider.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import './avatar.js';
import { css, html, nothing } from 'lit';
import type { AvatarShow } from './avatar.js';
import { LabelsController, registerLabels } from './internal/labels.js';
import { langOf } from './internal/lang.js';
import SubstratElement from './internal/substrat-element.js';
import { SessionController } from './internal/session-controller.js';
import { signInHref, switchUserHref, type Session } from './session.js';

type Builtin = 'account' | 'switch-user' | 'sign-out';

/** Every word the menu shows or announces. `name` is the person's display name. */
export interface UserMenuLabels {
  signIn: string;
  /** The trigger's accessible name when it shows only the avatar. */
  account(name: string): string;
  manageAccount: string;
  switchUser: string;
  signOut: string;
}

/** The menu's English words: the last fallback, and a start for a translation. */
export const USER_MENU_LABELS: Readonly<UserMenuLabels> = {
  signIn: 'Sign in',
  account: (name) => `Account: ${name}`,
  manageAccount: 'Manage account',
  switchUser: 'Switch user',
  signOut: 'Sign out',
};

const PREFIX = 'sub-user-menu';

/**
 * Register the menu's words for a language (`'sv'`, or a region such as `'sv-FI'`) in Web
 * Awesome's translation registry. Every menu whose language is that one uses them, unless its
 * own `labels` says otherwise; the words not given fall back to English.
 */
export function registerUserMenuLabels(code: string, labels: Partial<UserMenuLabels>): void {
  registerLabels(PREFIX, code, labels);
}

registerUserMenuLabels('en', USER_MENU_LABELS);

interface SelectEvent extends Event {
  detail: { item: HTMLElement };
}

export class SubUserMenu extends SubstratElement {
  static properties = {
    show: { reflect: true },
    size: {},
    sessionUrl: { attribute: 'session-url' },
    loginUrl: { attribute: 'login-url' },
    logoutUrl: { attribute: 'logout-url' },
    accountUrl: { attribute: 'account-url' },
    hideSwitchUser: { attribute: 'hide-switch-user', type: Boolean },
    placement: {},
    session: { attribute: false },
    labels: { attribute: false },
    customTrigger: { state: true },
  };

  declare show: AvatarShow;
  declare size: string;
  declare sessionUrl: string;
  declare loginUrl: string;
  declare logoutUrl: string;
  declare accountUrl: string | undefined;
  declare hideSwitchUser: boolean;
  declare placement: 'bottom-end' | 'bottom-start' | 'top-end' | 'top-start';
  /** `undefined`: read it. `null`: nobody. */
  declare session: Session | null | undefined;
  declare labels: Partial<UserMenuLabels> | undefined;
  declare customTrigger: boolean;

  readonly #session = new SessionController(this);
  readonly #translations = new LabelsController<UserMenuLabels>(this, PREFIX, USER_MENU_LABELS);

  constructor() {
    super();
    this.show = 'avatar';
    this.size = '2rem';
    this.sessionUrl = '/api/me';
    this.loginUrl = '/api/auth/login';
    this.logoutUrl = '/api/auth/logout';
    this.hideSwitchUser = false;
    this.placement = 'bottom-end';
    this.customTrigger = false;
    this.labels = undefined;
  }

  /** The nearest `lang` up from the menu, then the page's, then the browser's. */
  get #lang(): string {
    return langOf(this) ?? (typeof navigator === 'undefined' ? 'en' : navigator.language);
  }

  /** Read the session again (every element on that URL redraws). */
  refresh(): Promise<void> {
    return this.#session.refresh();
  }

  static css = css`
    :host {
      display: inline-block;
      font-family: var(--wa-font-family-body);
    }
    .trigger {
      display: inline-flex;
      align-items: center;
      gap: var(--wa-space-2xs);
      max-width: 100%;
      padding: var(--wa-space-3xs);
      margin: 0;
      border: 0;
      border-radius: var(--wa-border-radius-pill);
      background: none;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    :host(:not([show='avatar'])) .trigger {
      padding-inline-end: var(--wa-space-xs);
    }
    .trigger:hover {
      background: var(--wa-color-neutral-fill-quiet);
    }
    .trigger:focus-visible {
      outline: var(--wa-focus-ring);
      outline-offset: var(--wa-focus-ring-offset);
    }
    .placeholder {
      display: inline-block;
      border-radius: 50%;
      background: var(--wa-color-neutral-fill-quiet);
    }
    .header {
      display: flex;
      align-items: center;
      gap: var(--wa-space-s);
      padding: var(--wa-space-xs) var(--wa-space-m) var(--wa-space-s);
      max-width: 18rem;
    }
    .who {
      min-width: 0;
      line-height: var(--wa-line-height-condensed);
    }
    .who > * {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .name {
      font-weight: var(--wa-font-weight-semibold);
      color: var(--wa-color-text-normal);
    }
    .detail {
      font-size: var(--wa-font-size-xs);
      color: var(--wa-color-text-quiet);
    }
    wa-divider {
      --spacing: var(--wa-space-2xs);
    }
  `;

  render() {
    const state = this.#session.state;
    const lang = this.#lang;
    const words = this.#translations.resolve(lang, this.labels);
    if (state.phase === 'loading') {
      return html`<span class="placeholder" style="width: ${this.size}; height: ${this.size}" aria-hidden="true"></span>`;
    }
    if (state.phase === 'signed-out') {
      return html`<slot name="signed-out"
        ><wa-button lang=${lang} size="s" variant="brand" href=${signInHref(this.#urls, here())}>${words.signIn}</wa-button></slot
      >`;
    }
    const s = state.session;
    return html`<wa-dropdown lang=${lang} placement=${this.placement} @wa-select=${this.#onSelect}>
      <button
        slot="trigger"
        class="trigger"
        part="trigger"
        aria-label=${this.show === 'avatar' && !this.customTrigger ? words.account(s.display) : nothing}
      >
        <slot name="trigger" @slotchange=${this.#onTriggerSlot}
          ><sub-avatar .session=${s} show=${this.show} size=${this.size}></sub-avatar
        ></slot>
      </button>
      <slot name="header">
        <div class="header" part="header">
          <sub-avatar .session=${s} size="2.5rem" aria-hidden="true"></sub-avatar>
          <div class="who">
            <div class="name">${s.display}</div>
            ${s.email && s.email !== s.display ? html`<div class="detail">${s.email}</div>` : nothing}
            ${s.team ? html`<div class="detail">${s.team}</div>` : nothing}
          </div>
        </div>
      </slot>
      <wa-divider lang=${lang}></wa-divider>
      <slot name="teams"></slot>
      <slot></slot>
      ${this.accountUrl
        ? html`<wa-dropdown-item lang=${lang} data-builtin="account" href=${this.accountUrl}>${words.manageAccount}</wa-dropdown-item>`
        : nothing}
      <slot name="switch-user"
        >${this.hideSwitchUser
          ? nothing
          : html`<wa-dropdown-item lang=${lang} data-builtin="switch-user">${words.switchUser}</wa-dropdown-item>`}</slot
      >
      <wa-divider lang=${lang}></wa-divider>
      <slot name="sign-out"><wa-dropdown-item lang=${lang} data-builtin="sign-out">${words.signOut}</wa-dropdown-item></slot>
    </wa-dropdown>`;
  }

  get #urls() {
    return { login: this.loginUrl, logout: this.logoutUrl };
  }

  #onTriggerSlot(e: Event) {
    this.customTrigger = (e.target as HTMLSlotElement).assignedNodes().length > 0;
  }

  /**
   * A built-in item is recognised by being OURS — in this shadow root — never by its
   * value, so a slotted `<wa-dropdown-item value="sign-out">` of the host's is the
   * host's. Ours stop here: the host hears `sub-sign-out`, not a `wa-select` it would
   * have to tell apart from its own.
   */
  #onSelect(e: SelectEvent) {
    const item = e.detail.item;
    const builtin = item.getRootNode() === this.renderRoot ? (item.dataset.builtin as Builtin | undefined) : undefined;
    if (!builtin) return;
    e.stopPropagation();
    if (builtin === 'account') return; // its href navigates
    const name = builtin === 'sign-out' ? 'sub-sign-out' : 'sub-switch-user';
    const go = new CustomEvent(name, { bubbles: true, composed: true, cancelable: true });
    if (!this.dispatchEvent(go)) return;
    location.assign(builtin === 'sign-out' ? this.logoutUrl : switchUserHref(this.#urls, here()));
  }
}

/** This page, as the place to come back to. */
const here = () => location.pathname + location.search + location.hash;

if (!customElements.get('sub-user-menu')) customElements.define('sub-user-menu', SubUserMenu);

declare global {
  interface HTMLElementTagNameMap {
    'sub-user-menu': SubUserMenu;
  }
}
