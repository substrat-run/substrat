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
import {
  FILE_SOURCE_MAX_FILES_PER_WRITE,
  FILE_SOURCE_MAX_FILE_BYTES,
  FILE_SOURCE_MAX_WRITE_BYTES,
  fileSourceChange,
  fileSourceUpsertAnswer,
  fileSourceWriteRequest,
  scopeId as scopeIdSchema,
  substratError,
  tenantId as tenantIdSchema,
  type ConnectionId,
  type DomainEvent,
  type FileSourceChange,
  type FileSourceWriteRequest,
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
  childrenPage,
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
export const MAX_FILES_PER_EVENT = FILE_SOURCE_MAX_FILES_PER_WRITE;
/** The largest file either direction moves. A bigger one is refused on write, and lands without bytes on read. */
export const MAX_FILE_BYTES = FILE_SOURCE_MAX_FILE_BYTES;
/** The most bytes one write event may move, all its files together. */
export const MAX_EVENT_BYTES = FILE_SOURCE_MAX_WRITE_BYTES;

/**
 * The payload of {@link MICROSOFT365_FILES_EVENT}: the provider-neutral {@link fileSourceWriteRequest},
 * under this connector's name. It is the same schema object, not a copy, so a vertical that built
 * its event against either name is read by the dispatch as written.
 */
export const microsoft365FilesRequested = fileSourceWriteRequest;
export type Microsoft365FilesRequested = FileSourceWriteRequest;

/**
 * What the sync lands through the binding's operation: the provider-neutral {@link fileSourceChange},
 * under this connector's name. `path` is relative to the channel folder; `deleted` is a deletion in
 * Teams. See the neutral schema for the change kinds and what each promises.
 */
export const microsoft365ChannelChange = fileSourceChange;
export type Microsoft365ChannelChange = FileSourceChange;

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
  /**
   * `unplaced` counts held items the last pass could not look up for a reason that will not pass
   * by itself (the drive refuses the item, or a folder above it): they are kept, never deleted, and
   * looked up again on later passes up to {@link MAX_UNPLACED_ATTEMPTS} times. A count only.
   */
  lastSync?: { syncedAt: string; changes: number; unplaced?: number };
  /** Set when the folder is gone; the binding refuses until it is bound again. */
  folderMissing?: { since: string };
}

