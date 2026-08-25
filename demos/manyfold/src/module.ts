import { z } from 'zod';
import {
  type EntityRef,
  PROVISION_SIBLING_KIND,
  ARCHIVE_SCOPE_KIND,
  assertTransition,
  defineLifecycles,
  substratError,
  type ListPage,
  type Page,
  type TimelineEntry,
} from '@substrat-run/contracts';
import { manyfoldEntities } from './entities.js';
import {
  assertAllowed,
  readTimeline,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';
import {
  buildBodySchema,
  CONTENT_TYPES,
  FIELD_TYPES,
  compileTypeToSql,
  referenceFields,
  type ContentTypeDef,
} from './content-types.js';
import { MF_PERM, manyfoldManifest } from './manifest.js';
import { manyfoldMigrations } from './migrations.js';

/**
 * Manyfold's own conflicts — the reason narrows the platform's `conflict` (§2 of the
 * error model), the same way `assertTransition` narrows it with `invalid_transition`.
 */
type ManyfoldConflictReason = 'slug_taken' | 'not_editable' | 'not_restorable' | 'in_use';
const conflict = (reason: ManyfoldConflictReason, message: string) =>
  substratError('conflict', message, { reason });

// ============================================================================
// Manyfold — a multi-scope headless CMS. The vertical owns the content types
// (content-types.ts) and, for Milestone A (decision 27; the engine extraction
// waits for a second content vertical), the editorial lifecycle itself:
// a draft→review→publish state machine that can't skip, append-only revisions,
// freeze-on-publish with a content hash, and references resolved at delivery.
//
// The declarative surface (MF_PERM, manifest) lives in manifest.ts; the
// migration journal in migrations.ts. This file is operations + wiring.
// ============================================================================

// ── Rows ────────────────────────────────────────────────────────────────────

/**
 * The editorial statuses — **taken from the entity registry, not restated** (#844).
 * The column's `z.enum` is the one description; this reads its options.
 */
export const ENTRY_STATUSES = manyfoldEntities['manyfold-entry'].fields.shape.status.options;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

// The operation input schemas — named and exported so the API catalog
// (src/api.ts) documents the SAME objects the handlers parse
// (design/api-surface.md §2.1). `body` stays `unknown` at this boundary on
// purpose: an entry body's real schema is the CONTENT TYPE's, data-defined and
// validated by buildBodySchema inside the operation.
export const createEntryInput = z.object({ typeKey: z.string().min(1), body: z.unknown() });
export const saveDraftInput = z.object({ entryId: z.string().min(1), body: z.unknown() });
export const restoreRevisionInput = z.object({ entryId: z.string().min(1), revNo: z.number().int().positive() });
export const entryIdInput = z.object({ entryId: z.string().min(1) });
export const rejectInput = z.object({ entryId: z.string().min(1), note: z.string().min(1, 'a rejection needs a note') });
export const listEntriesInput = z.object({ typeKey: z.string().min(1).optional(), status: z.enum(ENTRY_STATUSES).optional() });
export const deliverInput = z.object({ typeKey: z.string().min(1), slug: z.string().min(1) });
export const listDeliveryInput = z.object({ typeKey: z.string().min(1).optional() });
export const deleteTypeInput = z.object({ key: z.string().min(1) });
export const timelineInput = z.object({ entityType: z.string().min(1), entityId: z.string().min(1) });

export interface EntryRow {
  id: string;
  type_key: string;
  status: EntryStatus;
  slug: string | null;
  draft_rev: number;
  published_rev: number | null;
  created_at: string;
  updated_at: string;
}

export interface RevisionRow {
  id: string;
  entry_id: string;
  rev_no: number;
  body_json: string;
  hash: string | null;
  frozen: number;
  author: string;
  created_at: string;
}

export interface DeliveryRow {
  entry_id: string;
  type_key: string;
  slug: string | null;
  rev_no: number;
  hash: string;
  body_json: string;
  title: string;
  published_at: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const entryRef = (id: string): EntityRef => ({ entityType: 'manyfold-entry', entityId: id });

interface ContentTypeRow {
  key: string;
  version: number;
  title: string;
  title_field: string;
  slug_field: string | null;
  fields_json: string;
  created_at: string;
  updated_at: string;
}

function rowToDef(r: ContentTypeRow): ContentTypeDef {
  return {
    key: r.key,
    version: r.version,
    title: r.title,
    titleField: r.title_field,
    ...(r.slug_field ? { slugField: r.slug_field } : {}),
    fields: JSON.parse(r.fields_json) as ContentTypeDef['fields'],
  };
}

/** Seed the four default types once, on first use. Guarded on emptiness, so a user who
 *  deletes a default is not re-seeded. */
function ensureTypes(ctx: OperationContext): void {
  const n = ctx.sql.query<{ n: number }>('SELECT COUNT(*) AS n FROM manyfold_content_type')[0]!.n;
  if (n > 0) return;
  const now = ctx.now();
  for (const def of CONTENT_TYPES) {
    ctx.sql.exec(
      'INSERT OR IGNORE INTO manyfold_content_type (key, version, title, title_field, slug_field, fields_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [def.key, def.version, def.title, def.titleField, def.slugField ?? null, JSON.stringify(def.fields), now, now],
    );
  }
}

/** A content type's live definition, from the store (types are data, not code). */
function loadType(ctx: OperationContext, typeKey: string): ContentTypeDef {
  ensureTypes(ctx);
  const r = ctx.sql.query<ContentTypeRow>('SELECT * FROM manyfold_content_type WHERE key = ?', [typeKey])[0];
  if (!r) throw substratError('not_found', `unknown content type: ${typeKey}`);
  return rowToDef(r);
}

function loadTypes(ctx: OperationContext): ContentTypeDef[] {
  ensureTypes(ctx);
  return ctx.sql.query<ContentTypeRow>('SELECT * FROM manyfold_content_type ORDER BY created_at').map(rowToDef);
}

function getEntry(ctx: OperationContext, id: string): EntryRow {
  const row = ctx.sql.query<EntryRow>('SELECT * FROM manyfold_entry WHERE id = ?', [id])[0];
  if (!row) throw substratError('not_found', `entry not found: ${id}`);
  return row;
}

function currentDraft(ctx: OperationContext, entry: EntryRow): RevisionRow {
  return ctx.sql.query<RevisionRow>('SELECT * FROM manyfold_revision WHERE entry_id = ? AND rev_no = ?', [
    entry.id,
    entry.draft_rev,
  ])[0]!;
}

/** Title for delivery/listing: the type's titleField out of the body, else the slug/id. */
function titleOf(def: ContentTypeDef, body: Record<string, unknown>, entry: EntryRow): string {
  const t = body[def.titleField];
  return typeof t === 'string' && t.length > 0 ? t : (entry.slug ?? entry.id);
}

// Web Crypto (globalThis.crypto: same API in Node, Workers, browsers). Declared
// locally so it types under the worker lib set too — the engines' pattern.
declare const crypto: {
  subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> };
};

/** SHA-256 over (type, rev, canonical body) — Web Crypto, never node:crypto. */
async function contentHash(typeKey: string, revNo: number, bodyJson: string): Promise<string> {
  const data = new TextEncoder().encode(`${typeKey}:${revNo}:${bodyJson}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The declared machine, applied (#844).
 *
 * This replaced a `Record<EntryStatus, EntryStatus[]>` keyed by TARGET state. That
 * table could say `approved` may become `in_review`; it could not say which verb
 * does it, so the answer lived in whichever operation happened to pass that
 * target. Naming the operation makes the edge complete — and it is what lets a
 * guard, a diagram and the emitted `model.json` all read the same fact.
 *
 * It also threw a bare `new Error(...)`, so a 409 refusal reached the caller as a
 * 500. `assertTransition` puts this vertical on the platform's error contract.
 */
function transition(ctx: OperationContext, entry: EntryRow, operation: string, note?: string): void {
  const outcome = assertTransition(
    manyfoldLifecycles['manyfold-entry'],
    `${entry.type_key} entry`,
    entry.status,
    operation,
  );
  // Every caller here performs a move; `allow` entries never reach this function.
  if (outcome.kind !== 'transition') return;
  const to = outcome.to as EntryStatus;
  const now = ctx.now();
  ctx.sql.exec('UPDATE manyfold_entry SET status = ?, updated_at = ? WHERE id = ?', [to, now, entry.id]);
  ctx.sql.exec(
    'INSERT INTO manyfold_status_log (id, entry_id, from_status, to_status, actor, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [ulid(), entry.id, entry.status, to, ctx.principal, note ?? null, now],
  );
  entry.status = to;
}

/** Validate a body against its type; return the slug the slug-field carries (or null). */
function validateBody(def: ContentTypeDef, raw: unknown): { body: Record<string, unknown>; slug: string | null } {
  const body = buildBodySchema(def).parse(raw);
  const slug = def.slugField ? (body[def.slugField] as string | undefined) ?? null : null;
  return { body, slug };
}

function upsertDelivery(ctx: OperationContext, entry: EntryRow, rev: RevisionRow): void {
  const def = loadType(ctx, entry.type_key);
  const body = JSON.parse(rev.body_json) as Record<string, unknown>;
  ctx.sql.exec(
    `INSERT OR REPLACE INTO manyfold_delivery
       (entry_id, type_key, slug, rev_no, hash, body_json, title, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.id, entry.type_key, entry.slug, rev.rev_no, rev.hash!, rev.body_json, titleOf(def, body, entry), ctx.now()],
  );
}

function removeDelivery(ctx: OperationContext, entryId: string): void {
  ctx.sql.exec('DELETE FROM manyfold_delivery WHERE entry_id = ?', [entryId]);
}

// ── Authoring operations ────────────────────────────────────────────────────

const createEntryOp: OperationHandler<z.infer<typeof createEntryInput>, EntryRow> = async (ctx, raw) => {
  assertAllowed(await ctx.check(MF_PERM.author));
  const input = createEntryInput.parse(raw);
  const def = loadType(ctx, input.typeKey);
  const { body, slug } = validateBody(def, input.body);
  const id = ulid();
  const now = ctx.now();
  try {
    ctx.sql.exec(
      'INSERT INTO manyfold_entry (id, type_key, status, slug, draft_rev, published_rev, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, def.key, 'draft', slug, 1, null, now, now],
    );
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw conflict('slug_taken', `slug already in use for ${def.key}: ${slug}`);
    throw e;
  }
  ctx.sql.exec(
    'INSERT INTO manyfold_revision (id, entry_id, rev_no, body_json, hash, frozen, author, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
    [ulid(), id, 1, JSON.stringify(body), null, ctx.principal, now],
  );
  ctx.sql.exec(
    'INSERT INTO manyfold_status_log (id, entry_id, from_status, to_status, actor, note, at) VALUES (?, ?, NULL, ?, ?, NULL, ?)',
    [ulid(), id, 'draft', ctx.principal, now],
  );
  return getEntry(ctx, id);
};

const saveDraftOp: OperationHandler<z.infer<typeof saveDraftInput>, EntryRow> = async (ctx, raw) => {
  assertAllowed(await ctx.check(MF_PERM.author));
  const input = saveDraftInput.parse(raw);
  const entry = getEntry(ctx, input.entryId);
  if (entry.status !== 'draft' && entry.status !== 'unpublished') {
    throw conflict(
      'not_editable',
      `cannot edit: entry is '${entry.status}' — only draft or unpublished entries take new revisions`,
    );
  }
  const def = loadType(ctx, entry.type_key);
  const { body, slug } = validateBody(def, input.body);
  const revNo = entry.draft_rev + 1;
  const now = ctx.now();
  ctx.sql.exec(
    'INSERT INTO manyfold_revision (id, entry_id, rev_no, body_json, hash, frozen, author, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
    [ulid(), entry.id, revNo, JSON.stringify(body), null, ctx.principal, now],
  );
  ctx.sql.exec('UPDATE manyfold_entry SET draft_rev = ?, slug = ?, updated_at = ? WHERE id = ?', [
    revNo,
    slug,
    now,
    entry.id,
  ]);
  return getEntry(ctx, input.entryId);
};

const restoreRevisionOp: OperationHandler<z.infer<typeof restoreRevisionInput>, EntryRow> = async (ctx, raw) => {
  assertAllowed(await ctx.check(MF_PERM.author));
  const input = restoreRevisionInput.parse(raw);
  const entry = getEntry(ctx, input.entryId);
  if (entry.status !== 'draft' && entry.status !== 'unpublished') {
    throw conflict('not_restorable', `cannot restore: entry is '${entry.status}'`);
  }
  const src = ctx.sql.query<RevisionRow>('SELECT * FROM manyfold_revision WHERE entry_id = ? AND rev_no = ?', [
    entry.id,
    input.revNo,
  ])[0];
  if (!src) throw substratError('not_found', `revision not found: ${input.entryId}@${input.revNo}`);
  // A restore is a NEW revision copying the old body — never a mutation of history.
  const revNo = entry.draft_rev + 1;
  const now = ctx.now();
  ctx.sql.exec(
    'INSERT INTO manyfold_revision (id, entry_id, rev_no, body_json, hash, frozen, author, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
    [ulid(), entry.id, revNo, src.body_json, null, ctx.principal, now],
  );
  ctx.sql.exec('UPDATE manyfold_entry SET draft_rev = ?, updated_at = ? WHERE id = ?', [revNo, now, entry.id]);
  return getEntry(ctx, input.entryId);
};

const submitForReviewOp: OperationHandler<z.infer<typeof entryIdInput>, EntryRow> = async (ctx, raw) => {
  assertAllowed(await ctx.check(MF_PERM.author));
  const input = entryIdInput.parse(raw);
  const entry = getEntry(ctx, input.entryId);
  transition(ctx, entry, 'manyfold/submit-for-review');
  ctx.emit({ type: 'content.submitted', schemaVersion: 1, entity: entryRef(entry.id), piiClass: 'none', payload: { entryId: entry.id, typeKey: entry.type_key } });
  return getEntry(ctx, input.entryId);
};

const approveOp: OperationHandler<z.infer<typeof entryIdInput>, EntryRow> = async (ctx, raw) => {
  assertAllowed(await ctx.check(MF_PERM.review));
  const input = entryIdInput.parse(raw);
  const entry = getEntry(ctx, input.entryId);
  transition(ctx, entry, 'manyfold/approve');
  ctx.emit({ type: 'content.approved', schemaVersion: 1, entity: entryRef(entry.id), piiClass: 'none', payload: { entryId: entry.id, typeKey: entry.type_key } });
  return getEntry(ctx, input.entryId);
};

const rejectOp: OperationHandler<z.infer<typeof rejectInput>, EntryRow> = async (ctx, raw) => {
  assertAllowed(await ctx.check(MF_PERM.review));
  const { entryId, note } = rejectInput.parse(raw);
  const entry = getEntry(ctx, entryId);
  transition(ctx, entry, 'manyfold/reject', note);
  ctx.emit({ type: 'content.rejected', schemaVersion: 1, entity: entryRef(entry.id), piiClass: 'none', payload: { entryId: entry.id, typeKey: entry.type_key, note } });
  return getEntry(ctx, entryId);
};

const publishOp: OperationHandler<z.infer<typeof entryIdInput>, EntryRow> = async (ctx, raw) => {
  assertAllowed(await ctx.check(MF_PERM.publish));
  const input = entryIdInput.parse(raw);
  const entry = getEntry(ctx, input.entryId);
  // Checked before the freeze/hash work below, so a refusal costs nothing. The
  // legal source states come from the declaration, not from a second sentence.
  assertTransition(manyfoldLifecycles['manyfold-entry'], `${entry.type_key} entry`, entry.status, 'manyfold/publish');
  const rev = currentDraft(ctx, entry);
  const hash = await contentHash(entry.type_key, rev.rev_no, rev.body_json);
  // Freeze the revision: immutable-after-export. Any later edit targets a new revision.
  ctx.sql.exec('UPDATE manyfold_revision SET frozen = 1, hash = ? WHERE id = ?', [hash, rev.id]);
  ctx.sql.exec('UPDATE manyfold_entry SET published_rev = ? WHERE id = ?', [rev.rev_no, entry.id]);
  transition(ctx, entry, 'manyfold/publish');
  const frozen: RevisionRow = { ...rev, frozen: 1, hash };
  upsertDelivery(ctx, { ...entry, published_rev: rev.rev_no }, frozen);
  const body = JSON.parse(rev.body_json) as Record<string, unknown>;
  ctx.emit({
    type: 'content.published',
    schemaVersion: 1,
    entity: entryRef(entry.id),
    piiClass: 'none',
    payload: {
      entryId: entry.id,
      typeKey: entry.type_key,
      slug: entry.slug,
      revNo: rev.rev_no,
      hash,
      title: titleOf(loadType(ctx, entry.type_key), body, entry),
    },
  });
  return getEntry(ctx, input.entryId);
};

const unpublishOp: OperationHandler<z.infer<typeof entryIdInput>, EntryRow> = async (ctx, raw) => {
  assertAllowed(await ctx.check(MF_PERM.publish));
  const input = entryIdInput.parse(raw);
  const entry = getEntry(ctx, input.entryId);
  transition(ctx, entry, 'manyfold/unpublish');
  removeDelivery(ctx, entry.id);
  ctx.emit({ type: 'content.unpublished', schemaVersion: 1, entity: entryRef(entry.id), piiClass: 'none', payload: { entryId: entry.id, typeKey: entry.type_key } });
  return getEntry(ctx, input.entryId);
};

const archiveOp: OperationHandler<z.infer<typeof entryIdInput>, EntryRow> = async (ctx, raw) => {
  assertAllowed(await ctx.check(MF_PERM.publish));
  const input = entryIdInput.parse(raw);
  const entry = getEntry(ctx, input.entryId);
  transition(ctx, entry, 'manyfold/archive');
  removeDelivery(ctx, entry.id);
  ctx.emit({ type: 'content.archived', schemaVersion: 1, entity: entryRef(entry.id), piiClass: 'none', payload: { entryId: entry.id, typeKey: entry.type_key } });
  return getEntry(ctx, input.entryId);
};

// ── Read operations ─────────────────────────────────────────────────────────

interface EntryListItem {
  id: string;
  type_key: string;
  status: EntryStatus;
  slug: string | null;
  title: string;
  updated_at: string;
}

const listEntriesOp: OperationHandler<z.infer<typeof listEntriesInput> | undefined, EntryListItem[]> = async (
  ctx,
  raw,
) => {
  assertAllowed(await ctx.check(MF_PERM.read));
  const input = listEntriesInput.parse(raw ?? {});
  const where: string[] = [];
  const params: string[] = [];
  if (input.typeKey) {
    where.push('type_key = ?');
    params.push(input.typeKey);
  }
  if (input.status) {
    where.push('status = ?');
    params.push(input.status);
  }
  const rows = ctx.sql.query<EntryRow>(
    `SELECT * FROM manyfold_entry ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC`,
    params,
  );
  return rows.map((e) => {
    const def = loadType(ctx, e.type_key);
    const rev = currentDraft(ctx, e);
    const body = JSON.parse(rev.body_json) as Record<string, unknown>;
    return { id: e.id, type_key: e.type_key, status: e.status, slug: e.slug, title: titleOf(def, body, e), updated_at: e.updated_at };
  });
};

const reviewQueueOp: OperationHandler<undefined, EntryListItem[]> = async (ctx) => {
  assertAllowed(await ctx.check(MF_PERM.review));
  return listEntriesOp(ctx, { status: 'in_review' } as never) as never;
};

interface EntryDetail {
  entry: EntryRow;
  body: Record<string, unknown>;
  revisions: { rev_no: number; frozen: number; hash: string | null; author: string; created_at: string }[];
}

const getEntryOp: OperationHandler<z.infer<typeof entryIdInput>, EntryDetail> = async (ctx, raw) => {
  assertAllowed(await ctx.check(MF_PERM.read));
  const input = entryIdInput.parse(raw);
  const entry = getEntry(ctx, input.entryId);
  const rev = currentDraft(ctx, entry);
  const revisions = ctx.sql.query<RevisionRow>(
    'SELECT rev_no, frozen, hash, author, created_at FROM manyfold_revision WHERE entry_id = ? ORDER BY rev_no',
    [entry.id],
  );
  return {
    entry,
    body: JSON.parse(rev.body_json) as Record<string, unknown>,
    revisions: revisions.map((r) => ({ rev_no: r.rev_no, frozen: r.frozen, hash: r.hash, author: r.author, created_at: r.created_at })),
  };
};

const listTypesOp: OperationHandler<undefined, { def: ContentTypeDef; sql: string }[]> = async (ctx) => {
  assertAllowed(await ctx.check(MF_PERM.read));
  return loadTypes(ctx).map((def) => ({ def, sql: compileTypeToSql(def) }));
};

// ── Modelling: content types are data, authored by an admin ──────────────────

const fieldDefInput = z.object({
  type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  index: z.boolean().optional(),
  options: z.array(z.string()).optional(),
  target: z.string().optional(),
  source: z.string().optional(),
  maxLen: z.number().int().positive().optional(),
});

export const saveTypeInput = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, 'key must be lower_snake, starting with a letter'),
  title: z.string().min(1),
  titleField: z.string().min(1),
  slugField: z.string().optional(),
  fields: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]*$/, 'field names are lowerCamel'), fieldDefInput),
});

