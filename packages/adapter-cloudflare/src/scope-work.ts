/**
 * Platform work inside a tenant's scope (#3316): the rows a scope object writes and reads, per
 * invocation, by ORIGIN — the vertical's own operation, or one of the platform's verbs (a preview
 * fork's load, a migration, a drain, a purge, a sweep…) running in the same object.
 *
 * Cloudflare bills SQLite rows per Durable Object object (`durableObjectsPeriodicGroups`), and an
 * object is a scope, so its analytics cannot tell a vertical's operation from the platform's work
 * in the same object. This counts what the object itself executed, from the runtime's own numbers:
 * each statement's cursor `rowsWritten`/`rowsRead`, read when the invocation ends, which are the
 * values Cloudflare bills (`SqlStorageCursor`: "the final value is used for SQL billing"). Nothing
 * is estimated, and nothing is written to SQL: the count leaves as one Analytics Engine point per
 * invocation, so measuring writes no rows.
 *
 * **Attribution.** Each RPC entry the scope DO declares in its origin table runs inside an
 * `AsyncLocalStorage` context of its own, so a statement belongs to the entry whose async context
 * ran it: a nested call (`importDumpChecked` → `importDump`), the serial queue (it chains on the
 * enqueuer's context) and work an entry left running after it returned all count to that entry,
 * and two RPCs interleaved across an await stay apart. Platform work an entry only TRIGGERS is
 * counted {@link ScopeWorkMeter.apart | apart} from it: the migration pass the first call after a
 * promote runs (`migration`), and a copy's capture ending before a write (`export`). The object's
 * constructor (the kernel DDL and migration bookkeeping every wake re-runs) is `wake`. A statement no
 * entry ran — a method the table does not name, or a runtime with no `AsyncLocalStorage` — is
 * `unattributed`, so the object's total is always whole and what this could not place is visible
 * rather than guessed.
 *
 * **What it does not see.** The KV API (`ctx.storage.get/put/delete/list`) and `setAlarm` are billed
 * as rows too but return no cursor; the scope DO uses them only for continuation positions, the
 * live-expiry alarm and the reap marker. Nor does it count its own read of the tenant a point names
 * (`uncounted`, until the scope is provisioned). The difference between Cloudflare's per-object
 * total and the sum of these points is those, plus whatever ran before this code was deployed.
 *
 * **Inside an operation**, rows the platform's machinery writes on the operation's behalf stay with
 * the operation, because they are in the operation's own statements: the write revision's bump, the
 * outbox event, and — while a preview is being forked off this object — the capture's trigger rows,
 * which SQLite counts in the cursor of the write that fired them.
 *
 * Whose each origin is — the tenant's usage or the platform's — is an owner decision (#3316); this
 * only names them.
 */
import { blankSqlComments, executableSqlStatements, piecesReproduce } from '@substrat-run/kernel';
import { ASYNC_LOCAL_STORAGE_GLOBAL } from './async-local-storage-global.js';
import type { AnalyticsEngineDatasetLike } from './connector-calls.js';

/**
 * The scope DO's RPC entries, by the origin they are counted under. The scope DO wraps each name
 * listed here when its class is defined, and a name it has no method for refuses the definition,
 * so a renamed entry cannot quietly fall to `unattributed`.
 *
 * `operation` is the vertical's own work as a person or a connection calls it; `schedule` and
 * `purge` are the vertical's declared schedules, which the platform's sweeper runs (`invoke` is
 * split between the three by its arguments, in the scope DO). `load` is any dump loaded INTO this
 * object — a preview fork's copy when the script is a preview, a restore or a carry when it is
 * live — and `export` is a dump read OFF it, the source side of a fork or a backup.
 */
