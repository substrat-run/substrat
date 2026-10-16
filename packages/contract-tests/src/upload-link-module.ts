/**
 * The fixture behind `uploadLinkContractSuite`: two attachment targets, one that declares
 * `uploadLinks` and one that does not, and operations shaped the way a vertical's would be.
 *
 * - `udoc` — takes upload links: at most 64 bytes, PDFs, plain text and any image. Written
 *   with `upl:write`, read with `upl:read`.
 * - `unote` — an attachment target that declares NO `uploadLinks`: the fail-closed half.
 * - `upic` — takes any image AND names `image/svg+xml` exactly: the deliberate twin of
 *   `udoc`'s `image/*`, which admits no SVG.
 * - `ufile` — takes the `text/*`, `application/*`, `unknown/*` and `multipart/*` families: what
 *   the active-type rule leaves out of each (`text/xsl`, `application/unknown`, `unknown/unknown`,
 *   `multipart/x-mixed-replace`).
 *
 * The `upl.poke` consumer tries to mint and to revoke a link, and writes down what it was
 * told: a consumer runs as the system actor, which holds no authorship to lend a file.
 *
 * `upl/mint` is deliberately UNGUARDED, like `cap/share`: the check under test lives inside
 * `ctx.attachments.mintUploadUrl`, and an operation-level check in front of it would only
 * prove the check. `upl/mint-locked` is the shape a vertical writes — its own entity lock
 * decided BEFORE the mint, which the platform does not re-run at redemption.
 */
import { errorCodeOf, moduleManifest, permissionKey, substratError, type EntityRef } from '@substrat-run/contracts';
import {
  type ConsumerHandler,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
  ulid,
} from '@substrat-run/kernel';
import { testOperations } from './test-operations.js';

export const UPL_READ = permissionKey.parse('upl:read');
export const UPL_WRITE = permissionKey.parse('upl:write');

/** `udoc`'s declared policy — the suite asserts against these numbers. */
export const UPL_MAX_BYTES = 64;
export const UPL_CONTENT_TYPES = ['application/pdf', 'text/plain', 'image/*'] as const;
/** `upic`'s: the family, and SVG by name. */
export const UPL_PIC_CONTENT_TYPES = ['image/*', 'image/svg+xml'] as const;
/** `ufile`'s: four families and nothing else. */
export const UPL_FILE_CONTENT_TYPES = ['text/*', 'application/*', 'unknown/*', 'multipart/*'] as const;

export const uploadLinkModManifest = moduleManifest.parse({
  id: '@test/upl',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'upl:read', description: 'read a document and its files' },
    { key: 'upl:write', description: 'attach a file to a document' },
  ],
  events: {
    emits: [
      { type: 'upl.leaked', schemaVersion: 1 },
      { type: 'upl.poke', schemaVersion: 1 },
      { type: 'attachment.added', schemaVersion: 1 },
      { type: 'attachment.removed', schemaVersion: 1 },
      { type: 'attachment.upload-link-minted', schemaVersion: 1 },
      { type: 'attachment.upload-link-redeemed', schemaVersion: 1 },
      { type: 'attachment.upload-link-revoked', schemaVersion: 1 },
    ],
    consumes: [{ type: 'upl.poke', schemaVersion: 1 }],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
  attachmentTargets: [
    {
      entityType: 'udoc',
      readPermission: 'upl:read',
      writePermission: 'upl:write',
      uploadLinks: { maxBytes: UPL_MAX_BYTES, contentTypes: [...UPL_CONTENT_TYPES] },
    },
    { entityType: 'unote', readPermission: 'upl:read', writePermission: 'upl:write' },
    {
      entityType: 'upic',
      readPermission: 'upl:read',
      writePermission: 'upl:write',
      uploadLinks: { maxBytes: UPL_MAX_BYTES, contentTypes: [...UPL_PIC_CONTENT_TYPES] },
    },
    {
      entityType: 'ufile',
      readPermission: 'upl:read',
      writePermission: 'upl:write',
      uploadLinks: { maxBytes: UPL_MAX_BYTES, contentTypes: [...UPL_FILE_CONTENT_TYPES] },
    },
  ],
  entitlementKey: 'upl',
});

type Mint = Parameters<OperationContext['attachments']['mintUploadUrl']>[0];
type Handler = OperationHandler<never, unknown>;

