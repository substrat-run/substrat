import { substratError } from '@substrat-run/contracts';
import { selectableModel } from '@substrat-run/model-providers';

/**
 * The one refusal for a `kind: 'model'` environment setting (#1054): a new value must be a
 * model the platform catalog lists. Both doors that write one call it — the worker before any
 * effect (the Environment tab's PUT, the install form) and the module operation itself, so a
 * caller that reaches `dashboard/set-app-env` some other way gets the same problem document
 * rather than a stored value nothing priced.
 *
 * A value already stored for that key passes unchanged: a row saved before the setting became
 * a model kind stays readable and re-submittable until someone picks a listed model. A model
 * setting is never a secret, so a secret entry for one is refused too.
 */
export function refuseUnlistedModels(
  entries: readonly { key: string; value: string; secret?: boolean }[],
  modelKeys: ReadonlySet<string>,
  storedValueOf: (key: string) => string | null | undefined,
): void {
  for (const entry of entries) {
    if (!entry.value || !modelKeys.has(entry.key)) continue;
    if (!entry.secret && (selectableModel(entry.value) || storedValueOf(entry.key) === entry.value)) continue;
    // A semantic refusal, so no `errors` list: with one, the problem's detail becomes the generic
    // parse sentence, and this one names the setting the person has to change.
    throw substratError('validation_failed', `${entry.key} must be a listed model`);
  }
}
