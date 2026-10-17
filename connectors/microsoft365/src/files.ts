/**
 * Documents in one Teams channel's folder (#2101) — event-dispatched writes, delta-synced reads.
 *
 * Every standard channel's Files tab is a folder in its team site's default document library. The
 * tenant grants this app the site (`Sites.Selected`); a **binding** narrows that to one folder for
 * one scope, and everything here stays inside it (`fence.ts`).
 *
 * - **The binding** (`bindMicrosoft365Scope`) names the folder by its drive path, resolves it to
 *   the folder's item id once, and keeps the id. From then on the folder is the id: renaming or
 *   moving the folder inside the library keeps the binding; deleting it, or moving it out of the
 *   library, makes the binding refuse ("folder missing") rather than fall back to the library root.
 * - **Writes** are the Scrive pattern: a vertical emits `MICROSOFT365_FILES_EVENT` naming
 *   attachments and a target, the dispatch reads them with `conn.openAttachment` and uploads them,
 *   and a ledger row keyed on the event id makes a redelivery skip what landed.
 * - **Reads** are a sync, the Planima pattern: module code cannot fetch, so the sweep follows the
 *   drive's `/delta` feed, keeps only what is in the folder, and lands each change through the
 *   vertical's own operation as the connection. Bytes land as attachments on the entity that
 *   operation names.
 *
 * **What is outside the folder is never kept.** Delta runs on the library root, so a pass sees
 * metadata of items the binding does not cover. Those are held in memory for the length of one
 * pass, to decide what is inside, and never written to connector state, a payload, a log line or
 * an error.
 */
import { z } from 'zod';
import {
  attachmentRecord,
  entityRef,
  scopeId as scopeIdSchema,
  substratError,
  tenantId as tenantIdSchema,
  type ConnectionId,
  type DomainEvent,
} from '@substrat-run/contracts';
import type { ConnectorHandler, ConnectorOptions, ScopeHost } from '@substrat-run/kernel';
import {
  MICROSOFT365_PROVIDER,
  nowOf,
  openMicrosoft365Connection,
  signedInGraph,
  signedInGraphWith,
  type Microsoft365Options,
} from './connection.js';
import { microsoft365Secret } from './credential.js';
import { fencedPath, fencedSegment } from './fence.js';
import { quickXorHash } from './quickxor.js';
import {
  GraphError,
  childrenOf,
  contentOf,
  deltaPage,
  folderAtPath,
  itemById,
  itemUnder,
  writeUnder,
  type DriveItem,
  type GraphClient,
} from './graph.js';

// ── the public contract ──────────────────────────────────────────────────────

/** The event a vertical emits to put files in its bound channel folder. */
export const MICROSOFT365_FILES_EVENT = 'microsoft365.channel-files-requested';

/** The most files one event may carry. */
export const MAX_FILES_PER_EVENT = 20;
/** The largest file either direction moves. A bigger one is refused on write, and lands without bytes on read. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/**
 * The most bytes one write event may move, all its files together. A dispatch holds one file at a
 * time, so this bounds how long a delivery runs, not its memory; the per-file cap bounds that.
 */
export const MAX_EVENT_BYTES = 100 * 1024 * 1024;

/**
 * The payload of {@link MICROSOFT365_FILES_EVENT}, as this connector reads it. A vertical builds
 * it with this schema; the dispatch parses it again with the same one.
 *
 * `conflict` is required: what happens when the name is taken is the vertical's choice, said in
 * the event, never a default. The attachments must belong to the entity the event names — the
 * delivery is the authority to read them, so no standing grant is needed and none is consulted.
 *
 * Each file states its `size` (the attachment record's), so the caps are checked before a byte is
 * read; the dispatch refuses a file whose attachment turns out to be another size.
 */
export const microsoft365FilesRequested = z.object({
  /** The folder under the channel folder to write into; `''` (the default) is the channel folder itself. */
  directory: z.string().default(''),
  files: z
    .array(
      z.object({
        attachmentId: z.string().min(1),
        /** The file's name in the channel. Defaults to the attachment's filename. */
        name: z.string().min(1).optional(),
        /** The attachment's size in bytes, as its record states it. */
        size: z.number().int().nonnegative().max(MAX_FILE_BYTES),
      }),
    )
    .min(1)
    .max(MAX_FILES_PER_EVENT)
    .refine((files) => files.reduce((n, f) => n + f.size, 0) <= MAX_EVENT_BYTES, {
      message: `the files come to more than ${MAX_EVENT_BYTES} bytes, the most one event may move`,
    }),
  conflict: z.enum(['replace', 'rename', 'fail']),
});
export type Microsoft365FilesRequested = z.input<typeof microsoft365FilesRequested>;

