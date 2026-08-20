/**
 * The persona seam — the only part of this client a person writes.
 *
 * Everything else lives in `api.generated.ts`: the types are the entities'
 * `fields`, the methods are the `http` declarations, and `pnpm lint:client`
 * re-emits both from `spec/model.ts`. That file used to be written here by hand,
 * and it drifted — the app could not page and could not search for two releases
 * after the model declared both, with nothing red anywhere.
 *
 * What is left is genuinely NOT in the model: which principal a request is made
 * as. `x-principal` is the dev auth seam `src/server.ts` authenticates on, and
 * switching it in the header bar is how the permission model becomes visible.
 */
import { createClient } from './api.generated.js';

export { ApiError } from './api.generated.js';
export type { Item, List, Owner, Paged, Share, TodoClient } from './api.generated.js';

let principal = localStorage.getItem('todo.principal') ?? 'ada';
export const getPrincipal = () => principal;
export const setPrincipal = (who: string) => {
  principal = who;
  localStorage.setItem('todo.principal', who);
};

/**
 * `errorMessage` is left at its default on purpose: this vertical's `app.onError`
 * answers `{ error }` (see `src/routes.ts`), which is the first shape the default
 * reads. An app that changes its envelope overrides it here rather than being
 * guessed at — the error body is the one part of the surface the model does not
 * declare.
 */
export const api = createClient({ headers: () => ({ 'x-principal': principal }) });
