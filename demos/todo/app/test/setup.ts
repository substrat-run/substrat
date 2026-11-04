/**
 * jsdom has `attachInternals` but not its form half, which every Web Awesome form
 * control calls (`setValidity`, `setFormValue`, `validity`, …): without these, each `wa-input` and
 * `wa-button` throws on render. Inert stand-ins, so a suite here pins what the SCREEN
 * does; whether the controls really take part in a form is a browser's to show.
 */
const internals = globalThis.ElementInternals?.prototype as Partial<ElementInternals> | undefined;
if (internals) {
  internals.setValidity ??= () => {};
  internals.setFormValue ??= () => {};
  internals.checkValidity ??= () => true;
  internals.reportValidity ??= () => true;
  const valid = { valid: true, valueMissing: false, customError: false } as ValidityState;
  for (const [key, value] of [['validity', valid], ['validationMessage', ''], ['willValidate', true], ['form', null]] as const) {
    if (!(key in internals)) Object.defineProperty(internals, key, { get: () => value, configurable: true });
  }
}