export const SCOPE_WORK_ORIGINS = {
  operation: ['invoke'],
  request: ['admission', 'claimWireNonce', 'resolveProjectedIdentity', 'freshnessProbe', 'servesTenant', 'seatsTenant'],
  purge: ['runPurgeSweep'],
  live: ['fetch', 'alarm', 'webSocketMessage', 'webSocketClose', 'webSocketError'],
  migration: ['migrate', 'retryMigrations', 'migrationAttemptsOnInstance', 'migrationFailure', 'appliedMigrations', 'appliedMigrationsIfHeld'],
  rewind: ['rewindToBookmark', 'rewindProbe'],
  drain: [
    'undrainedEvents', 'undrainedEventsRead', 'undrainedEventsReadIfHeld', 'markEventsDrained', 'pruneDrainedEvents',
    'redrainEvents', 'redrainCount', 'redrainCountIfHeld', 'exportedEventsRead',
  ],
  executor: [
    'pendingExecutorDeliveries', 'pendingExecutorEvents', 'recordExecutorAttempt', 'executorAttempts', 'executorDeadLetters',
    'pendingPlatformRequests', 'platformRequestHistory', 'settlePlatformRequest', 'settlePlatformRequestWithEvent',
    'routeExecutorEventToPlatform', 'retryPlatformRequest', 'retryExecutorDelivery',
  ],
  'event-import': ['importApply', 'importCursorMove', 'importStateRead'],
  export: ['exportDump', 'exportDumpPage', 'exportDumpChanges', 'exportDumpStamped', 'endDumpCapture', 'estimateDump'],
  load: [
    'importDump', 'importDumpChecked', 'importDumpJudged', 'importDumpProjected', 'stageDumpPage', 'stageDumpChanges',
    'commitStagedDumpChecked', 'commitStagedDumpJudged', 'discardStagedDump', 'keptCopy', 'releaseKeptCopy',
    'discardKeptCopy', 'wipeCarried', 'loadMarker', 'markCopy', 'clearCopyMark', 'isCopy', 'isCleanRoomCopy',
  ],
  lifecycle: ['lifecycle', 'setLifecycle'],
  sweep: [
    'enqueueSweepRuns', 'sweepFenceFacts', 'orphanAttachmentsReply', 'orphanSweepLicenceReply', 'jobRunStartOrJoin',
    'jobRunById', 'jobRunInsert', 'jobRunsDue', 'jobRunsDueKeys', 'jobRunList', 'jobRunPatch', 'jobRunClaim', 'jobRunMiss',
    'jobRunBegin', 'jobStepBegin', 'jobStepRow', 'jobStepRecord', 'jobCommitPass', 'scheduleLastRun', 'recordScheduleRun',
    'systemScheduleState', 'switchSystemSchedules', 'switchHoldToken', 'switchHoldOn', 'switchHoldClaim', 'switchHoldJoin',
    'switchHoldYoungestMs', 'switchHoldArm', 'switchHoldDrop', 'switchHoldsAll', 'switchHoldClaims', 'switchHoldRelease',
  ],
  permissions: [
    'writeTuple', 'writeTupleAndAuditIntent', 'seatTuple', 'seatTuples', 'seatTuplesFor', 'grantEntityShape',
    'grantEntityShapeAndAuditIntent', 'grantEntityShapeOnce', 'topUpEntityGrantShapes', 'hasEffectiveRoleGrantFor',
    'revokeTuple', 'revokeTupleAndAuditIntent', 'setPermissionSource', 'applyProjection', 'applyProjectionReply',
    'applyJudgedProjectionReply', 'canAssignFor', 'assignScopeRoleBoundedFor', 'scopeRoleHoldersFor',
    'changeScopeRoleBoundedFor', 'revokeScopeRolesBoundedFor', 'reservedRoleRefusalFor', 'reservedRoleRefusalHere',
    'reservedGrantRefusalFor', 'reservedShapeRefusalFor', 'roleStateHere', 'reservationHere', 'reservedAmong',
    'hasSystemGrant', 'writeSystemGrant', 'writeSystemGrantAndAuditIntent', 'systemGrantsStatus', 'systemDoorState',
    'switchPeer', 'peerDoorState', 'peerCovers', 'peerGrantsStatus', 'principalHoldings', 'listConnectionGrants', 'exchangeCapability',
    'exchangeBecomeLinkById', 'mintBecomeCapabilityBoundedFor', 'mintBindLinkBoundedFor', 'unbindEntityHolderBoundedFor',
    'becomeLinkStatesFor', 'revokeBecomeCapabilityFor', 'mintBecomeCapability', 'mintBecomeCapabilityAndAuditIntent',
    'revokeCapabilityAsPlatform', 'listCapabilities',
  ],
  attachment: [
    'attachmentAdd', 'attachmentAddReply', 'attachmentList', 'attachmentListReply', 'attachmentRedeemUploadLinkReply',
    'uploadLinkInspectReply', 'downloadLinkResolveReply', 'attachmentAuthorize', 'attachmentAuthorizeReply',
    'systemAttachmentAuthorize', 'systemAttachmentAuthorizeReply', 'attachmentRemove', 'attachmentRemoveReply',
    'attachmentCheckWriteReply', 'attachmentSearch', 'attachmentTextSource', 'attachmentTextRecord',
    'attachmentTextBackfillStart', 'attachmentTextBackfillBatch', 'capabilityAttachmentList', 'capabilityAttachmentOpen',
    'capabilityAttachmentSearch', 'capabilityAttachmentRefuseWrite',
  ],
  erasure: ['redactSubject', 'readSubject'],
  observe: [
    'databaseSize', 'databaseSizeIfHeld', 'attachmentBytes', 'attachmentBytesIfHeld', 'facetEvents', 'facetEventsIfHeld',
    'eventCause', 'eventCauseIfHeld', 'eventEffects', 'eventEffectsIfHeld', 'invocationEvents', 'invocationEventsIfHeld',
    'deadLetters', 'deadLettersIfHeld', 'lifecycleFlow', 'lifecycleFlowIfHeld', 'operationSeries', 'operationSeriesIfHeld',
    'entityHistory', 'entityHistoryIfHeld', 'migrationBookmarks', 'migrationBookmarksIfHeld', 'introspectTables',
    'introspectTablesIfHeld', 'introspectTable', 'introspectTableIfHeld', 'introspectTableReply', 'introspectQuery',
    'introspectQueryIfHeld', 'introspectQueryReply', 'listDenials', 'listRefusals', 'summarizeDenials',
  ],
  reap: ['destroyStorage'],
} as const satisfies Record<string, readonly string[]>;