const commonChange = {
  connectionId: z.string().min(1),
  /** The drive item's id — the stable key. A path changes on a rename; this does not. */
  itemId: z.string().min(1),
  kind: z.enum(['file', 'folder']),
  /** Relative to the channel folder, `/`-joined. */
  path: z.string().min(1),
  name: z.string().min(1),
};

/**
 * What the sync lands through the binding's operation, one change per invoke — parsed with this
 * schema on the way out, so a vertical compiled against one version of the connector gets a throw
 * rather than a reshaped change from another.
 *
 * - `upsert`: the item exists in the folder, new or changed. `previousPath` is set when it moved or
 *   was renamed. For a file, `content` says whether bytes follow: `follows` means the operation
 *   should answer `{ entity }`, the attachment target the bytes land on, and a `content` change
 *   comes next. `unchanged` means only metadata moved; `too-large` means the file is over
 *   {@link MAX_FILE_BYTES} and its bytes are not brought in.
 * - `content`: the bytes landed as `attachment` on the entity the upsert named. `replaces` is the
 *   attachment the previous content landed as, if any — the vertical decides whether to keep it.
 * - `delete`: the item is gone from the folder — `deleted` in Teams, or `moved-out` of the folder
 *   (where it went is not said: outside the folder is not the binding's to report).
 */
export const microsoft365ChannelChange = z.discriminatedUnion('change', [
  z.object({
    change: z.literal('upsert'),
    ...commonChange,
    previousPath: z.string().nullable(),
    size: z.number().int().nonnegative().nullable(),
    contentType: z.string().nullable(),
    lastModifiedAt: z.string().nullable(),
    webUrl: z.string().nullable(),
    content: z.enum(['follows', 'unchanged', 'too-large']).nullable(),
  }),
  z.object({
    change: z.literal('content'),
    ...commonChange,
    attachment: attachmentRecord.pick({ id: true, filename: true, contentType: true, size: true, sha256: true }),
    replaces: z.string().nullable(),
  }),
  z.object({
    change: z.literal('delete'),
    ...commonChange,
    reason: z.enum(['deleted', 'moved-out']),
  }),
]);
export type Microsoft365ChannelChange = z.infer<typeof microsoft365ChannelChange>;

/** What the landing operation answers to an upsert whose content follows. Anything else is read as "no bytes". */
const upsertAnswer = z.object({ entity: entityRef.nullable().optional() }).passthrough();

// ── the binding ──────────────────────────────────────────────────────────────

const KEY = 'microsoft365:';
const BINDING_PREFIX = `${KEY}binding:`;
const bindingKey = (scope: string) => `${BINDING_PREFIX}${scope}`;
/** Per in-folder item. Keyed by the folder's id too, so re-binding to another folder starts clean. */
const itemPrefix = (b: Pick<Microsoft365Binding, 'scopeId' | 'folderItemId'>) => `${KEY}item:${b.scopeId}:${b.folderItemId}:`;
const writeKey = (eventId: string) => `${KEY}write:${eventId}`;

export interface Microsoft365Binding {
  scopeId: string;
  tenantId: string;
  vertical: string;
  /** The vertical's operation each change lands through, e.g. `'documents/land-channel-change'`. */
  operation: string;
  /** The permission that operation checks, held by the connection on the scope. */
  permission: string;
  /** The folder's drive path as it was bound, relative to the library root. */
  folder: string;
  driveId: string;
  /** The folder's item id — what the fence is anchored to from bind on. */
  folderItemId: string;
  boundAt: string;
  /** Where the next pass reads the change feed from; absent until the first full pass landed. */
  deltaLink?: string;
  /**
   * A pass in progress: the page to read next (`null` = the start of a full enumeration), saved
   * after every landed page, so a pass longer than one call — or one cut off by a crash — resumes
   * there instead of starting over.
   */
  pass?: SyncPass;
  lastSync?: { syncedAt: string; changes: number };
  /** Set when the folder is gone; the binding refuses until it is bound again. */
  folderMissing?: { since: string };
}

interface SyncPass {
  id: string;
  /** A full enumeration: what it never presents is gone, which is decided when it ends. */
  full: boolean;
  next: string | null;
  startedAt: string;
  changes: number;
}