/**
 * Create or update a content type. Modelling is an ADMIN act. Every save bumps the type's
 * version (schema evolution = a new version; cms-content.md §5). The change is safe and
 * free here because Milestone A persists bodies as JSON — the compiled typed-table
 * migration (compileTypeToSql) is the reviewable artifact, not a live ALTER.
 */
const saveTypeOp: OperationHandler<z.infer<typeof saveTypeInput>, ContentTypeDef> = async (ctx, raw) => {
  assertAllowed(await ctx.check(MF_PERM.admin));
  ensureTypes(ctx);
  const input = saveTypeInput.parse(raw);
  if (!input.fields[input.titleField])
    throw substratError('validation_failed', `titleField '${input.titleField}' is not a field of ${input.key}`);
  if (input.slugField && !input.fields[input.slugField])
    throw substratError('validation_failed', `slugField '${input.slugField}' is not a field of ${input.key}`);
  for (const [name, f] of Object.entries(input.fields)) {
    if ((f.type === 'ref' || f.type === 'refMany') && !f.target)
      throw substratError('validation_failed', `field '${name}' is a ${f.type} but names no target type`);
  }
  const now = ctx.now();
  const existing = ctx.sql.query<{ version: number }>('SELECT version FROM manyfold_content_type WHERE key = ?', [input.key])[0];
  const version = existing ? existing.version + 1 : 1;
  ctx.sql.exec(
    `INSERT INTO manyfold_content_type (key, version, title, title_field, slug_field, fields_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       version = excluded.version, title = excluded.title, title_field = excluded.title_field,
       slug_field = excluded.slug_field, fields_json = excluded.fields_json, updated_at = excluded.updated_at`,
    [input.key, version, input.title, input.titleField, input.slugField ?? null, JSON.stringify(input.fields), now, now],
  );
  return loadType(ctx, input.key);
};

