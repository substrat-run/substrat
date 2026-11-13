/**
 * Notes' OpenAPI document — derived from the declared operations, never authored. Written to
 * the checked-in `openapi.json` that `pnpm lint:api --check` holds against drift.
 */
import { apiCatalogFrom, buildOpenApiDocument } from '@substrat-run/contracts';
import { notesOperations } from '../spec/model.js';
import { notesManifest } from './manifest.js';

// The two item-note operations declare no `http`: only the door's own routes reach them, after
// Todo has vouched for the caller (`src/app.ts`).
const { 'notes/add-item-note': _add, 'notes/list-item-notes': _list, ...served } = notesOperations;

export const API = apiCatalogFrom(served, {
  'notes/add-note': { tag: 'Notes' },
  'notes/list-notes': { tag: 'Notes' },
});

export const API_DOCUMENT = buildOpenApiDocument(
  { title: 'Notes', version: notesManifest.version, description: 'A plugin of the Todo demo: a shared notepad whose people are Todo’s.' },
  API,
);