interface ItemEntry {
  parentId: string;
  name: string;
  kind: 'file' | 'folder';
  path: string;
  cTag: string | null;
  eTag: string | null;
  attachmentId: string | null;
  /** The last pass that presented this item — how a full pass finds what it never saw. */
  seenIn?: string;
}

/**
 * Declare that a connection syncs one scope with one channel folder.
 *
 * Refuses a folder that does not resolve, an item that is not a folder, the library root, and a
 * connection that does not hold the operation's permission on the scope — so a sweep can never be
 * configured to read the folder and then fail to land it.
 */
export async function bindMicrosoft365Scope(
  host: ScopeHost,
  input: {
    connectionId: ConnectionId;
    tenantId: string;
    scopeId: string;
    vertical: string;
    operation: string;
    permission: string;
    folder: string;
  },
  options: Microsoft365Options,
): Promise<Microsoft365Binding> {
  const tenant = tenantIdSchema.parse(input.tenantId);
  const scope = scopeIdSchema.parse(input.scopeId);
  const segments = folderSegments(input.folder);
  const granted = await host.connectionGrantsInScope(tenant, scope);
  if (!granted.some((g) => g.connectionId === input.connectionId && g.permission === input.permission)) {
    throw new Error(
      `connection ${input.connectionId} does not hold '${input.permission}' on scope ${input.scopeId} — ` +
        `a sweep would read the folder and then fail to land it. Grant it first, then bind.`,
    );
  }
  const conn = await openMicrosoft365Connection(host.admin, options, {
    id: input.connectionId,
    tenantId: input.tenantId,
    vertical: input.vertical,
  });
  const client = await signedInGraph(conn, options);
  let folder: DriveItem;
  try {
    folder = await folderAtPath(client, conn.secret.siteUrl, segments);
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) {
      throw substratError('conflict', `no folder at '${segments.join('/')}' in the site's document library`);
    }
    throw e;
  }
  if (!folder.folder || folder.root) {
    throw substratError('conflict', `'${segments.join('/')}' is not a folder in the document library`);
  }
  const driveId = folder.parentReference?.driveId;
  if (!driveId) throw new Error('Graph did not say which drive the folder is in');

  const binding: Microsoft365Binding = {
    scopeId: input.scopeId,
    tenantId: input.tenantId,
    vertical: input.vertical,
    operation: input.operation,
    permission: input.permission,
    folder: segments.join('/'),
    driveId,
    folderItemId: folder.id,
    boundAt: nowOf(options).toISOString(),
  };
  // The same folder bound again keeps its cursor, so a re-bind does not re-land the folder.
  const prior = await readBinding(host, input.connectionId, input.scopeId);
  if (prior && prior.folderItemId === binding.folderItemId && prior.driveId === binding.driveId) {
    if (prior.deltaLink) binding.deltaLink = prior.deltaLink;
    if (prior.pass) binding.pass = prior.pass;
    if (prior.lastSync) binding.lastSync = prior.lastSync;
  }
  await host.admin.putConnectorState(input.connectionId, bindingKey(input.scopeId), binding);
  return binding;
}

/** A bound folder's drive path, held to the fence's grammar; never the library root. */
function folderSegments(folder: string): string[] {
  const trimmed = folder.replace(/^\/+|\/+$/g, '');
  if (!trimmed) throw substratError('validation_failed', 'a binding names a folder; the library root is not one');
  try {
    return fencedPath(trimmed);
  } catch (e) {
    throw substratError('validation_failed', e instanceof Error ? e.message : String(e));
  }
}

export async function listMicrosoft365Bindings(host: ScopeHost, connectionId: ConnectionId): Promise<Microsoft365Binding[]> {
  const rows = await host.admin.listConnectorState(connectionId, BINDING_PREFIX);
  return rows.filter((r) => r.value !== null && typeof r.value === 'object').map((r) => r.value as Microsoft365Binding);
}

/** Stop syncing a scope (a tombstone: connector state has no delete). */
export async function unbindMicrosoft365Scope(host: ScopeHost, connectionId: ConnectionId, scopeId: string): Promise<void> {
  await host.admin.putConnectorState(connectionId, bindingKey(scopeId), null);
}

async function readBinding(host: Pick<ScopeHost, 'admin'>, connectionId: string, scopeId: string) {
  const value = await host.admin.getConnectorState(connectionId as ConnectionId, bindingKey(scopeId));
  return value && typeof value === 'object' ? (value as Microsoft365Binding) : undefined;
}

