/*
 * Copied from Web Awesome 3.14.0, `packages/webawesome/src/internal/webawesome-element.ts`
 * (https://github.com/shoelace-style/webawesome/tree/v3.14.0). Upstream marks the class
 * `@internal` and leaves `dist/internal/` out of the package's `exports` map, so it cannot
 * be imported — a copy is the only stable way to build on it. Changes from upstream, and
 * nothing else, so a diff against a later tag stays readable:
 *
 *   - renamed `WebAwesomeElement` → `SubstratElement`, custom state `wa-defined` → `sub-defined`;
 *   - `@property` decorators → `static properties`, and the field initializer moved into the
 *     constructor: this repo compiles with standard class fields, which shadow Lit's accessors;
 *   - the shadow-root comment linking to webawesome.com/docs is gone (it named the wrong docs);
 *   - host styles inlined from `styles/component/host.styles.ts`.
 *
 * MIT License — Copyright (c) 2023 Fonticons, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify, merge,
 * publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
 * to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
 * PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
 * FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */
import type { CSSResultGroup, PropertyDeclarations, PropertyValues } from 'lit';
import { LitElement, css, isServer } from 'lit';

const hostStyles = css`
  :host {
    box-sizing: border-box;
  }

  :host *,
  :host *::before,
  :host *::after {
    box-sizing: inherit;
  }

  [hidden],
  :host([hidden]) {
    display: none !important;
  }
`;

const HAS_ENDING_COLON = /;\s+$/;

function camelToKebab(str: string) {
  return str.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

// if your server doesn't have a polyfill available for this.style, (assumed by it being undefined) we modify the attribute directly.
function buildStyleAttribute(options: { property?: string | null; value?: unknown; element: HTMLElement }) {
  const { property, value, element } = options;
  if (value) {
    let style = element.getAttribute('style') || '';
    if (style) {
      // need to check if the previous property ended with a colon or not.
      if (!style.match(HAS_ENDING_COLON)) {
        style += ';';
      }
      style += ' ';
    }

    const str = `${property}: ${value}`;

    if (style.includes(str)) {
      return;
    }

    return `${style}${str};`;
  }

  return null;
}

export default class SubstratElement extends LitElement {
  // One or more CSSResultGroup to include in the component's shadow root. Host styles are automatically prepended.
  static css?: CSSResultGroup;

  /** Prepends host styles to the component's styles. */
  static get styles(): CSSResultGroup {
    const styles = Array.isArray(this.css) ? this.css : this.css ? [this.css] : [];
    return [hostStyles, ...styles];
  }

  // Make localization attributes reactive
  static properties: PropertyDeclarations = {
    dir: {},
    lang: {},
    didSSR: { type: Boolean, reflect: true, attribute: 'did-ssr' },
  };

  declare dir: string;
  declare lang: string;
  declare didSSR: boolean;

  #hasRecordedInitialProperties = false;
  initialReflectedProperties: Map<string, unknown> = new Map();
  internals!: ElementInternals;

  constructor() {
    super();
    this.didSSR = isServer || Boolean(this.shadowRoot);

    try {
      this.internals = this.attachInternals();
    } catch {
      /* Need to tell people if they need a polyfill. */
      console.error('Element internals are not supported in your browser. Consider using a polyfill');
    }

    this.customStates.set('sub-defined', true);
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (!this.#hasRecordedInitialProperties) {
      (this.constructor as typeof SubstratElement).elementProperties.forEach((obj, prop) => {
        const value = (this as Record<PropertyKey, unknown>)[prop];
        if (obj.reflect && value != null) {
          this.initialReflectedProperties.set(String(prop), value);
        }
      });

      this.#hasRecordedInitialProperties = true;
    }

    super.attributeChangedCallback(name, oldValue, newValue);
  }

  protected willUpdate(changedProperties: PropertyValues): void {
    super.willUpdate(changedProperties);

    // Run the morph fixing *after* willUpdate.
    this.initialReflectedProperties.forEach((value, prop) => {
      // If a prop changes to `null`, we assume this happens via an attribute changing to `null`.
      const self = this as Record<string, unknown>;
      if (changedProperties.has(prop) && self[prop] == null) {
        self[prop] = value;
      }
    });
  }

  protected firstUpdated(changedProperties: PropertyValues): void {
    super.firstUpdated(changedProperties);

    // This is a fix to workaround SSR not being able to catch slotchange events.
    // https://github.com/lit/lit/discussions/4697
    if (this.didSSR) {
      this.shadowRoot?.querySelectorAll('slot').forEach((slotElement) => {
        slotElement.dispatchEvent(new Event('slotchange', { bubbles: true, composed: false, cancelable: false }));
      });
    }
  }

  protected update(changedProperties: PropertyValues): void {
    try {
      super.update(changedProperties);
    } catch (e) {
      if (this.didSSR && !this.hasUpdated) {
        // Emit a hydration error so we can catch it and do cool things.
        // This may accidentally grab non-hydration related errors, but its the best I've found without directly reading error strings.
        const event = Object.assign(new Event('lit-hydration-error', { bubbles: true, composed: true, cancelable: false }), {
          error: e,
        });
        this.dispatchEvent(event);
      }
      throw e;
    }
  }

  /** Set a style across both client and server. */
  protected setStyle<T extends keyof CSSStyleDeclaration & string>(property: T, value: CSSStyleDeclaration[T]) {
    // if your server doesn't have a polyfill available for this.style, (assumed by it being undefined) we modify the attribute directly.
    if (!this.style) {
      const str = buildStyleAttribute({
        // because this is going to be serialized to an HTML style attribute, need to transform the casing.
        property: camelToKebab(property),
        value,
        element: this,
      });

      if (str) {
        this.setAttribute('style', str);
      }

      return;
    }

    // Client side
    (this.style as unknown as Record<string, unknown>)[property] = value;
  }

  /** Set a CSS custom property across both client and server. */
  protected setStyleProperty<T extends string>(property: T, value: string) {
    // if your server doesn't have a polyfill available for this.style, (assumed by it being undefined) we modify the attribute directly.
    if (!this.style) {
      const str = buildStyleAttribute({ property, value, element: this });

      if (str) {
        this.setAttribute('style', str);
      }

      return;
    }

    // Client side
    this.style.setProperty(property, value);
  }

  /** Methods for setting and checking custom states. */
  public customStates = {
    /** Adds or removes the specified custom state. */
    set: (customState: string, active: boolean) => {
      if (!this.internals?.states) return;
      try {
        if (active) {
          this.internals.states.add(customState);
        } else {
          this.internals.states.delete(customState);
        }
      } catch (e) {
        if (String(e).includes("must start with '--'")) {
          console.error('Your browser implements an outdated version of CustomStateSet. Consider using a polyfill');
        } else {
          throw e;
        }
      }
    },

    /** Determines whether or not the element currently has the specified state. */
    has: (customState: string) => {
      if (!this.internals?.states) return false;
      try {
        return this.internals.states.has(customState);
      } catch {
        return false;
      }
    },
  };

  /**
   * Given a native event, this function cancels it and dispatches it again from the host element using the desired
   * event options.
   */
  relayNativeEvent(event: Event, eventOptions?: EventInit) {
    event.stopImmediatePropagation();
    this.dispatchEvent(new (event.constructor as typeof Event)(event.type, { ...event, ...eventOptions }));
  }
}