export const requestSiteInput = z.object({ slug: z.string().min(1), name: z.string().min(1) });

/**
 * Request a new SITE (multi-scope-manyfold.md M3). A tenant admin (`content:manage-sites`) asks the
 * platform to provision a sibling scope. The vertical cannot provision itself (sandbox-clean), so it
 * enqueues a `provision-sibling` platform intent (platform-intents.md) that the platform drains and
 * executes with its own authority — knowing the tenant inherently from this scope's DO. The new
 * site's owner is the requesting admin. Returns the request id so the caller can poll for the site.
 */
const requestSiteOp: OperationHandler<z.infer<typeof requestSiteInput>, { requestId: string }> = async (ctx, raw) => {
  assertAllowed(await ctx.check(MF_PERM.manageSites));
  const input = requestSiteInput.parse(raw);
  const requestId = ctx.requestPlatform({
    kind: PROVISION_SIBLING_KIND,
    payload: { slug: input.slug, name: input.name, owner: ctx.principal },
  });
  return { requestId };
};

export const archiveSiteInput = z.object({ scopeId: z.string().min(1) });

/**
 * Archive a site (multi-scope-manyfold.md). Admin-only (`content:manage-sites`). Like creation,
 * archiving a scope is a platform action the sandbox-clean vertical can't do itself, so it enqueues
 * an `archive-scope` platform intent naming the target; the platform verifies the target is this
 * tenant's own Manyfold scope and archives it. Returns the request id.
 */
