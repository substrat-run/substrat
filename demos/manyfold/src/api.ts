import { buildOpenApiDocument, type ApiCatalog } from '@substrat-run/contracts';
import { manyfoldManifest } from './manifest.js';
import {
  createEntryInput,
  deleteTypeInput,
  requestSiteInput,
  archiveSiteInput,
  deliverInput,
  entryIdInput,
  listDeliveryInput,
  listEntriesInput,
  manyfoldModule,
  rejectInput,
  restoreRevisionInput,
  saveDraftInput,
  saveTypeInput,
  timelineInput,
} from './module.js';

/**
 * The operation catalog (design/api-surface.md §2.1): every registered
 * operation, documented against the SAME Zod schema its handler parses.
 * Served live at `/openapi.json`, rendered at `/api/docs`, checked in as
 * `openapi.json` by `pnpm lint:api` (--check in CI).
 *
 * Entry bodies are `unknown` at this boundary by design: their real schema is
 * the CONTENT TYPE's — data-defined, versioned, validated inside the operation
 * by buildBodySchema. `manyfold/list-types` is where a client discovers it.
 */
export const API: ApiCatalog = {
  'manyfold/create-entry': {
    tag: 'Authoring',
    summary: 'Create an entry (draft revision 1).',
    description: 'Requires `content:author`. `body` is validated against the content type’s own field schema.',
    input: createEntryInput,
  },
  'manyfold/save-draft': {
    tag: 'Authoring',
    summary: 'Save a new draft revision (append-only — an edit is a new revision).',
    description: 'Requires `content:author`. Only `draft` or `unpublished` entries take new revisions.',
    input: saveDraftInput,
  },
  'manyfold/restore-revision': {
    tag: 'Authoring',
    summary: 'Restore an old revision — as a new revision, never a mutation of history.',
    description: 'Requires `content:author`.',
    input: restoreRevisionInput,
  },
  'manyfold/submit-for-review': {
    tag: 'Lifecycle',
    summary: 'Submit a draft for review.',
    description: 'Requires `content:author`. The state machine cannot skip: draft → in_review.',
    input: entryIdInput,
  },
  'manyfold/approve': {
    tag: 'Lifecycle',
    summary: 'Approve an entry in review.',
    description: 'Requires `content:review`.',
    input: entryIdInput,
  },
  'manyfold/reject': {
    tag: 'Lifecycle',
    summary: 'Reject an entry in review, back to draft — a rejection needs a note.',
    description: 'Requires `content:review`.',
    input: rejectInput,
  },
  'manyfold/publish': {
    tag: 'Lifecycle',
    summary: 'Publish an approved entry: freeze the revision with a content hash, project to delivery.',
    description: 'Requires `content:publish`. A frozen revision is immutable; later edits are new revisions.',
    input: entryIdInput,
  },
  'manyfold/unpublish': {
    tag: 'Lifecycle',
    summary: 'Unpublish an entry and remove it from delivery.',
    description: 'Requires `content:publish`.',
    input: entryIdInput,
  },
  'manyfold/archive': {
    tag: 'Lifecycle',
    summary: 'Archive an entry (terminal).',
    description: 'Requires `content:publish`.',
    input: entryIdInput,
  },
  'manyfold/list-entries': {
    tag: 'Read',
    summary: 'List entries, optionally by type and/or status.',
    description: 'Requires `content:read`.',
    input: listEntriesInput,
    inputOptional: true,
  },
  'manyfold/review-queue': {
    tag: 'Read',
    summary: 'Entries waiting in review.',
    description: 'Requires `content:review`.',
  },
  'manyfold/get-entry': {
    tag: 'Read',
    summary: 'One entry: current draft body + revision history.',
    description: 'Requires `content:read`.',
    input: entryIdInput,
  },
  'manyfold/list-types': {
    tag: 'Modelling',
    summary: 'The content types (data, not code) and the typed-table SQL each compiles to.',
    description: 'Requires `content:read`. This is where a client discovers what an entry `body` must look like.',
  },
  'manyfold/save-type': {
    tag: 'Modelling',
    summary: 'Create or update a content type — every save bumps its version.',
    description: 'Requires `content:admin`.',
    input: saveTypeInput,
  },
  'manyfold/delete-type': {
    tag: 'Modelling',
    summary: 'Delete a content type no entries use.',
    description: 'Requires `content:admin`.',
    input: deleteTypeInput,
  },
  'manyfold/request-site': {
    tag: 'Sites',
    summary: 'Request a new site — provisions a new scope for the tenant.',
    description:
      'Requires `content:manage-sites`. The vertical cannot provision itself, so this enqueues a ' +
      'platform intent the control plane drains; returns the request id to poll.',
    input: requestSiteInput,
  },
  'manyfold/archive-site': {
    tag: 'Sites',
    summary: 'Archive a site — retires one of the tenant\'s scopes.',
    description:
      'Requires `content:manage-sites`. Enqueues a platform intent the control plane drains; the ' +
      'target must be one of the tenant\'s own Manyfold scopes. Returns the request id.',
    input: archiveSiteInput,
  },
  'manyfold/deliver': {
    tag: 'Delivery',
    summary: 'One published document by (type, slug), references resolved against the published projection.',
    description: 'Requires `content:read`. Only published, frozen content — an unpublished reference comes back as an explicit unresolved marker.',
    input: deliverInput,
  },
  'manyfold/list-delivery': {
    tag: 'Delivery',
    summary: 'The published projection, optionally by type.',
    description: 'Requires `content:read`.',
    input: listDeliveryInput,
    inputOptional: true,
  },
  'manyfold/whoami': {
    tag: 'Read',
    summary: 'The caller’s principal and capability flags — the app gates its chrome on this.',
    description: 'Requires `content:read`. The kernel still enforces the real permission on every operation regardless.',
  },
  'manyfold/timeline': {
    tag: 'Read',
    summary: 'The event-spine timeline for one entity.',
    description: 'Requires `content:read`.',
    input: timelineInput,
  },
};

// Catalog/registration parity — checked at import time (see meridian/src/api.ts).
{
  const registered = Object.keys(manyfoldModule.operations ?? {});
  const documented = new Set(Object.keys(API));
  const missing = registered.filter((op) => !documented.has(op));
  const ghosts = [...documented].filter((op) => !registered.includes(op));
  if (missing.length || ghosts.length) {
    throw new Error(
      `api catalog drift — undocumented: [${missing.join(', ')}], not registered: [${ghosts.join(', ')}]`,
    );
  }
}

/** The OpenAPI 3.1 document — deterministic, versioned by the module manifest. */
export const API_DOCUMENT = buildOpenApiDocument(
  {
    title: 'Manyfold CMS API',
    version: manyfoldManifest.version,
    description:
      'The Manyfold demo vertical — a multi-scope headless CMS (draft→review→publish lifecycle, append-only revisions, freeze-on-publish, data-defined content types) on the Substrat kernel. Every operation checks a permission for the calling principal.',
  },
  API,
);