/**
 * An origin a scope object's rows are counted under: the table's, plus `schedule` (an `invoke` the
 * sweeper makes), `wake` (the constructor) and `unattributed` (what no entry ran).
 */
export type ScopeWorkOrigin = keyof typeof SCOPE_WORK_ORIGINS | 'schedule' | 'wake' | 'unattributed';

/**
 * Where each field lands in an Analytics Engine data point. **A published shape** — a reader
 * indexes into it by ordinal, as it does the router's and the connector calls' — so it only ever
 * GROWS: a new field takes the next ordinal, and no position is reordered, renamed or reused.
 * `absent` is what the position holds when the field is unknown.
 *
 * Its own dataset, never the router's or the connector calls': a point of this shape written
 * there would be counted as requests or calls by every read of them.
 *
 * `durable_object.id` is the object's id, the key Cloudflare's `durableObjectsPeriodicGroups`
 * reports `objectId` under, so these points join the billed per-object totals directly.
 */
export const SCOPE_WORK_DATA_POINT_LAYOUT = {
  indexes: [{ ordinal: 'index1', name: 'substrat.tenant.id', unit: null, absent: '' }],
  blobs: [
    { ordinal: 'blob1', name: 'substrat.vertical', unit: null, absent: '' },
    { ordinal: 'blob2', name: 'substrat.scope.id', unit: null, absent: '' },
    { ordinal: 'blob3', name: 'durable_object.id', unit: null, absent: '' },
    { ordinal: 'blob4', name: 'substrat.version.id', unit: null, absent: '' },
    { ordinal: 'blob5', name: 'substrat.deployment.kind', unit: null, absent: '' },
    { ordinal: 'blob6', name: 'substrat.scope_work.origin', unit: null, absent: '' },
    { ordinal: 'blob7', name: 'substrat.scope_work.entry', unit: null, absent: '' },
  ],
  doubles: [
    { ordinal: 'double1', name: 'db.rows_written', unit: '{row}', absent: 0 },
    { ordinal: 'double2', name: 'db.rows_read', unit: '{row}', absent: 0 },
    { ordinal: 'double3', name: 'db.statements', unit: '{statement}', absent: 0 },
  ],
} as const;