const archiveSiteOp: OperationHandler<z.infer<typeof archiveSiteInput>, { requestId: string }> = async (ctx, raw) => {
  assertAllowed(await ctx.check(MF_PERM.manageSites));
  const input = archiveSiteInput.parse(raw);
  const requestId = ctx.requestPlatform({ kind: ARCHIVE_SCOPE_KIND, payload: { scopeId: input.scopeId } });
  return { requestId };
};

const deleteTypeOp: OperationHandler<z.infer<typeof deleteTypeInput>, { deleted: string }> = async (ctx, input) => {
  assertAllowed(await ctx.check(MF_PERM.admin));
  const { key } = deleteTypeInput.parse(input);
  const n = ctx.sql.query<{ n: number }>('SELECT COUNT(*) AS n FROM manyfold_entry WHERE type_key = ?', [key])[0]!.n;
  if (n > 0)
    throw conflict('in_use', `cannot delete type '${key}': ${n} entr${n === 1 ? 'y' : 'ies'} already use it`);
  ctx.sql.exec('DELETE FROM manyfold_content_type WHERE key = ?', [key]);
  return { deleted: key };
};

// ── Delivery surface (published, frozen content; references resolved) ────────

type Resolved = { $ref: string; type: string; slug: string | null; title: string } | { $unresolved: true; reason: string; id: string };