// ── writes ───────────────────────────────────────────────────────────────────

/** The write ledger row for one event. `pending` is written before the first upload. */
interface WriteLedger {
  status: 'pending' | 'done';
  startedAt: string;
  files: { attachmentId: string; itemId: string; name: string }[];
}

/**
 * The dispatch: put each named attachment in the bound folder.
 *
 * **Idempotency.** A ledger row keyed on the event id is written `pending` before the first upload
 * and updated after each file, so a redelivery skips every file that landed. What remains is the
 * window between a successful upload and the ledger write after it:
 *
 * - `replace` re-uploads the same bytes over the same name — the same file either way.
 * - `fail` and `rename` upload with Graph's `fail`, so a retry meets the file its earlier attempt
 *   wrote as a conflict. On a redelivery (the row was already `pending`) a conflicting item is
 *   adopted as that attempt's only when it IS these bytes: THIS app created it, and its size and
 *   QuickXorHash are the attachment's. Anything else is a conflict — `fail` reports it, and
 *   `rename` moves on to its own name.
 * - `rename` never asks Graph to pick a name. On a conflict it writes `name (xxxxxxxx).ext`, the
 *   suffix derived from the event and the attachment, so a retry aims at the same second name and
 *   the adoption above applies to it too. Only if that name is also taken by something else does
 *   the write fail.
 *
 * The residual is the other direction: SharePoint rewrites some files as it stores them (Office
 * documents get their properties updated), so the item a lost answer left may no longer hash to
 * the bytes sent. Then `fail` reports a conflict and `rename` writes a second copy under its own
 * name. Adopting on anything weaker than the content would take another event's file instead.
 */
export function microsoft365FilesConnector(options: Microsoft365Options): ConnectorHandler {
  return async (ctx, event: DomainEvent) => {
    const payload = microsoft365FilesRequested.parse(event.payload);
    // The caps (in the parse, on the declared sizes) and the fence, before anything else: a refused
    // event costs no read, no Graph call and no ledger row.
    const directory = fencedPath(payload.directory, { allowEmpty: true });
    for (const f of payload.files) if (f.name !== undefined) fencedSegment(f.name);

    const conn = await ctx.connection(MICROSOFT365_PROVIDER);
    const binding = await readBinding(ctx, conn.id, ctx.scopeId);
    if (!binding) throw new Error(`no channel folder is bound for scope ${ctx.scopeId} on this connection`);
    if (binding.folderMissing) throw folderMissingError();

    const key = writeKey(event.id);
    const prior = (await ctx.admin.getConnectorState(conn.id, key)) as WriteLedger | undefined;
    if (prior?.status === 'done') return;
    const ledger: WriteLedger = prior ?? { status: 'pending', startedAt: nowOf(options).toISOString(), files: [] };
    if (!prior) await ctx.admin.putConnectorState(conn.id, key, ledger);
    const redelivery = prior !== undefined;

    const secret = microsoft365Secret.parse(conn.secret);
    const client = await signedInGraphWith(conn.fetch, secret, options);
    // One file at a time: opened, uploaded, recorded, and let go before the next is read, so a
    // delivery holds at most one file's bytes. The caps were checked on the declared sizes above;
    // a file refused here leaves the ones before it written, and the ledger says which.
    for (const f of payload.files) {
      if (ledger.files.some((done) => done.attachmentId === f.attachmentId)) continue;
      const opened = await conn.openAttachment(f.attachmentId);
      if (!opened) throw new Error(`attachment ${f.attachmentId} is not one this event's entity holds`);
      if (opened.record.size !== f.size || opened.body.byteLength !== f.size) {
        throw new Error(`attachment ${f.attachmentId} is not the ${f.size} bytes the event declared`);
      }
      const name = f.name ?? opened.record.filename;
      fencedSegment(name);
      const file = { name, body: opened.body, contentType: opened.contentType };
      const written = await writeOne(client, binding, {
        directory,
        file,
        conflict: payload.conflict,
        adopt: redelivery ? { clientId: secret.clientId, size: f.size, quickXorHash: quickXorHash(opened.body) } : null,
        suffix: await suffixOf(event.id, f.attachmentId),
      });
      ledger.files.push({ attachmentId: f.attachmentId, itemId: written.id, name: written.name ?? name });
      await ctx.admin.putConnectorState(conn.id, key, ledger);
    }
    await ctx.admin.putConnectorState(conn.id, key, { ...ledger, status: 'done' });
  };
}

