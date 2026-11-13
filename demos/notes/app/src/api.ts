/**
 * The auth seam: the only part of this client a person writes. The methods and types are
 * `api.generated.ts`, re-emitted from `spec/model.ts` by `pnpm lint:client`.
 *
 * The identity a request carries is the session cookie the relying-party flow sets, so there
 * is no header to add. Who that login IS here is not this app's to know: the server asks the
 * workspace it is a plugin of, and answers 403 for a login it does not let in.
 */
import { createClient } from './api.generated.js';

export { ApiError } from './api.generated.js';
export type { Note, Paged } from './api.generated.js';

export const api = createClient({
  fetch: (input, init) => fetch(input, { credentials: 'same-origin', ...init }),
});