function resolveRef(ctx: OperationContext, target: string, id: string): Resolved {
  const row = ctx.sql.query<DeliveryRow>('SELECT * FROM manyfold_delivery WHERE entry_id = ?', [id])[0];
  if (!row) return { $unresolved: true, reason: 'not_published', id };
  return { $ref: id, type: target, slug: row.slug, title: row.title };
}

interface DeliveryPayload {
  type: string;
  slug: string | null;
  hash: string;
  publishedAt: string;
  body: Record<string, unknown>;
}

const deliverOp: OperationHandler<z.infer<typeof deliverInput>, DeliveryPayload> = async (ctx, raw) => {
  assertAllowed(await ctx.check(MF_PERM.read));
  const input = deliverInput.parse(raw);
  const def = loadType(ctx, input.typeKey);
  const row = ctx.sql.query<DeliveryRow>('SELECT * FROM manyfold_delivery WHERE type_key = ? AND slug = ?', [
    input.typeKey,
    input.slug,
  ])[0];
  // 404, and it used to be a 409 — `not published` sat in an app-level pattern list
  // that meant "conflict", so the public delivery read of a slug nobody published
  // answered as though the request fought the entry's state. It does not exist yet.
  if (!row) throw substratError('not_found', `not published: ${input.typeKey}/${input.slug}`);
  const body = JSON.parse(row.body_json) as Record<string, unknown>;
  // Resolve reference fields against the published projection — a draft/archived
  // target comes back as an explicit unresolved marker, a broken link shown honestly.
  for (const ref of referenceFields(def)) {
    const val = body[ref.name];
    if (ref.many && Array.isArray(val)) {
      body[ref.name] = val.map((id) => resolveRef(ctx, ref.target, String(id)));
    } else if (!ref.many && typeof val === 'string') {
      body[ref.name] = resolveRef(ctx, ref.target, val);
    }
  }
  return { type: row.type_key, slug: row.slug, hash: row.hash, publishedAt: row.published_at, body };
};