/** One invocation's count, as it leaves. */
export interface ScopeWorkRecord {
  readonly 'substrat.tenant.id': string | null;
  readonly 'substrat.vertical': string | null;
  readonly 'substrat.scope.id': string | null;
  readonly 'durable_object.id': string | null;
  readonly 'substrat.version.id': string | null;
  /** `live` (the serving script) or `preview` (a version's own script), as the upload said. */
  readonly 'substrat.deployment.kind': string | null;
  readonly 'substrat.scope_work.origin': ScopeWorkOrigin;
  /** The RPC entry, or `wake` / `ambient` for what no entry ran. */
  readonly 'substrat.scope_work.entry': string;
  readonly 'db.rows_written': number;
  readonly 'db.rows_read': number;
  readonly 'db.statements': number;
}

/** The data point a record becomes — built from {@link SCOPE_WORK_DATA_POINT_LAYOUT}. */
export function scopeWorkDataPoint(record: ScopeWorkRecord): { indexes: string[]; blobs: string[]; doubles: number[] } {
  const L = SCOPE_WORK_DATA_POINT_LAYOUT;
  return {
    indexes: L.indexes.map((f) => record[f.name] ?? f.absent),
    blobs: L.blobs.map((f) => record[f.name] ?? f.absent),
    doubles: L.doubles.map((f) => record[f.name] ?? f.absent),
  };
}

/** `AsyncLocalStorage`, typed structurally so this module imports no `node:*`. */
interface AsyncLocalStorageLike<T> {
  run<R>(store: T, fn: () => R): R;
  getStore(): T | undefined;
}
type AsyncLocalStorageClass = new <T>() => AsyncLocalStorageLike<T>;

export { ASYNC_LOCAL_STORAGE_GLOBAL };

/** The platform entry's class, else node's (`nodejs_compat`, the workerd test pool), else none. */
export function asyncLocalStorageClass(): AsyncLocalStorageClass | undefined {
  try {
    const published = (globalThis as unknown as Record<symbol, unknown>)[Symbol.for(ASYNC_LOCAL_STORAGE_GLOBAL)];
    if (typeof published === 'function') return published as AsyncLocalStorageClass;
    const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const mod = proc?.getBuiltinModule?.('node:async_hooks') as { AsyncLocalStorage?: unknown } | undefined;
    return typeof mod?.AsyncLocalStorage === 'function' ? (mod.AsyncLocalStorage as AsyncLocalStorageClass) : undefined;
  } catch {
    return undefined;
  }
}

/** What the meter needs of a cursor: the two billed counts, final once it is consumed. */
interface CountedCursor {
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

/** One invocation's open count. Cursors are summed when it ends, not per statement. */
interface Tally {
  readonly entry: string;
  readonly origin: ScopeWorkOrigin;
  cursors: CountedCursor[];
  /** Ended: a statement still arriving (work it left running) flushes on its own, after the turn. */
  closed: boolean;
  flushQueued: boolean;
}

/** Who this object is, as each point stamps it. Read when a point is written, never per statement. */
export interface ScopeWorkIdentity {
  /** The tenant the scope was provisioned for, or null while it is not. */
  tenant(): string | null;
  readonly vertical: string | null;
  readonly scopeId: string | null;
  readonly objectId: string | null;
  readonly versionId: string | null;
  readonly kind: string | null;
}

/**
 * The per-object meter. Hand {@link counting} the raw `SqlStorage` under every other wrapper, and run
 * each RPC entry through {@link run}. Every statement's cursor is kept on the tally of the entry whose
 * async context ran it, and summed when that entry ends — so the hot path is one context read and one
 * array push per statement.
 */
export class ScopeWorkMeter {
  private readonly context: AsyncLocalStorageLike<Tally> | undefined;
  /** What no entry ran: the constructor's work first (`wake`), then anything unattributed. */
  private ambient: Tally;
  private dropped = 0;
  /** Inside {@link uncounted}. */
  private paused = false;

