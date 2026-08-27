/**
 * Manyfold's declared operation surface (#865, #891's recipe applied to the last
 * three packages that had none).
 *
 * ## Why this file exists now
 *
 * Manyfold's node-only claim was a `nodeOnlySuite` tripwire: a grep of
 * `module.ts` for a two-argument `ctx.check`. That is lexical — it proves an
 * absence rather than a behaviour, and a check assembled through a helper is
 * invisible to it. Twenty-one operations described only by their handlers is
 * also the state #891 called *undeclarable rather than undeclared*.
 *
 * Declared, the claim becomes exact: `planEntityCheckCoverage` reads these
 * entries the same way the conformance kit does, so an operation that starts
 * narrowing turns `declaredNodeOnlySuite` red and has to wire the real kit.
 *
 * ## Every check is at the NODE, and the grant half says why
 *
 * Authority here is a ROLE over the whole workspace — an author authors, a
 * publisher publishes — and a document's lifecycle gates who may act on it by
 * its STATE, not by who was granted that particular document. The strong half of
 * that claim is not in this file: `ENTITY_GRANTS` in `provision.ts` is `[]`, so
 * this vertical mints no narrowed grant for a narrowed check to resolve against,
 * and an entity check here would deny every caller. The empty list and the node
 * checks are two statements of one fact.
 *
 * A per-site editorial boundary — author on this site, not that one — is the
 * change that breaks both at once, and it would need a grant shape in §4 of
 * `PERMISSIONS.md` as well as narrowed checks here.
 *
 * ## The schemas are the SAME objects the handlers parse
 *
 * Imported from `schemas.ts` rather than restated, which is the whole point:
 * a declaration transcribed beside an implementation is two descriptions of one
 * fact, and #889 found exactly that defect in the reference vertical. These are
 * one description, read by the kit and applied by the host.
 */
import { defineOperations, timelineEntry, z } from '@substrat-run/contracts';
import { manyfoldEntities } from './entities.js';
import {
  archiveSiteInput,
  createEntryInput,
  deleteTypeInput,
  deliverInput,
  entryIdInput,
  listDeliveryInput,
  listEntriesInput,
  rejectInput,
  requestSiteInput,
  restoreRevisionInput,
  saveDraftInput,
  saveTypeInput,
  timelineInput,
} from './schemas.js';

/** The keys these operations check. Mirrors `MF_PERM` in manifest.ts. */
export const MANYFOLD_PERMISSIONS = [
  'content:read',
  'content:author',
  'content:review',
  'content:publish',
  'content:admin',
  'content:manage-sites',
] as const;

/** The entry row, as every mutation returns it. */
const entry = manyfoldEntities['manyfold-entry'].fields;

/** What a list row carries — enough to render a table, never the body. */
const entryListItem = z.object({
  id: z.string(),
  type_key: z.string(),
  status: entry.shape.status,
  slug: z.string().nullable(),
  title: z.string(),
  updated_at: z.string(),
});

/** One entry with its current draft body and its revision history. */
const entryDetail = z.object({
  entry,
  body: z.record(z.string(), z.unknown()),
  revisions: z.array(
    z.object({
      rev_no: z.number(),
      frozen: z.number(),
      hash: z.string().nullable(),
      author: z.string(),
      created_at: z.string(),
    }),
  ),
});

/** A content type as authored, plus the typed table it compiles to. */
const contentTypeDef = z.object({
  key: z.string(),
  version: z.number(),
  title: z.string(),
  titleField: z.string(),
  slugField: z.string().optional(),
  fields: z.record(z.string(), z.unknown()),
});

/** Published, frozen content with its references resolved — the delivery read. */
const deliveryPayload = z.object({
  type: z.string(),
  slug: z.string().nullable(),
  hash: z.string(),
  publishedAt: z.string(),
  body: z.record(z.string(), z.unknown()),
});

/**
 * The page fields the timeline read takes BESIDE the entity it names.
 *
 * Declared rather than assumed: the host parses a declared input (#893), and a
 * Zod object drops what it does not name — so a declaration of the entity alone
 * would have silently stripped `limit`/`cursor`/`order` and quietly unpaged the
 * one paged read this vertical has.
 */