const listDeliveryOp: OperationHandler<z.infer<typeof listDeliveryInput> | undefined, { type_key: string; slug: string | null; title: string; hash: string }[]> = async (
  ctx,
  raw,
) => {
  assertAllowed(await ctx.check(MF_PERM.read));
  const input = listDeliveryInput.parse(raw ?? {});
  const rows = input.typeKey
    ? ctx.sql.query<DeliveryRow>('SELECT * FROM manyfold_delivery WHERE type_key = ? ORDER BY published_at DESC', [input.typeKey])
    : ctx.sql.query<DeliveryRow>('SELECT * FROM manyfold_delivery ORDER BY published_at DESC');
  return rows.map((r) => ({ type_key: r.type_key, slug: r.slug, title: r.title, hash: r.hash }));
};

/** Self-introspection: who am I in THIS site, and what may I do — the app gates its chrome on this. */
const whoamiOp: OperationHandler<undefined, { principal: string; can: Record<string, boolean> }> = async (ctx) => {
  assertAllowed(await ctx.check(MF_PERM.read));
  return {
    principal: ctx.principal,
    can: {
      read: true,
      author: (await ctx.check(MF_PERM.author)).allowed,
      review: (await ctx.check(MF_PERM.review)).allowed,
      publish: (await ctx.check(MF_PERM.publish)).allowed,
      admin: (await ctx.check(MF_PERM.admin)).allowed,
    },
  };
};

