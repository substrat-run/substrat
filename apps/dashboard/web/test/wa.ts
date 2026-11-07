/** Reading and driving the `wa-*` controls a suite renders, unregistered: see `setup.tsx`. */

/** Every button in `root`: the wrappers' `wa-button`s, and the rows that stay a `<button>`. */
export const buttons = (root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>('wa-button, button')];

/** The button reading exactly `text`, or undefined. */
export const button = (text: string, root: ParentNode = document) => buttons(root).find((b) => b.textContent?.trim() === text);

/** A `wa-*` control carries `disabled` as an attribute; a native one as both. */
export const disabled = (el: Element) => el.hasAttribute('disabled');

/** Type into a `wa-input` or `wa-textarea`: the value, then the `input` event the wrapper listens for. */
export function type(el: Element, value: string): void {
  (el as HTMLElement & { value: string }).value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Choose in a `wa-select` or a `Segmented`'s `wa-radio-group`. */
export const choose = type;

/** Tick a `wa-checkbox` or `wa-switch`. */
export function check(el: Element, on: boolean): void {
  (el as HTMLElement & { checked: boolean }).checked = on;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
