/**
 * Todo's OpenAPI document — derived, not authored.
 *
 * `apiCatalogFrom` reads the summaries and the input/output schemas off the
 * declared operations, so the document and the handlers cannot disagree: they
 * are the same objects. Served live at `/openapi.json` by `server.ts`, and written
 * to the checked-in `openapi.json` that `pnpm lint:api --check` holds against
 * drift — the file is the reviewable artifact (api-surface.md §2.4), never what a
 * caller reads.
 */
import { apiCatalogFrom, buildOpenApiDocument } from '@substrat-run/contracts';
import { todoOperations } from '../spec/model.js';
import { todoManifest } from './manifest.js';

export const API = apiCatalogFrom(todoOperations, {
  'todo/join': { tag: 'Account' },
  'todo/my-lists': { tag: 'Lists', description: 'A proof walk: lists you own or were shared, never a filter.' },
  'todo/create-list': { tag: 'Lists' },
  'todo/rename-list': { tag: 'Lists' },
  'todo/delete-list': { tag: 'Lists' },
  'todo/list-items': { tag: 'Items' },
  'todo/search-list-items': {
    tag: 'Items',
    description: 'Ranked and capped, not paged — narrow the term rather than paging a relevance order.',
  },
  'todo/search-items': {
    tag: 'Items',
    description: 'The same proof walk as `my-lists`, run over search hits instead of every row.',
  },
  'todo/add-item': { tag: 'Items' },
  'todo/set-item-done': { tag: 'Items' },
  'todo/delete-item': { tag: 'Items' },
  'todo/share-list': { tag: 'Sharing', description: 'Narrows `list:contribute` onto this list for that person.' },
  'todo/list-shares': { tag: 'Sharing' },
  'todo/revoke-share': { tag: 'Sharing' },
});

export const API_DOCUMENT = buildOpenApiDocument(
  { title: 'Todo', version: todoManifest.version, description: 'A shared list app on Substrat.' },
  API,
);