  constructor(
    private readonly dataset: AnalyticsEngineDatasetLike,
    private readonly identity: ScopeWorkIdentity,
    Als: AsyncLocalStorageClass | undefined = asyncLocalStorageClass(),
  ) {
    // One storage per object, never shared: an RPC from one scope object to another in the same
    // isolate must not find the caller's tally.
    this.context = Als ? new Als<Tally>() : undefined;
    this.ambient = { entry: 'wake', origin: 'wake', cursors: [], closed: true, flushQueued: false };
  }

  /** Points a dataset refused, since the object woke. A refused write never fails the work. */
  get droppedPoints(): number {
    return this.dropped;
  }

  /**
   * `raw` with every `exec` counted. Everything else on it passes straight through.
   *
   * A call holding several statements is counted per statement: the runtime's cursor for such a
   * call reports the LAST statement's rows only, so the batch is run as the kernel's splitter cuts
   * it (`executableSqlStatements`, the boundaries `guardSpine` runs a schema change at), and only
   * when the pieces are the whole call (`piecesReproduce`). That is the batch's own behaviour: the
   * runtime runs a batch's statements in order, each to completion, keeping earlier writes when a
   * later statement fails, and binds parameters to the last statement only — so the earlier pieces
   * run unbound and are read to the end, and the last gets the caller's bindings and returns its
   * cursor. A batch that misplaced a parameter is still refused, in the runtime's per-statement
   * words. A call that does not split cleanly runs whole, as before, and counts its last statement.
   */
  counting(raw: SqlStorage): SqlStorage {
    const exec = (query: string, ...bindings: unknown[]) => {
      const pieces = this.paused ? null : this.batchOf(query);
      if (pieces) {
        for (let i = 0; i < pieces.length - 1; i++) {
          const earlier = raw.exec(pieces[i]!);
          for (const rows = earlier.raw(); !rows.next().done; );
          this.note(earlier);
        }
        query = pieces[pieces.length - 1]!;
      }
      const cursor = raw.exec(query, ...bindings);
      this.note(cursor);
      return cursor;
    };
    return new Proxy(raw, {
      get(target, prop) {
        if (prop === 'exec') return exec;
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  /** The batches this object has run, split once: a statement's text is almost always a constant. */
  private readonly batches = new Map<string, readonly string[] | null>();

  /** `query`'s statements when it holds more than one and they are the whole of it, else null. */
  private batchOf(query: string): readonly string[] | null {
    if (!query.includes(';')) return null;
    let pieces = this.batches.get(query);
    if (pieces === undefined) {
      const split = executableSqlStatements(query);
      pieces = split.length > 1 && piecesReproduce(blankSqlComments(query), split) ? split : null;
      if (this.batches.size >= 256) this.batches.clear();
      this.batches.set(query, pieces);
    }
    return pieces;
  }

  /**
   * Run one RPC entry under its own count. A call made while another entry's context is current is
   * part of that entry (a nested call), and runs uncounted here.
   */
  run<R>(entry: string, origin: ScopeWorkOrigin, fn: () => R): R {
    if (!this.context || this.context.getStore()) return fn();
    return this.counted(this.context, entry, origin, fn);
  }

  /**
   * Run platform work under its own count even when an entry's context is current: work an entry
   * TRIGGERS but that is not the entry's own — the migration pass the first invocation after a
   * promote runs, the copy bookkeeping before a write — so it is never billed as that entry.
   */
  apart<R>(entry: string, origin: ScopeWorkOrigin, fn: () => R): R {
    if (!this.context) return fn();
    return this.counted(this.context, entry, origin, fn);
  }

  private counted<R>(context: AsyncLocalStorageLike<Tally>, entry: string, origin: ScopeWorkOrigin, fn: () => R): R {
    const tally: Tally = { entry, origin, cursors: [], closed: false, flushQueued: false };
    return context.run(tally, () => {
      let result: R;
      try {
        result = fn();
      } catch (e) {
        this.end(tally);
        throw e;
      }
      if (isThenable(result)) {
        return result.then(
          (value) => {
            this.end(tally);
            return value;
          },
          (e: unknown) => {
            this.end(tally);
            throw e;
          },
        ) as R;
      }
      this.end(tally);
      return result;
    });
  }

  /**
   * Run `fn` with nothing counted: the meter's own read of who the object is. Without this the
   * read would land on a tally, and a point written for an unprovisioned scope would queue the
   * next read, forever.
   */
  uncounted<T>(fn: () => T): T {
    const was = this.paused;
    this.paused = true;
    try {
      return fn();
    } finally {
      this.paused = was;
    }
  }

  private note(cursor: CountedCursor): void {
    if (this.paused) return;
    const tally = this.context?.getStore() ?? this.ambient;
    tally.cursors.push(cursor);
    if (tally.closed && !tally.flushQueued) {
      tally.flushQueued = true;
      queueMicrotask(() => {
        tally.flushQueued = false;
        this.flush(tally);
        if (tally === this.ambient && tally.origin === 'wake') {
          this.ambient = { entry: 'ambient', origin: 'unattributed', cursors: [], closed: true, flushQueued: false };
        }
      });
    }
  }

  private end(tally: Tally): void {
    tally.closed = true;
    this.flush(tally);
  }

  /** Sum the tally's cursors into one point, and start it again empty. A point of no rows is not written. */
  private flush(tally: Tally): void {
    const cursors = tally.cursors;
    if (cursors.length === 0) return;
    tally.cursors = [];
    let written = 0;
    let read = 0;
    for (const c of cursors) {
      written += c.rowsWritten;
      read += c.rowsRead;
    }
    if (written === 0 && read === 0) return;
    try {
      const id = this.identity;
      this.dataset.writeDataPoint(
        scopeWorkDataPoint({
          'substrat.tenant.id': id.tenant(),
          'substrat.vertical': id.vertical,
          'substrat.scope.id': id.scopeId,
          'durable_object.id': id.objectId,
          'substrat.version.id': id.versionId,
          'substrat.deployment.kind': id.kind,
          'substrat.scope_work.origin': tally.origin,
          'substrat.scope_work.entry': tally.entry,
          'db.rows_written': written,
          'db.rows_read': read,
          'db.statements': cursors.length,
        }),
      );
    } catch {
      // Analytics Engine being unavailable is not a reason for the scope's work to fail.
      this.dropped += 1;
    }
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** How an entry's origin is decided: fixed, or from the call (`invoke`'s arguments). */
export type ScopeWorkClassifier = ScopeWorkOrigin | ((self: unknown, args: readonly unknown[]) => ScopeWorkOrigin);

/**
 * Wrap each entry `SCOPE_WORK_ORIGINS` names on `proto`, so a call runs through the instance's meter
 * — or straight through when the instance has none (no dataset bound). `classify` overrides an
 * entry's fixed origin. Refuses an entry `proto` has no method for: the table and the class are
 * held together at definition, where a rename is caught by the first test that defines the class.
 */
export function meterScopeWorkEntries(
  proto: object,
  meterOf: (self: unknown) => ScopeWorkMeter | undefined,
  classify: Readonly<Record<string, ScopeWorkClassifier>> = {},
): void {
  const target = proto as Record<string, unknown>;
  for (const [origin, entries] of Object.entries(SCOPE_WORK_ORIGINS) as [ScopeWorkOrigin, readonly string[]][]) {
    for (const entry of entries) {
      const method = target[entry];
      if (typeof method !== 'function') {
        throw new Error(`scope-work: SCOPE_WORK_ORIGINS names '${entry}', which the scope DO does not define`);
      }
      const decide = classify[entry] ?? origin;
      const original = method as (...args: unknown[]) => unknown;
      target[entry] = function meteredEntry(this: unknown, ...args: unknown[]): unknown {
        const meter = meterOf(this);
        if (!meter) return original.apply(this, args);
        const o = typeof decide === 'function' ? decide(this, args) : decide;
        return meter.run(entry, o, () => original.apply(this, args));
      };
    }
  }
}
