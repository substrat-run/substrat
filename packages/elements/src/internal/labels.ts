/**
 * An element's words, layered on Web Awesome's translation registry — the one its own
 * components (`wa-button`, `wa-select`, …) read. Each word resolves as: the element's own
 * `labels`, then the translation registered for the element's language, then English.
 *
 * An element's keys sit in the registry under its prefix (`sub-kanban.addCard`), beside Web
 * Awesome's, so a page that imports Web Awesome's `translations/sv.js` and registers the
 * elements' Swedish switches both with one `lang`. A word Web Awesome already has (`columns`,
 * `rowsPerPage`) is not duplicated: the element names it in `shared`, reads it from Web
 * Awesome's key, and its English default is Web Awesome's English, so the two never differ.
 */
import { LocalizeController, registerTranslation } from '@awesome.me/webawesome/dist/utilities/localize.js';
import type { ReactiveControllerHost } from 'lit';

type Entry = Record<string, unknown> | undefined;

/**
 * What the registry hands back for a language: the regional entry (`sv-fi`) and the base one
 * (`sv`). Declared private in `@shoelace-style/localize`'s types, but it is the only reader
 * that takes a language: `term()` reads the host's own `lang` or `<html lang>`, never an
 * ancestor's, which is not the rule `langOf` sets for every element here. Web Awesome is
 * pinned, and the labels suite reads a registered word through it, so a change is a red test.
 */
interface Registry {
  getTranslationData(lang: string): { primary?: Entry; secondary?: Entry };
}

/** An element's key to a Web Awesome key, for a word Web Awesome already has. */
export type SharedKeys = Readonly<Record<string, string>>;

const idOf = (prefix: string, shared: SharedKeys | undefined, key: string) => shared?.[key] ?? `${prefix}.${key}`;

/**
 * Register an element's words for one language. Only `$code` and the element's keys: a
 * `$name` or `$dir` here would overwrite Web Awesome's own for that language, and
 * `registerTranslation` merges into what a code already holds. A shared word goes under Web
 * Awesome's key, so it changes Web Awesome's components in that language too.
 */
export function registerLabels(prefix: string, code: string, labels: object, shared?: SharedKeys): void {
  const entries = Object.entries(labels)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'function')
    .map(([key, value]) => [idOf(prefix, shared, key), value]);
  registerTranslation({ $code: code, ...Object.fromEntries(entries) } as unknown as Parameters<typeof registerTranslation>[0]);
}

/**
 * An element's English, as it goes into the registry: without the shared words, which Web
 * Awesome registered already and which this must not overwrite.
 */
export function ownWords<L extends object>(labels: L, shared: SharedKeys): Partial<L> {
  return Object.fromEntries(Object.entries(labels).filter(([key]) => !(key in shared))) as Partial<L>;
}

/** Resolves an element's words for a language, and re-renders it when a translation is registered or `<html lang>` changes. */
export class LabelsController<L extends object> {
  readonly #registry: Registry;
  readonly #prefix: string;
  readonly #defaults: L;
  readonly #shared: SharedKeys | undefined;

  constructor(host: ReactiveControllerHost & HTMLElement, prefix: string, defaults: L, shared?: SharedKeys) {
    this.#registry = new LocalizeController(host) as unknown as Registry;
    this.#prefix = prefix;
    this.#defaults = defaults;
    this.#shared = shared;
  }

  /**
   * Every word, from the element's own `labels`, then the registry for `lang`, then English.
   * A value of the wrong kind (a string where the word takes arguments) is passed over, so a
   * mistyped translation falls back rather than throwing mid-render.
   */
  resolve(lang: string, own: Partial<L> | undefined): L {
    const { primary, secondary } = this.#registry.getTranslationData(lang);
    const words: Record<string, unknown> = {};
    for (const [key, fallback] of Object.entries(this.#defaults)) {
      const id = idOf(this.#prefix, this.#shared, key);
      const candidates = [(own as Record<string, unknown> | undefined)?.[key], primary?.[id], secondary?.[id]];
      words[key] = candidates.find((value) => typeof value === typeof fallback) ?? fallback;
    }
    return words as L;
  }
}