interface SyncPass {
  id: string;
  /** A full enumeration: what it never presents may be gone, which is checked when it ends. */
  full: boolean;
  next: string | null;
  startedAt: string;
  changes: number;
  /**
   * The feed has been read to its end: held items it did not account for are being checked against
   * the drive, one by one, before anything about them lands. `deltaLink` is saved only once the
   * queue is empty. In-folder item ids only.
   */
  verify?: { deltaLink: string; queue: string[]; collectUnseen?: boolean; unplaced?: string[] };
  /**
   * Held items a page showed outside the folder without showing why: their new parent is in
   * neither the page nor the held state. It may be a folder a later page presents, so nothing lands
   * for them until the end of the pass checks them (`verify`). In-folder item ids only.
   */
  pending?: string[];
  /**
   * Folders newly inside whose children still have to be read — moved in from outside (the feed
   * presents a moved folder alone), or met before their children on a full pass. Read a page at a
   * time under the same budget as the feed; `next` is the head folder's next page. In-folder ids.
   */
  walk?: { queue: string[]; next: string | null };
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
  /** How many lookups of this item were refused in a way that does not pass by itself. */
  unplaced?: number;
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
  // The same folder bound again keeps its cursor, so a re-bind does not re-land the folder —
  // unless the drive refused lookups of items it holds. Then a re-bind is the operator's "try those
  // again": their refusal counts are cleared and the next pass re-reads the library in full, which
  // looks each of them up afresh. Unchanged items still land nothing.
  const prior = await readBinding(host, input.connectionId, input.scopeId);
  if (prior && prior.folderItemId === binding.folderItemId && prior.driveId === binding.driveId) {
    const prefix = itemPrefix(binding);
    const refused = (await host.admin.listConnectorState(input.connectionId, prefix)).filter(
      (r) => r.value && typeof r.value === 'object' && ((r.value as ItemEntry).unplaced ?? 0) > 0,
    );
    for (const r of refused) await host.admin.putConnectorState(input.connectionId, r.key, { ...(r.value as ItemEntry), unplaced: 0 });
    if (!refused.length) {
      if (prior.deltaLink) binding.deltaLink = prior.deltaLink;
      if (prior.pass) binding.pass = prior.pass;
    }
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
  /**
   * Set when the binding was unbound or bound again while this call ran: the call stopped without
   * writing the binding back, so the operator's change stands.
   */
  superseded?: true;
}

/** How many pages of the change feed one call reads before it stops and leaves the rest to the next. */
export const SYNC_PAGES_PER_CALL = 20;
/** How many items one call reads back from the drive to check an unaccounted-for held item. */
export const SYNC_VERIFY_PER_CALL = 50;
/**
 * How many passes look up a held item the drive keeps refusing (403, a folder above it that cannot
 * be read, a chain too deep) before they stop asking. The item stays held either way: a refusal is
 * not an answer about whether it exists.
 */
export const MAX_UNPLACED_ATTEMPTS = 3;
/**
 * A sync's per-request timeout: long enough for a file at {@link MAX_FILE_BYTES} to download. The
 * connection's 15-second default would time out on the same large file every pass, and the pass
 * would never get past it.
 */
export const SYNC_TIMEOUT_MS = 120_000;

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
  options: Microsoft365Options & { maxPages?: number; maxVerify?: number },
): Promise<Microsoft365SyncResult> {
  if (binding.folderMissing) throw folderMissingError();
  const timed = { ...options, timeoutMs: options.timeoutMs ?? SYNC_TIMEOUT_MS };
  const conn = await openMicrosoft365Connection(host.admin, timed, {
    id: connectionId,
    tenantId: binding.tenantId,
    vertical: binding.vertical,
  });
  const client = await signedInGraph(conn, timed);
  /**
   * Write the binding back — onto what is stored NOW, and only while it is still the binding this
   * call started from. An unbind or a re-bind that happened meanwhile wins: the call stops rather
   * than resurrect the folder the operator moved away from. `false` means it stopped.
   */
  const save = async (patch: Partial<Microsoft365Binding>, opts: { endPass?: boolean } = {}) => {
    const stored = await readBinding(host, connectionId, binding.scopeId);
    if (!stored || stored.boundAt !== binding.boundAt || stored.folderItemId !== binding.folderItemId) return false;
    const next: Microsoft365Binding = { ...stored, ...patch };
    if (opts.endPass) delete next.pass;
    await host.admin.putConnectorState(connectionId, bindingKey(binding.scopeId), next);
    return true;
  };
  const superseded = (pages: number, changes: number, full: boolean): Microsoft365SyncResult => ({
    scopeId: binding.scopeId,
    changes,
    full,
    pages,
    complete: false,
    superseded: true,
  });

  // The folder first: gone (or no longer a folder in this drive) marks the binding and stops,
  // before the feed is read. Never a fall back to the library root.
  const markMissing = async (): Promise<never> => {
    await save({ folderMissing: { since: nowOf(options).toISOString() } });
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
  let pass = binding.pass ?? freshPass(!binding.deltaLink, binding.deltaLink ?? null);

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
      const target = fileSourceUpsertAnswer.safeParse(answer);
      if (target.success && target.data.entity) {
        const body = await contentOf(client, binding.driveId, item.id, MAX_FILE_BYTES);
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

  /** Held items under `id`, by the held state, deepest first. */
  const heldUnder = (id: string): string[] => {
    const out: string[] = [];
    const walk = (parent: string) => {
      for (const [child, e] of index) {
        if (e.parentId !== parent) continue;
        walk(child);
        out.push(child);
      }
    };
    walk(id);
    return out;
  };

  /**
   * Where a held item the feed did not account for really is — asked of the drive, item by item,
   * up its parent chain until the chain reaches the folder, a held folder, or the library root.
   * Items read on the way that turn out to be outside are dropped with the answer; nothing about
   * them is kept. Only the item's OWN answer is a deletion — its 404/410, or its own deleted facet.
   * A folder above it that cannot be read says nothing about the item, and neither does any other
   * error: both are thrown, so the pass stops and deletes nothing it could not confirm.
   */
  let gets = 0;
  const locate = async (
    id: string,
    pending: ReadonlySet<string>,
  ): Promise<{ at: 'gone' } | { at: 'outside' } | { at: 'unplaced' } | { at: 'inside'; chain: DriveItem[] }> => {
    const chain: DriveItem[] = [];
    let at = id;
    for (let depth = 0; depth < 64; depth += 1) {
      let item: DriveItem;
      try {
        gets += 1;
        item = await itemById(client, binding.driveId, at);
      } catch (e) {
        if (!(e instanceof GraphError)) throw e;
        if (e.status === 404 || e.status === 410) return depth === 0 ? { at: 'gone' } : { at: 'unplaced' };
        // A refusal that will be the same next time: kept, set aside, and asked again later.
        if (e.status === 400 || e.status === 403) return { at: 'unplaced' };
        throw e; // 401, 429, 5xx: transient or the connection's — stop, delete nothing
      }
      if (item.deleted) return depth === 0 ? { at: 'gone' } : { at: 'unplaced' };
      if (item.parentReference?.driveId && item.parentReference.driveId !== binding.driveId) return { at: 'outside' };
      chain.push(item);
      const parent = item.parentReference?.id;
      if (!parent || item.root) return { at: 'outside' };
      if (parent === binding.folderItemId || (index.has(parent) && !pending.has(parent))) return { at: 'inside', chain };
      at = parent;
    }
    return { at: 'unplaced' }; // deeper than 64 folders
  };

  /**
   * Land what `changed` says, judged against the held state. A held item it shows outside without
   * showing why (its new parent is unknown here) is not landed as moved-out: it is returned to be
   * checked at the end of the pass, since a later page may present it inside. Folders it newly
   * brings inside are returned too, to have their children read.
   */
  const landChanges = async (changed: Map<string, DriveItem>) => {
    const deferred: string[] = [];
    const placed: string[] = [];
    const folders: string[] = [];
    const plan = planChanges(binding.folderItemId, changed, index, fenceOf(binding.folderItemId, changed, index)).filter((p) => {
      if (p.change === 'delete' && p.reason === 'moved-out') {
        deferred.push(p.id);
        return false;
      }
      return true;
    });
    for (const p of plan) {
      await land(p);
      if (p.change !== 'upsert') continue;
      placed.push(p.item.id);
      if (p.entry.kind === 'folder' && !p.prior) folders.push(p.item.id);
    }
    changes += plan.length;
    pass = { ...pass, changes: pass.changes + plan.length };
    return { deferred, placed, folders };
  };
  /** Fold one landing's leftovers into the pass: what to check later, and which folders to read. */
  const carry = (r: Awaited<ReturnType<typeof landChanges>>) => {
    const pending = new Set(pass.pending ?? []);
    for (const id of r.deferred) pending.add(id);
    for (const id of r.placed) pending.delete(id);
    const walk = pass.walk ?? { queue: [], next: null };
    pass = {
      ...pass,
      pending: [...pending],
      ...(r.folders.length || pass.walk ? { walk: { ...walk, queue: [...walk.queue, ...r.folders] } } : {}),
    };
    if (pass.verify) {
      const queue = pass.verify.queue.filter((id) => !r.placed.includes(id));
      for (const id of r.deferred) if (!queue.includes(id)) queue.push(id);
      pass = { ...pass, verify: { ...pass.verify, queue } };
    }
  };

  /** On a full pass, mark every held item `changed` presents as seen by it, changed or not. */
  const stamp = async (changed: Map<string, DriveItem>) => {
    if (!pass.full) return;
    for (const id of changed.keys()) {
      const entry = index.get(id);
      if (entry && entry.seenIn !== pass.id) await put(id, { ...entry, seenIn: pass.id });
    }
  };

  const maxPages = options.maxPages ?? SYNC_PAGES_PER_CALL;
  const maxVerify = options.maxVerify ?? SYNC_VERIFY_PER_CALL;
  let pages = 0;
  let changes = 0;
  const incomplete = (): Microsoft365SyncResult => ({ scopeId: binding.scopeId, changes, full: pass.full, pages, complete: false });
  // One bounded unit per turn — a page of a folder's children, one item checked, or a page of the
  // feed — each landed and saved before the next, so a call stops anywhere and the next resumes.
  for (;;) {
    if (pass.walk?.queue.length) {
      if (pages >= maxPages) return incomplete();
      const [folder, ...rest] = pass.walk.queue;
      let children: Awaited<ReturnType<typeof childrenPage>>;
      try {
        children = await childrenPage(client, binding.driveId, folder!, pass.walk.next);
      } catch (e) {
        // Gone since it was queued: the feed reports that on its own.
        if (!(e instanceof GraphError && e.status === 404)) throw e;
        children = { items: [], next: null };
      }
      pages += 1;
      const listed = new Map(children.items.map((i) => [i.id, i]));
      const r = await landChanges(listed);
      await stamp(listed);
      pass = { ...pass, walk: children.next ? { queue: [folder!, ...rest], next: children.next } : { queue: rest, next: null } };
      carry(r);
      if (!(await save({ pass }))) return superseded(pages, changes, pass.full);
      continue;
    }

    if (pass.verify?.collectUnseen) {
      // The feed and every walk it caused are done: what a full pass still has not presented is
      // checked with the rest. An enumeration spanning minutes can miss a live item.
      const unseen = [...index.entries()].filter(([, e]) => e.seenIn !== pass.id).map(([id]) => id);
      pass = { ...pass, verify: { deltaLink: pass.verify.deltaLink, queue: [...new Set([...pass.verify.queue, ...unseen])] } };
      if (!(await save({ pass }))) return superseded(pages, changes, pass.full);
    }
    if (pass.verify) {
      const { deltaLink } = pass.verify;
      // Deepest first: an item is answered before the folder that held it, and a folder's answer is
      // never taken for what it held (below).
      const depth = (id: string) => index.get(id)?.path.split('/').length ?? 0;
      const unplaced = new Set(pass.verify.unplaced ?? []);
      const askable = (id: string) => {
        const e = index.get(id);
        return e !== undefined && !unplaced.has(id) && (e.unplaced ?? 0) < MAX_UNPLACED_ATTEMPTS;
      };
      const queue = pass.verify.queue.filter(askable).sort((x, y) => depth(y) - depth(x));
      const next = (q: string[]) => ({ deltaLink, queue: q, ...(unplaced.size ? { unplaced: [...unplaced] } : {}) });
      if (!queue.length) {
        const stillUnplaced = [...index.values()].filter((e) => (e.unplaced ?? 0) > 0).length;
        const saved = await save(
          {
            deltaLink,
            lastSync: { syncedAt: nowOf(options).toISOString(), changes: pass.changes, ...(stillUnplaced ? { unplaced: stillUnplaced } : {}) },
          },
          { endPass: true },
        );
        if (!saved) return superseded(pages, changes, pass.full);
        return { scopeId: binding.scopeId, changes, full: pass.full, pages, complete: true };
      }
      if (gets >= maxVerify) {
        pass = { ...pass, verify: next(queue) };
        if (!(await save({ pass }))) return superseded(pages, changes, pass.full);
        return incomplete();
      }
      const id = queue[0]!;
      const found = await locate(id, new Set(queue));
      pass = { ...pass, verify: next(queue.slice(1)) };
      const held = index.get(id)!;
      if (found.at === 'unplaced') {
        // Not an answer about the item: kept, out of this pass so the pass can finish, and counted.
        unplaced.add(id);
        await put(id, { ...held, unplaced: (held.unplaced ?? 0) + 1 });
        pass = { ...pass, verify: next(queue.slice(1)) };
      } else if (found.at === 'inside') {
        // Still in the folder: the feed only failed to say so. Land it where it is, if that moved.
        if (held.unplaced) await put(id, { ...held, unplaced: 0 });
        carry(await landChanges(new Map(found.chain.map((i) => [i.id, i]))));
      } else {
        // A folder that is gone, or moved out, still held items: each is looked up on its own
        // first, and the folder is answered again after them. What it held is never deleted on its
        // word — the held tree is exactly what a missed enumeration leaves stale.
        // Only what can still be asked: an item set aside this pass, or refused too often, is never
        // asked again here, so waiting on it would ask the folder for ever.
        const under = heldUnder(id).filter(askable);
        if (under.length) {
          pass = { ...pass, verify: next([...new Set([...under, ...queue])]) };
        } else {
          // The folder lands on its own answer. Anything it still holds that no lookup could place
          // stays held — never deleted with it — and is asked again on a later pass, if any are left.
          const reason = found.at === 'gone' ? 'deleted' : 'moved-out';
          await land({ change: 'delete', id, prior: index.get(id)!, reason });
          changes += 1;
          pass = { ...pass, changes: pass.changes + 1 };
        }
      }
      if (!(await save({ pass }))) return superseded(pages, changes, pass.full);
      continue;
    }

    if (pages >= maxPages) return incomplete();
    let page: Awaited<ReturnType<typeof deltaPage>>;
    try {
      page = await deltaPage(client, binding.driveId, pass.next);
    } catch (e) {
      // 410: Graph expired the cursor and asks for a resync — a full enumeration, compared against
      // what is held, so unchanged items land nothing and what it never presents is checked.
      if (!(e instanceof GraphError && e.status === 410) || (pass.full && pass.next === null)) throw e;
      pass = freshPass(true, null);
      if (!(await save({ pass }))) return superseded(pages, changes, true);
      continue;
    }
    pages += 1;

    // This page, and nothing past it. Items outside the folder live in this map for one page.
    const changed = new Map(page.items.map((i) => [i.id, i]));
    if (changed.get(binding.folderItemId)?.deleted) await markMissing();
    carry(await landChanges(changed));
    await stamp(changed);

    if (page.delta) {
      // The end of the feed: what pages could not place is checked before anything lands for it,
      // and on a full pass so is whatever it never presented (collected once the walks are done).
      pass = { ...pass, pending: [], verify: { deltaLink: page.delta, queue: pass.pending ?? [], ...(pass.full ? { collectUnseen: true } : {}) } };
      if (!(await save({ pass }))) return superseded(pages, changes, pass.full);
      continue;
    }
    if (!page.next) throw new GraphError(502, undefined, 'the change feed ended without a delta link');
    pass = { ...pass, next: page.next };
    if (!(await save({ pass }))) return superseded(pages, changes, pass.full);
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
  return { inside, pathOf };
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
      // Deleted only on the item's OWN deleted facet. Anything else — moved somewhere this page
      // cannot place, or under a folder the page shows deleted — is 'moved-out' here, which the
      // caller never lands on a page's word: a later page may place it, and otherwise it is looked
      // up on its own at the end of the pass.
      deletes.push({ change: 'delete', id, prior, reason: item?.deleted ? 'deleted' : 'moved-out' });
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
    // A size Graph does not state is not taken as small: those bytes are not brought in either.
    const content =
      kind === 'folder'
        ? null
        : !contentChanged
          ? 'unchanged'
          : source.size === undefined || source.size > MAX_FILE_BYTES
            ? 'too-large'
            : 'follows';
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
