/**
 * Tock's OpenAPI document — derived, not authored.
 *
 * `apiCatalogFrom` reads the summaries and the input/output schemas off the declared
 * operations, so the document and the handlers cannot disagree: they are the same objects.
 * Served live at `/openapi.json`, and written to the checked-in `openapi.json` that
 * `pnpm lint:api --check` holds against drift — the file is the reviewable artifact, never
 * what a caller reads.
 *
 * `tock/profile-run` is absent from the document because it is absent from the HTTP surface:
 * it declares no route, so nothing mounts it and nothing can call it from outside. That is
 * the trust boundary rather than an omission — the host reads the file and invokes it.
 */
import { apiCatalogFrom, buildOpenApiDocument } from '@substrat-run/contracts';
import { tockOperations } from '../spec/model.js';
import { tockManifest } from './manifest.js';

export const API = apiCatalogFrom(tockOperations, {
  'tock/declare-source': { tag: 'Sources' },
  'tock/list-sources': { tag: 'Sources' },
  'tock/save-schema': { tag: 'Schemas', description: 'Never edits a version; writes the next one.' },
  'tock/list-schemas': { tag: 'Schemas' },
  'tock/receive-run': { tag: 'Runs', description: 'Records a delivered file and opens a run over it.' },
  'tock/map-run': { tag: 'Runs' },
  'tock/count-run': { tag: 'Runs', description: 'Counts a mapped run and freezes it. Which run is current is derived, never stamped.' },
  'tock/get-run': { tag: 'Runs' },
  'tock/list-runs': { tag: 'Runs' },
  'tock/list-observations': { tag: 'Findings', description: 'What arrived in one run, field by field.' },
  'tock/deviations': { tag: 'Findings', description: 'Where the declared shape and the data disagree.' },
  'tock/field-history': { tag: 'Findings', description: 'Kept longer than the runs it came from.' },
  'tock/list-rows': { tag: 'Rows', description: 'The personal-data read. Guarded by row:read, not report:read.' },
  'tock/read-source-file': { tag: 'Rows', description: 'The delivered bytes. Raw rows in their original shape, guarded the same way.' },
  'tock/report': { tag: 'Reports' },
});

export const API_DOCUMENT = buildOpenApiDocument(
  {
    title: 'Tock',
    version: tockManifest.version,
    description: 'Delivered files, declared shapes, and counts that name the run that produced them.',
  },
  API,
);