/**
 * #800. This was the fifth hand-rolled copy of the spine read, and the only
 * UNPAGED one — an entry edited fifty times answered with fifty rows because
 * nothing said a number. `readTimeline` pages it, which makes this the one paged
 * read in a vertical that predates #811; the rest of Manyfold's lists are still
 * unbounded, and that is a separate debt rather than something to half-fix here.
 */
const timelineOp: OperationHandler<
  z.infer<typeof timelineInput> & ListPage,
  Page<TimelineEntry>
> = async (ctx, input) => {
  const entity = timelineInput.parse(input);
  assertAllowed(await ctx.check(MF_PERM.read));
  return readTimeline(ctx, entity, input);
};

const OPERATIONS = {
  'manyfold/create-entry': createEntryOp as never,
  'manyfold/save-draft': saveDraftOp as never,
  'manyfold/restore-revision': restoreRevisionOp as never,
  'manyfold/submit-for-review': submitForReviewOp as never,
  'manyfold/approve': approveOp as never,
  'manyfold/reject': rejectOp as never,
  'manyfold/publish': publishOp as never,
  'manyfold/unpublish': unpublishOp as never,
  'manyfold/archive': archiveOp as never,
  'manyfold/list-entries': listEntriesOp as never,
  'manyfold/review-queue': reviewQueueOp as never,
  'manyfold/get-entry': getEntryOp as never,
  'manyfold/list-types': listTypesOp as never,
  'manyfold/save-type': saveTypeOp as never,
  'manyfold/delete-type': deleteTypeOp as never,
  'manyfold/request-site': requestSiteOp as never,
  'manyfold/archive-site': archiveSiteOp as never,
  'manyfold/deliver': deliverOp as never,
  'manyfold/list-delivery': listDeliveryOp as never,
  'manyfold/whoami': whoamiOp as never,
  'manyfold/timeline': timelineOp as never,
};