async function writeOne(
  client: GraphClient,
  binding: Microsoft365Binding,
  w: {
    directory: string[];
    file: { name: string; body: Uint8Array; contentType: string };
    conflict: 'replace' | 'rename' | 'fail';
    adopt: { clientId: string; size: number; quickXorHash: string } | null;
    suffix: string;
  },
): Promise<DriveItem> {
  const attempt = async (name: string, conflict: 'replace' | 'fail') => {
    const segments = [...w.directory, name];
    try {
      return await writeUnder(client, {
        driveId: binding.driveId,
        parentId: binding.folderItemId,
        segments,
        body: w.file.body,
        contentType: w.file.contentType,
        conflict,
      });
    } catch (e) {
      if (e instanceof GraphError && e.status === 404) {
        throw new Error('Graph found no folder to write into — the channel folder, or a directory under it, does not exist');
      }
      if (!(e instanceof GraphError && e.status === 409) || !w.adopt) throw e;
      // A redelivery meeting a conflict: adopt the file only if it is these bytes, written by this app.
      const existing = await itemUnder(client, binding.driveId, binding.folderItemId, segments);
      const ours =
        existing.createdBy?.application?.id === w.adopt.clientId &&
        existing.size === w.adopt.size &&
        existing.file?.hashes?.quickXorHash === w.adopt.quickXorHash;
      if (ours) return existing;
      throw e;
    }
  };
  if (w.conflict === 'replace') return attempt(w.file.name, 'replace');
  if (w.conflict === 'fail') return attempt(w.file.name, 'fail');
  try {
    return await attempt(w.file.name, 'fail');
  } catch (e) {
    if (!(e instanceof GraphError && e.status === 409)) throw e;
    return attempt(withSuffix(w.file.name, w.suffix), 'fail');
  }
}