/** What the `upl.poke` consumer was told, as `code:reason` — or `done` if the verb went through. */
const outcomeOf = async (attempt: () => Promise<unknown>): Promise<string> => {
  try {
    await attempt();
    return 'done';
  } catch (e) {
    const reason = (e as { extensions?: { reason?: unknown } }).extensions?.reason;
    return `${errorCodeOf(e) ?? 'unknown'}:${typeof reason === 'string' ? reason : ''}`;
  }
};

export const uploadLinkMod: ModuleRegistration = {
  manifest: uploadLinkModManifest,
  migrations: [
    { version: '0001-init', sql: 'CREATE TABLE upl_locks (id TEXT PRIMARY KEY)' },
    {
      version: '0002-consumer-attempts',
      sql: 'CREATE TABLE upl_consumer_attempts (event_id TEXT NOT NULL, verb TEXT NOT NULL, outcome TEXT NOT NULL)',
    },
  ],
  ...testOperations({
    'upl/mint': ((ctx, input) => ctx.attachments.mintUploadUrl(input as Mint)) as Handler,
    // A vertical's own lock, decided before the mint.
    'upl/lock': ((ctx, input) => {
      ctx.sql.exec('INSERT OR IGNORE INTO upl_locks (id) VALUES (?)', [(input as { id: string }).id]);
      return { locked: true };
    }) as Handler,
    'upl/mint-locked': (async (ctx, input) => {
      const i = input as Mint;
      const locked = ctx.sql.query('SELECT 1 FROM upl_locks WHERE id = ?', [i.entity.entityId]);
      if (locked.length > 0) throw substratError('conflict', 'the document is locked');
      return ctx.attachments.mintUploadUrl(i);
    }) as Handler,
    'upl/revoke': (async (ctx, input) => {
      await ctx.attachments.revokeUploadLink((input as { id: string }).id);
      return { revoked: true };
    }) as Handler,
    'upl/list': ((ctx, input) =>
      ctx.attachments.uploadLinks(input as Parameters<OperationContext['attachments']['uploadLinks']>[0])) as Handler,
    // Mint, then put the link into an event payload — the tripwire must refuse it.
    'upl/mint-and-leak': (async (ctx, input) => {
      const minted = await ctx.attachments.mintUploadUrl(input as Mint);
      ctx.emit({
        type: 'upl.leaked',
        schemaVersion: 1,
        entity: (input as Mint).entity as EntityRef,
        piiClass: 'none',
        payload: { link: minted.path },
      });
      return { id: minted.id };
    }) as Handler,
    // The kernel's attachment and link events as stored, oldest first.
    'upl/events': ((ctx) =>
      ctx.sql.query(
        `SELECT type, entity_type, entity_id, actor, payload FROM _substrat_outbox
          WHERE type LIKE 'attachment.%' ORDER BY id`,
      )) as Handler,
    // Every stored upload-link row as text — what "the secret is stored nowhere" is checked against.
    'upl/dump': ((ctx) =>
      ctx.sql.query('SELECT * FROM _substrat_upload_links').map((r) => JSON.stringify(r))) as Handler,
    'upl/id': (() => ({ id: ulid() })) as Handler,
    // Hand a consumer an entity to mint for and an existing link to revoke.
    'upl/poke': ((ctx, input) => {
      const i = input as { entity: EntityRef; linkId: string };
      ctx.emit({ type: 'upl.poke', schemaVersion: 1, entity: i.entity, piiClass: 'none', payload: i });
      return { poked: true };
    }) as Handler,
    'upl/consumer-attempts': ((ctx) =>
      ctx.sql.query('SELECT verb, outcome FROM upl_consumer_attempts ORDER BY rowid')) as Handler,
  }),
  consumers: {
    // A consumer is the system actor: both verbs must refuse it, before anything is written.
    'upl.poke': (async (ctx, event) => {
      const { entity, linkId } = event.payload as { entity: EntityRef; linkId: string };
      const record = (verb: string, outcome: string) =>
        ctx.sql.exec('INSERT INTO upl_consumer_attempts (event_id, verb, outcome) VALUES (?, ?, ?)', [
          event.id,
          verb,
          outcome,
        ]);
      record('mint', await outcomeOf(() => ctx.attachments.mintUploadUrl({ entity })));
      record('revoke', await outcomeOf(() => ctx.attachments.revokeUploadLink(linkId)));
    }) as ConsumerHandler,
  },
};
