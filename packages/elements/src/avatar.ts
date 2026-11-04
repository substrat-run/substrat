/**
 * `<sub-avatar>` — who is signed in, as a picture or initials, and optionally their name
 * or email beside it. No menu: a corner badge, a byline, a row in a member list.
 *
 * Reads the session itself (`SessionStore`, shared per URL, so many avatars on a page
 * are one read), or draws the `session` property when the host already has one — a
 * member list passes each member's. A picture that fails to load falls back to the
 * initials, and the colour follows the principal, so it survives a rename.
 *
 * Attributes:
 *   `show`     — `avatar` (default), `name` or `email`: what is written beside the picture
 *   `session-url` — the session read (default `/api/me`)
 *   `size`     — any CSS length for the circle (default `2rem`)
 * Property: `session` — a `Session`, or `null` for "nobody"; set, it replaces the read.
 *
 * While the first read is in flight it draws an empty circle of the same size, so the
 * header does not jump when the answer lands.
 */
import '@awesome.me/webawesome/dist/components/avatar/avatar.js';
import { css, html, nothing, unsafeCSS } from 'lit';
import SubstratElement from './internal/substrat-element.js';
import { SessionController } from './internal/session-controller.js';
import { HUES, hueOf, initialsOf, type Session, type SessionState } from './session.js';

export type AvatarShow = 'avatar' | 'name' | 'email';

/**
 * One rule per palette hue, both schemes in one declaration (`light-dark()` follows the
 * `color-scheme` every Web Awesome theme sets), so dark mode needs no selector here.
 */
const HUE_RULES = HUES.map(
  (h) => `wa-avatar[data-hue='${h}'] {
    background-color: light-dark(var(--wa-color-${h}-80), var(--wa-color-${h}-30));
    color: light-dark(var(--wa-color-${h}-20), var(--wa-color-${h}-90));
  }`,
).join('\n');

export class SubAvatar extends SubstratElement {
  static properties = {
    show: { reflect: true },
    sessionUrl: { attribute: 'session-url' },
    size: {},
    session: { attribute: false },
  };

  declare show: AvatarShow;
  declare sessionUrl: string;
  declare size: string;
  /** `undefined`: read it. `null`: nobody. */
  declare session: Session | null | undefined;

  readonly #session = new SessionController(this);

  constructor() {
    super();
    this.show = 'avatar';
    this.sessionUrl = '/api/me';
    this.size = '2rem';
  }

  /** What is drawn: the `session` property when set, the read otherwise. */
  get state(): SessionState {
    return this.#session.state;
  }

  /** Read the session again (every element on that URL redraws). */
  refresh(): Promise<void> {
    return this.#session.refresh();
  }

  static css = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: var(--wa-space-xs);
      font-family: var(--wa-font-family-body);
      font-size: var(--wa-font-size-s);
      color: var(--wa-color-text-normal);
      vertical-align: middle;
      min-width: 0;
    }
    wa-avatar {
      flex: none;
      font-weight: var(--wa-font-weight-semibold);
    }
    .placeholder {
      flex: none;
      border-radius: 50%;
      background: var(--wa-color-neutral-fill-quiet);
    }
    .label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    ${unsafeCSS(HUE_RULES)}
  `;

  render() {
    const state = this.state;
    const box = `--size: ${this.size}; width: ${this.size}; height: ${this.size}`;
    if (state.phase === 'loading') return html`<span class="placeholder" style=${box} aria-hidden="true"></span>`;
    if (state.phase === 'signed-out') return nothing;
    const s = state.session;
    const beside = this.show === 'email' ? (s.email ?? s.display) : this.show === 'name' ? s.display : '';
    // Named when it stands alone; when the name is written beside it, the picture is
    // decoration and the text is what is read.
    return html`<wa-avatar
        data-hue=${hueOf(s.principal)}
        style=${box}
        image=${s.picture ?? ''}
        initials=${initialsOf(s.display)}
        label=${beside ? '' : s.display}
        aria-hidden=${beside ? 'true' : nothing}
        loading="lazy"
      ></wa-avatar
      >${beside ? html`<span class="label" part="label">${beside}</span>` : nothing}`;
  }
}

if (!customElements.get('sub-avatar')) customElements.define('sub-avatar', SubAvatar);

declare global {
  interface HTMLElementTagNameMap {
    'sub-avatar': SubAvatar;
  }
}