/** `report.pdf` + `1a2b3c4d` → `report (1a2b3c4d).pdf`. */
export function withSuffix(name: string, suffix: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${suffix})${name.slice(dot)}` : `${name} (${suffix})`;
}

async function suffixOf(eventId: string, attachmentId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${eventId}\n${attachmentId}`));
  return [...new Uint8Array(digest).slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const folderMissingError = () =>
  new Error('the bound channel folder no longer exists in the document library — bind the scope again');

/** Register the write dispatch on a host that runs it (self-host, the control plane). */
export function registerMicrosoft365FilesConnector(
  host: ScopeHost,
  options: Microsoft365Options & { id?: string; retry?: ConnectorOptions },
): void {
  host.registerConnector(options.id ?? MICROSOFT365_PROVIDER, MICROSOFT365_FILES_EVENT, microsoft365FilesConnector(options), {
    ...FILES_RETRY,
    ...options.retry,
    provider: MICROSOFT365_PROVIDER,
  });
}

/**
 * Register for ROUTING ONLY, on a CP-less host: the delivery becomes a `connector:microsoft365`
 * intent and the control plane, which holds the credential, runs the dispatch.
 */
export function declareMicrosoft365FilesConnector(
  host: ScopeHost,
  options: { id?: string; retry?: ConnectorOptions } = {},
): void {
  host.registerConnector(
    options.id ?? MICROSOFT365_PROVIDER,
    MICROSOFT365_FILES_EVENT,
    async () => {
      throw new Error('microsoft365: this host registered the connector for routing only — the dispatching host runs it');
    },
    { ...FILES_RETRY, ...options.retry, provider: MICROSOFT365_PROVIDER },
  );
}

const FILES_RETRY: ConnectorOptions = { maxAttempts: 8, baseDelayMs: 5_000, maxDelayMs: 900_000, timeoutMs: 120_000 };

// ── reads: the sync ──────────────────────────────────────────────────────────

export interface Microsoft365SyncResult {
  scopeId: string;
  /** Changes landed by this call. */
  changes: number;
  /** True when the pass is a full enumeration (no cursor yet, or Graph expired it). */
  full: boolean;
  /** Pages of the change feed this call read and landed. */
  pages: number;
  /** False when the pass stopped at its page budget; the next call resumes where it stopped. */
  complete: boolean;
}

/** How many pages of the change feed one call reads before it stops and leaves the rest to the next. */
export const SYNC_PAGES_PER_CALL = 20;

/**
 * Sync ONE bound scope: read the change feed a page at a time, keep what is in the folder, land
 * it, and save where the next page starts — so memory is one page (plus what the binding holds
 * about the folder), and a pass that is cut off resumes from the last landed page.
 *
 * Landing is **at least once**, keyed by `itemId`: a change is landed, then its bytes, then the
 * item state that says so, and a failure between those steps lands the change again on the next
 * call. A vertical's operation upserts by `itemId`, and may see an upsert, or a `content`, twice.
 */
export async function syncMicrosoft365Scope(
  host: ScopeHost,
  connectionId: ConnectionId,
  binding: Microsoft365Binding,
  options: Microsoft365Options & { maxPages?: number },
): Promise<Microsoft365SyncResult> {
  if (binding.folderMissing) throw folderMissingError();
  const conn = await openMicrosoft365Connection(host.admin, options, {
    id: connectionId,
    tenantId: binding.tenantId,
    vertical: binding.vertical,
  });
  const client = await signedInGraph(conn, options);
  let current = binding;
  const save = async (next: Microsoft365Binding) => {
    current = next;
    await host.admin.putConnectorState(connectionId, bindingKey(binding.scopeId), next);
  };

  // The folder first: gone (or no longer a folder in this drive) marks the binding and stops,
  // before the feed is read. Never a fall back to the library root.
  const markMissing = async (): Promise<never> => {
    await save({ ...current, folderMissing: { since: nowOf(options).toISOString() } });
    throw folderMissingError();
  };
  try {
    const folder = await itemById(client, binding.driveId, binding.folderItemId);
    if (!folder.folder || folder.deleted || folder.parentReference?.driveId !== binding.driveId) await markMissing();
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) await markMissing();
    throw e;
  }

  const prefix = itemPrefix(binding);
  const index = new Map<string, ItemEntry>();
  for (const row of await host.admin.listConnectorState(connectionId, prefix)) {
    if (row.value && typeof row.value === 'object') index.set(row.key.slice(prefix.length), row.value as ItemEntry);
  }
  const freshPass = (full: boolean, next: string | null): SyncPass => ({
    id: crypto.randomUUID(),
    full,
    next,
    startedAt: nowOf(options).toISOString(),
    changes: 0,
  });
  let pass = current.pass ?? freshPass(!current.deltaLink, current.deltaLink ?? null);

  const scopeRef = scopeIdSchema.parse(binding.scopeId);
  const scope = await host.getConnectorScope(connectionId, scopeRef);
  let attachments: Awaited<ReturnType<ScopeHost['getConnectorAttachments']>> | undefined;
  const base = { connectionId };
  const put = async (id: string, entry: ItemEntry | null) => {
    await host.admin.putConnectorState(connectionId, `${prefix}${id}`, entry);
    if (entry) index.set(id, entry);
    else index.delete(id);
  };
  const land = async (p: Planned) => {
    if (p.change === 'delete') {
      await scope.invoke(
        binding.operation,
        microsoft365ChannelChange.parse({ change: 'delete', ...base, itemId: p.id, kind: p.prior.kind, path: p.prior.path, name: p.prior.name, reason: p.reason }),
      );
      await put(p.id, null);
      return;
    }
    const item = p.item;
    const answer = await scope.invoke(
      binding.operation,
      microsoft365ChannelChange.parse({
        change: 'upsert',
        ...base,
        itemId: item.id,
        kind: p.entry.kind,
        path: p.entry.path,
        name: p.entry.name,
        previousPath: p.prior && p.prior.path !== p.entry.path ? p.prior.path : null,
        size: item.size ?? null,
        contentType: item.file?.mimeType ?? null,
        lastModifiedAt: item.lastModifiedDateTime ?? null,
        webUrl: item.webUrl ?? null,
        content: p.content,
      }),
    );
    const entry: ItemEntry = { ...p.entry, attachmentId: p.prior?.attachmentId ?? null, seenIn: pass.id };
    if (p.content === 'follows') {
      const target = upsertAnswer.safeParse(answer);
      if (target.success && target.data.entity) {
        const body = await contentOf(client, binding.driveId, item.id);
        attachments ??= await host.getConnectorAttachments(connectionId, scopeRef);
        const record = await attachments.upload({
          entity: target.data.entity,
          filename: p.entry.name,
          contentType: item.file?.mimeType ?? 'application/octet-stream',
          visibility: 'internal',
          body,
        });
        await scope.invoke(
          binding.operation,
          microsoft365ChannelChange.parse({
            change: 'content',
            ...base,
            itemId: item.id,
            kind: 'file',
            path: p.entry.path,
            name: p.entry.name,
            attachment: record,
            replaces: entry.attachmentId,
          }),
        );
        entry.attachmentId = record.id;
      }
    }
    await put(item.id, entry);
  };

  const maxPages = options.maxPages ?? SYNC_PAGES_PER_CALL;
  let pages = 0;
  let changes = 0;
  for (;;) {
    let page: Awaited<ReturnType<typeof deltaPage>>;
    try {
      page = await deltaPage(client, binding.driveId, pass.next);
    } catch (e) {
      // 410: Graph expired the cursor and asks for a resync — a full enumeration, compared against
      // what is held, so unchanged items land nothing and what it never presents lands as deleted.
      if (!(e instanceof GraphError && e.status === 410) || (pass.full && pass.next === null)) throw e;
      pass = freshPass(true, null);
      await save({ ...current, pass });
      continue;
    }

    // This page, and nothing past it. Items outside the folder live in this map for one page.
    const changed = new Map(page.items.map((i) => [i.id, i]));
    if (changed.get(binding.folderItemId)?.deleted) await markMissing();
    // A folder newly inside arrives without its descendants — moved in from outside, or met before
    // its children on a full pass. Read them, so the order of the feed never decides what lands.
    const fenced = fenceOf(binding.folderItemId, changed, index);
    const queue = [...changed.values()].filter((i) => i.folder && !i.deleted && !index.has(i.id) && fenced.inside(i.id));
    while (queue.length) {
      const f = queue.shift()!;
      for (const child of await childrenOf(client, binding.driveId, f.id)) {
        if (changed.has(child.id)) continue;
        changed.set(child.id, child);
        if (child.folder) queue.push(child);
      }
    }
    const fence = fenceOf(binding.folderItemId, changed, index);
    const plan = planChanges(binding.folderItemId, changed, index, fence);
    for (const p of plan) await land(p);
    changes += plan.length;
    // An item a full pass presents unchanged still has to be marked seen by it.
    if (pass.full) {
      for (const id of changed.keys()) {
        const entry = index.get(id);
        if (entry && entry.seenIn !== pass.id) await put(id, { ...entry, seenIn: pass.id });
      }
    }
    pages += 1;
    pass = { ...pass, changes: pass.changes + plan.length };

    if (page.delta) {
      if (pass.full) {
        // What the whole enumeration never presented is gone from the folder.
        const unseen = [...index.entries()]
          .filter(([, e]) => e.seenIn !== pass.id)
          .sort(([, a], [, b]) => b.path.split('/').length - a.path.split('/').length);
        for (const [id, prior] of unseen) await land({ change: 'delete', id, prior, reason: 'deleted' });
        changes += unseen.length;
        pass = { ...pass, changes: pass.changes + unseen.length };
      }
      const done: Microsoft365Binding = { ...current, deltaLink: page.delta, lastSync: { syncedAt: nowOf(options).toISOString(), changes: pass.changes } };
      delete done.pass;
      await save(done);
      return { scopeId: binding.scopeId, changes, full: pass.full, pages, complete: true };
    }
    if (!page.next) throw new GraphError(502, undefined, 'the change feed ended without a delta link');
    pass = { ...pass, next: page.next };
    await save({ ...current, pass });
    if (pages >= maxPages) return { scopeId: binding.scopeId, changes, full: pass.full, pages, complete: false };
  }
}

