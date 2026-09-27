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

/**
 * Every permission key a Manyfold scope declares — all six of them Manyfold's own, since
 * this vertical composes no engine (`MODULES` in provision.ts registers `manyfoldModule`
 * alone). Mirrors `MF_PERM` in manifest.ts.
 *
 * One array, two readers, and that is what makes it checked (#1208). `defineOperations`
 * takes it below as the union a mistyped `permission:` fails against; `definePermissions`
 * in `provision.ts` takes the SAME array as `keys` and throws at module load if it and
 * `MODULES` disagree in either direction. It has to be written out as literals — a
 * manifest's keys are branded `PermissionKey`s by the time anything could read them back,
 * so the union cannot be derived from `MODULES` — but "written once and checked" is a
 * different thing from "hand-maintained".
 */
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
    // Handler-composed (#1833): the entry is a projection (title resolved out of
    // the draft body), not the stored row, so `paged.over` has nothing to walk.
    // `updated_at` is caller-visible but NOT unique — several entries can share
    // an instant — so the cursor is the (updated_at, id) pair, a row-value
    // comparison the handler pushes into `WHERE` and `manyfold_entry_updated_id`
    // (migrations.ts #0003) seeks on, rather than a full rescan per page.
    paged: { sortKey: 'updated_at', order: 'desc' },
  },

  'manyfold/review-queue': {
    summary: 'Entries waiting for review',
    permission: 'content:review',
    output: entryListItem,
    // Same list as `list-entries`, filtered to `in_review` — see its cursor note.
    paged: { sortKey: 'updated_at', order: 'desc' },
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
    output: z.object({ key: z.string(), def: contentTypeDef, sql: z.string() }),
    // Handler-composed (#1833; Copilot review, PR #1843): `save-type` takes any
    // caller-chosen `key` and enforces no cap, so this grows exactly like every
    // other list here rather than being bounded by construction — the earlier
    // `{ types: [...] }` wrapper only hid that from `assertListsArePaged`, it
    // didn't make the claim true. `key` — the table's own primary key — rides at
    // the TOP LEVEL purely so `sortKey` has a field to name; `def` stays nested,
    // since the app reads `t.def` throughout the model builder.
    paged: { sortKey: 'key' },
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
      entry_id: z.string(),
      type_key: z.string(),
      slug: z.string().nullable(),
      title: z.string(),
      hash: z.string(),
      published_at: z.string(),
    }),
    // Handler-composed (#1833): grows with every publish, the same unbounded
    // shape as `list-entries`. `published_at` is `ctx.now()` and NOT unique
    // (a batch of publishes inside one operation shares an instant), so the
    // cursor is the (published_at, entry_id) pair, seeking on
    // `manyfold_delivery_published_id` (migrations.ts #0003) the same way —
    // `entry_id` is `manyfold_delivery`'s own primary key.
    paged: { sortKey: 'published_at', order: 'desc' },
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
    input: timelineInput,
    output: timelineEntry,
    // #1833 (the #811 side-step): this used to hand-splice `limit`/`cursor`/
    // `order` into `input` instead of declaring `paged`, so the platform never
    // capped it and `assertListsArePaged` never saw it (it isn't a bare array).
    // `readTimeline` already walks the event id — see the handler.
    paged: { sortKey: 'id' },
  },
});