/**
 * The entry's editorial lifecycle, declared (#844).
 *
 * A **vertical-owned** machine: there is no engine lifecycle beneath it to
 * refine, which is why it declares states outright rather than substates. The
 * format permits that deliberately — not every machine belongs to an engine.
 *
 * Every non-terminal state can be archived, so `manyfold/archive` appears on
 * five of the six. That repetition is the honest shape: an edge per source
 * state is what a reviewer needs to see, and collapsing it into a wildcard would
 * hide which states an entry can leave.
 */
export const manyfoldLifecycles = defineLifecycles(
  manyfoldEntities,
  OPERATIONS,
)({
  'manyfold-entry': {
    field: 'status',
    initial: 'draft',
    states: {
      draft: {
        on: { 'manyfold/submit-for-review': 'in_review', 'manyfold/archive': 'archived' },
      },
      in_review: {
        on: {
          'manyfold/approve': 'approved',
          'manyfold/reject': 'draft',
          'manyfold/archive': 'archived',
        },
      },
      approved: {
        on: {
          'manyfold/publish': 'published',
          'manyfold/submit-for-review': 'in_review',
          'manyfold/archive': 'archived',
        },
      },
      published: {
        on: { 'manyfold/unpublish': 'unpublished', 'manyfold/archive': 'archived' },
      },
      unpublished: {
        on: { 'manyfold/submit-for-review': 'in_review', 'manyfold/archive': 'archived' },
      },
      /** Terminal, and the only state an entry cannot leave. */
      archived: { terminal: true },
    },
  },
});

export const manyfoldModule: ModuleRegistration = {
  manifest: manyfoldManifest,
  migrations: manyfoldMigrations,
  operations: OPERATIONS,
};