/**
 * Whether an item is inside the folder, by id: its parent chain — this page's items first, the
 * held state for items the page does not mention — reaches the folder's id. An item whose parent
 * is in neither is outside: if it is really inside, its parent is newly inside too, and reading
 * that parent's children (above) brings it in.
 */
function fenceOf(folderId: string, changed: Map<string, DriveItem>, index: Map<string, ItemEntry>) {
  const memo = new Map<string, boolean>();
  const parentOf = (id: string): string | null => {
    const c = changed.get(id);
    if (c) return c.deleted ? null : (c.parentReference?.id ?? null);
    return index.get(id)?.parentId ?? null;
  };
  const nameOf = (id: string): string | null => {
    const c = changed.get(id);
    return c ? (c.name ?? null) : (index.get(id)?.name ?? null);
  };
  const inside = (id: string): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const seen = new Set<string>();
    let at: string | null = id;
    let result = false;
    while (at && !seen.has(at)) {
      seen.add(at);
      const parent = parentOf(at);
      if (parent === folderId) {
        result = true;
        break;
      }
      at = parent;
    }
    memo.set(id, result);
    return result;
  };
  /**
   * The path under the folder, or `null` when a name on the way is missing or could not be a child
   * segment at all. Names SharePoint accepted are carried as they are: the write grammar is
   * stricter than SharePoint, and a tenant's file is not refused for a name it was allowed.
   */
  const pathOf = (id: string): string | null => {
    const names: string[] = [];
    let at: string | null = id;
    while (at && at !== folderId) {
      const name = nameOf(at);
      if (!name || name === '.' || name === '..' || name.includes('/')) return null;
      names.unshift(name);
      at = parentOf(at);
    }
    return names.join('/');
  };
  /** Why a held item left: it, or a folder above it, was deleted — or it was moved out. */
  const goneReason = (id: string): 'deleted' | 'moved-out' => {
    const seen = new Set<string>();
    let at: string | null = id;
    while (at && at !== folderId && !seen.has(at)) {
      seen.add(at);
      const c = changed.get(at);
      if (c?.deleted) return 'deleted';
      if (c) return 'moved-out';
      at = index.get(at)?.parentId ?? null;
    }
    return 'moved-out';
  };
  return { inside, pathOf, goneReason };
}