const pageIn = z.object({
  limit: z.number().int().positive().optional(),
  cursor: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export const manyfoldOperations = defineOperations(manyfoldEntities, MANYFOLD_PERMISSIONS)({
  'manyfold/create-entry': {
    summary: 'Create a draft entry of a content type',
    permission: 'content:author',
    input: createEntryInput,
    output: entry,
  },

  'manyfold/save-draft': {
    summary: 'Save a new revision of a draft or unpublished entry',
    permission: 'content:author',
    input: saveDraftInput,
    output: entry,
  },

  'manyfold/restore-revision': {
    summary: 'Copy an old revision forward as a new draft revision',
    permission: 'content:author',
    input: restoreRevisionInput,
    output: entry,
  },

  'manyfold/submit-for-review': {
    summary: 'Hand a draft to the review queue',
    permission: 'content:author',
    input: entryIdInput,
    output: entry,
  },

  'manyfold/approve': {
    summary: 'Approve a submitted entry',
    permission: 'content:review',
    input: entryIdInput,
    output: entry,
  },

  'manyfold/reject': {
    summary: 'Send a submitted entry back, with a note',
    permission: 'content:review',
    input: rejectInput,
    output: entry,
  },

  'manyfold/publish': {
    summary: 'Freeze the current revision and publish it',
    permission: 'content:publish',
    input: entryIdInput,
    output: entry,
  },

  'manyfold/unpublish': {
    summary: 'Withdraw a published entry from delivery',
    permission: 'content:publish',
    input: entryIdInput,
    output: entry,
  },

  'manyfold/archive': {
    summary: 'Archive an entry',
    permission: 'content:publish',
    input: entryIdInput,
    output: entry,
  },

  'manyfold/list-entries': {
    summary: 'Entries, optionally filtered by type and status',
    permission: 'content:read',
    input: listEntriesInput,
    inputOptional: true,
    output: entryListItem,
  },

  'manyfold/review-queue': {
    summary: 'Entries waiting for review',
    permission: 'content:review',
    output: entryListItem,
  },

  'manyfold/get-entry': {
    summary: 'One entry with its current body and revision history',
    permission: 'content:read',
    input: entryIdInput,
    output: entryDetail,
  },

  'manyfold/list-types': {
    summary: 'The content types, each with the table it compiles to',
    permission: 'content:read',
    output: z.object({ def: contentTypeDef, sql: z.string() }),
  },

  'manyfold/save-type': {
    summary: 'Create or update a content type — modelling is an admin act',
    permission: 'content:admin',
    input: saveTypeInput,
    output: contentTypeDef,
  },

  'manyfold/delete-type': {
    summary: 'Delete a content type no entry uses',
    permission: 'content:admin',
    input: deleteTypeInput,
    output: z.object({ deleted: z.string() }),
  },

  'manyfold/request-site': {
    summary: 'Ask the platform to provision a sibling site',
    permission: 'content:manage-sites',
    input: requestSiteInput,
    // The intent id, so a caller can watch for the site rather than guess. The
    // scope itself is the PLATFORM's to create (platform-intents.md).
    output: z.object({ requestId: z.string() }),
  },

  'manyfold/archive-site': {
    summary: 'Ask the platform to archive one of this tenant’s sites',
    permission: 'content:manage-sites',
    input: archiveSiteInput,
    output: z.object({ requestId: z.string() }),
  },

  'manyfold/deliver': {
    summary: 'The published, frozen body for one (type, slug)',
    permission: 'content:read',
    input: deliverInput,
    output: deliveryPayload,
  },

  'manyfold/list-delivery': {
    summary: 'What is currently published, newest first',
    permission: 'content:read',
    input: listDeliveryInput,
    inputOptional: true,
    output: z.object({
      type_key: z.string(),
      slug: z.string().nullable(),
      title: z.string(),
      hash: z.string(),
    }),
  },

  'manyfold/whoami': {
    summary: 'Who am I in this site, and what may I do',
    permission: 'content:read',
    // The app gates its chrome on this: every key is present, `read` is `true`
    // by construction (the operation itself checked it), and the rest are the
    // decisions `ctx.check` gave — never a role name the client has to interpret.
    //
    // Named one by one rather than as a `record`, because "every key is present"
    // is the whole contract and a record cannot state it: a key silently missing
    // from the map reads as `undefined` → falsy → the action is hidden, which is a
    // permission the holder never sees. Spelled out, the generated client types it
    // and a forgotten key is a compile error instead of absent chrome.
    output: z.object({
      principal: z.string(),
      can: z.object({
        read: z.boolean(),
        author: z.boolean(),
        review: z.boolean(),
        publish: z.boolean(),
        admin: z.boolean(),
        manageSites: z.boolean(),
      }),
    }),
  },

  'manyfold/timeline': {
    summary: 'What happened to one entity, newest-first or oldest-first',
    permission: 'content:read',
    input: timelineInput.extend(pageIn.shape),
    output: timelineEntry,
  },
});
