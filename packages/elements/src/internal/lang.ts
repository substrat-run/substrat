/**
 * The language an element speaks: the nearest `lang` up from it (its own included), then the
 * page's. Every element asks this one function, so two elements on one page never disagree.
 *
 * Imports nothing, so an element that loads no Web Awesome (`<sub-assistant>`) can use it.
 */

/** The canonical tag, or undefined when none is set — or the one set is malformed (`en_US`), which `Intl` would throw on mid-render. */
export function langOf(el: Element): string | undefined {
  const lang = el.closest<HTMLElement>('[lang]')?.lang || document.documentElement.lang;
  try {
    return lang ? Intl.getCanonicalLocales(lang)[0] : undefined;
  } catch {
    return undefined;
  }
}