type Planned =
  | { change: 'delete'; id: string; prior: ItemEntry; reason: 'deleted' | 'moved-out'; content?: undefined }
  | { change: 'upsert'; item: DriveItem; entry: Omit<ItemEntry, 'attachmentId'>; prior: ItemEntry | undefined; content: 'follows' | 'unchanged' | 'too-large' | null };

function planChanges(
  folderId: string,
  changed: Map<string, DriveItem>,
  index: Map<string, ItemEntry>,
  fence: ReturnType<typeof fenceOf>,
): Planned[] {
  const deletes: (Planned & { change: 'delete' })[] = [];
  const upserts: (Planned & { change: 'upsert' })[] = [];
  const candidates = new Set<string>([...changed.keys(), ...index.keys()]);
  candidates.delete(folderId);
  for (const id of candidates) {
    const prior = index.get(id);
    const item = changed.get(id);
    const path = fence.inside(id) ? fence.pathOf(id) : null;
    if (path === null) {
      if (!prior) continue; // outside the folder, and never inside: not ours to see
      deletes.push({ change: 'delete', id, prior, reason: fence.goneReason(id) });
      continue;
    }
    // Inside, but the pass did not mention it: an ancestor moved or was renamed.
    const source: DriveItem | undefined =
      item ?? (prior ? { id, name: prior.name, ...(prior.kind === 'folder' ? { folder: {} } : { file: {} }), cTag: prior.cTag ?? undefined, eTag: prior.eTag ?? undefined } : undefined);
    if (!source) continue;
    const kind: 'file' | 'folder' = source.folder ? 'folder' : 'file';
    const entry = {
      parentId: (item?.parentReference?.id ?? prior?.parentId)!,
      name: source.name ?? prior?.name ?? '',
      kind,
      path,
      cTag: source.cTag ?? null,
      eTag: source.eTag ?? null,
    };
    const contentChanged = kind === 'file' && (!prior || prior.cTag !== entry.cTag);
    if (prior && prior.path === entry.path && prior.eTag === entry.eTag && !contentChanged) continue;
    const content =
      kind === 'folder' ? null : !contentChanged ? 'unchanged' : (source.size ?? 0) > MAX_FILE_BYTES ? 'too-large' : 'follows';
    upserts.push({ change: 'upsert', item: source, entry, prior, content });
  }
  const depth = (p: string) => p.split('/').length;
  deletes.sort((a, b) => depth(b.prior.path) - depth(a.prior.path));
  upserts.sort((a, b) => depth(a.entry.path) - depth(b.entry.path) || a.entry.path.localeCompare(b.entry.path));
  return [...deletes, ...upserts];
}

export interface Microsoft365SweepResult {
  found: number;
  synced: Microsoft365SyncResult[];
  failed: { scopeId: string; error: string }[];
}

/** Sync every scope bound on a connection. One scope failing never stops another. */
export async function sweepMicrosoft365Files(
  host: ScopeHost,
  connectionId: ConnectionId,
  options: Microsoft365Options,
): Promise<Microsoft365SweepResult> {
  const result: Microsoft365SweepResult = { found: 0, synced: [], failed: [] };
  for (const binding of await listMicrosoft365Bindings(host, connectionId)) {
    result.found += 1;
    try {
      result.synced.push(await syncMicrosoft365Scope(host, connectionId, binding, options));
    } catch (err) {
      result.failed.push({ scopeId: binding.scopeId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
