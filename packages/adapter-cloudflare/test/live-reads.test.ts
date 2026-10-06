/**
 * Live reads (#938) — the fan-out, and above all what it does NOT send.
 *
 * **The load-bearing test in this file is the negative one.** A live channel that
 * pushes a row the recipient may not read is a disclosure, and it is the kind no
 * ordinary test catches: everything a subscriber DOES receive is visible in the
 * assertion, and everything it should not receive is visible nowhere. So the suite is
 * built around a pair — one principal who may read the touched note and one who may
 * not — driven by the same write, on the same socket-accepting scope, in the same
 * moment. The second is the assertion; the first is what stops the second from being
 * vacuously true of an implementation that simply never sends anything.
 *
 * Mounted here and not in `contract-tests` deliberately: `SqliteScopeHost` declares
 * `liveReads?: never`, so there is no shared behaviour for a contract suite to assert.
 * The reasoning is on `ScopeHost.liveReads`, beside the `clock?: never` precedent.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  permissionKey,
  platformActorId,
  principalId,
  scopeId as scopeIdOf,
  tenantId as tenantIdOf,
} from '@substrat-run/contracts';
import {
  checkedWithin,
  LIVE_CLOSE,
  LIVE_SOCKETS_PER_PRINCIPAL,
  ulid,
  vouchedWithin,
  webCryptoSecretBox,
  type CheckedWithin,
  type LiveChange,
  type LiveFrame,
  type VouchedWithin,
} from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { LIVE_MODE_HEADER, O2O_HEADER, readSubscription } from '../src/live-reads.js';
import { warmControlPlane } from './do-warmup.js';

const staff = platformActorId.parse(ulid());
const t = tenantIdOf.parse(ulid());
const s = scopeIdOf.parse(ulid());
/** Holds `live:write` at the scope — the one who causes the change. */
const writer = principalId.parse(ulid());
/** Holds `live:read` narrowed to note A, and nothing else. */
const insider = principalId.parse(ulid());
/** Holds `live:read` narrowed to note B. Same key, same scope, different entity. */
const outsider = principalId.parse(ulid());
const READ = permissionKey.parse('live:read');
const WRITE = permissionKey.parse('live:write');

const NOTE_A = '01JLIVEA000000000000000001';
const NOTE_B = '01JLIVEB000000000000000002';
const LEDGER = '01JLIVEL000000000000000003';

/** A well-formed upgrade request, as a browser would send one. */
const upgrade = (extra?: Record<string, string>): Request =>
  new Request('https://vertical.test/live', {
    headers: {
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      ...extra,
    },
  });

/**
 * One connected subscriber, with every frame it has received so far.
 *
 * Frames accumulate into an array rather than being awaited one at a time, because the
 * question this suite asks most often is "how many did you get", and a helper that
 * waits for the next one can only ever answer "at least one".
 */
interface Watcher {
  readonly frames: LiveChange[];
  close(): void;
}

async function watch(host: CloudflareScopeHost, principal: typeof insider): Promise<Watcher> {
  const response = await host.liveReads.subscribe({
    tenantId: t,
    scopeId: s,
    principal,
    request: upgrade(),
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  expect(ws).not.toBeNull();
  const frames: LiveChange[] = [];
  ws!.accept();
  ws!.addEventListener('message', (event) => {
    const data = String((event as MessageEvent).data);
    if (data === 'pong') return;
    frames.push(JSON.parse(data) as LiveChange);
  });
  return {
    frames,
    close: () => {
      try {
        ws!.close(1000, 'test over');
      } catch {
        // Already closed; nothing to do.
      }
    },
  };
}

/**
 * Let anything the fan-out sent arrive.
 *
 * The fan-out is awaited inside the invoke, so by the time `invoke` resolves every
 * `send` has been called — but a `WebSocketPair` still delivers to the other end on a
 * later turn of the event loop. This yields long enough for that, and it is also what
 * gives the NEGATIVE assertions their teeth: "nothing arrived" is only worth asserting
 * after the same interval in which something did arrive for somebody else.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe('live reads: the permission filter (#938)', () => {
  let host: CloudflareScopeHost;
  const open: Watcher[] = [];

  beforeAll(async () => {
    await warmControlPlane(env.CONTROL_PLANE);
    host = new CloudflareScopeHost({
      scope: env.LIVE_SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'Live' });
    await host.admin.grantEntitlement(staff, t, 'live');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'live-vertical' });
    await host.admin.activateScope(staff, t, s);

    await host.admin.grant(staff, {
      principalId: writer,
      permission: WRITE,
      node: { tenantId: t, scopeId: s },
      grantedBy: writer,
    });
    // The writer also holds the READ key on both notes — not for its own sake (it
    // never subscribes) but because `ctx.revoke` is delegating: the revocation case
    // below needs a caller that could have made the grant it withdraws.
    for (const noteId of [NOTE_A, NOTE_B]) {
      await host.admin.grant(staff, {
        principalId: writer,
        permission: READ,
        node: { tenantId: t, scopeId: s },
        entity: { entityType: 'note', entityId: noteId },
        grantedBy: writer,
      });
    }
    // Two entity-narrowed read grants of the SAME key in the SAME scope. Everything
    // about these two principals is identical except which note they may read, so a
    // difference in what they receive can only have come from the per-entity walk.
    await host.admin.grant(staff, {
      principalId: insider,
      permission: READ,
      node: { tenantId: t, scopeId: s },
      entity: { entityType: 'note', entityId: NOTE_A },
      grantedBy: writer,
    });
    await host.admin.grant(staff, {
      principalId: outsider,
      permission: READ,
      node: { tenantId: t, scopeId: s },
      entity: { entityType: 'note', entityId: NOTE_B },
      grantedBy: writer,
    });
  });

  afterAll(async () => {
    for (const w of open) w.close();
    await host.close();
  });

  const touch = async (noteId: string): Promise<void> => {
    const stub = await host.getScope(writer, t, s);
    await stub.invoke('live/touch', { noteId });
  };

  /** The scope DO addressed directly, for the one RPC the host surface cannot reach without R2. */
  const attachmentDo = (): {
    attachmentAdd(
      record: Record<string, unknown>,
      principal: typeof writer,
      tenantId: typeof t,
      scopeId: typeof s,
    ): Promise<unknown>;
  } =>
    env.LIVE_SCOPE.get(env.LIVE_SCOPE.idFromName(s)) as unknown as ReturnType<typeof attachmentDo>;

  // -- THE NEGATIVE, first ---------------------------------------------------

  it('sends NOTHING to a subscriber who may not read the entity that changed', async () => {
    const seen = await watch(host, outsider);
    open.push(seen);

    await touch(NOTE_A);
    await settle();

    // Not "no frame about note A" — no frame AT ALL. A subscriber who may not read
    // the changed row must not learn that it exists, that it changed, or when.
    expect(seen.frames).toEqual([]);
  });

  it('sends nothing about an entity type no module declared watchable (fail closed)', async () => {
    const seen = await watch(host, insider);
    open.push(seen);

    const stub = await host.getScope(writer, t, s);
    await stub.invoke('live/touch-ledger', { ledgerId: LEDGER });
    await settle();

    // `insider` holds a read grant and is receiving frames about notes in the test
    // below, so this is not silence from a broken socket. `ledger` has no
    // `liveTargets` entry, and an undeclared entity type reaches nobody — including
    // somebody who would have passed a check, had one been declared to run.
    expect(seen.frames).toEqual([]);
  });

  // -- and the positive, which is what stops the negatives being vacuous ------

  it('sends a subscriber the change to an entity it may read', async () => {
    const seen = await watch(host, insider);
    open.push(seen);

    await touch(NOTE_A);
    await settle();

    expect(seen.frames).toHaveLength(1);
    expect(seen.frames[0]).toMatchObject({
      kind: 'change',
      type: 'live.note-touched',
      entityType: 'note',
      entityId: NOTE_A,
    });
    // An invalidation, not a payload: the client re-reads through the ordinary
    // operation, so nothing here may carry the row's contents.
    expect(seen.frames[0]).not.toHaveProperty('payload');
  });

  it('separates two subscribers on one write — the same key, different entities', async () => {
    const mayRead = await watch(host, insider);
    const mayNot = await watch(host, outsider);
    open.push(mayRead, mayNot);

    await touch(NOTE_A);
    await settle();

    // The whole property in one assertion: one write, one fan-out, two subscribers,
    // and the split is decided per entity rather than per scope or per key.
    expect(mayRead.frames.map((f) => f.entityId)).toEqual([NOTE_A]);
    expect(mayNot.frames).toEqual([]);

    // …and it is symmetric, which rules out "the first subscriber wins" and
    // "whoever was granted first wins" as explanations for the split above.
    await touch(NOTE_B);
    await settle();
    expect(mayRead.frames.map((f) => f.entityId)).toEqual([NOTE_A]);
    expect(mayNot.frames.map((f) => f.entityId)).toEqual([NOTE_B]);
  });

  it('announces a change that arrives through the ATTACHMENT door, not just an invoke', async () => {
    // Regression for the second committing path. `attachmentAdd` commits and emits
    // `attachment.added` about the entity, then drains — and for a while it did not
    // fan out, so a watcher of that entity missed one whole kind of change with no
    // error and no gap it could see. The fix is a shared settle step both doors take;
    // this is what proves the attachment door takes it.
    //
    // Driven as the DO's own RPC rather than through `host.attachments(…)`, because
    // the wiring under test is in the DO and the host surface would drag in the R2
    // plumbing — a fake bucket, a blob-store ledger — none of which decides whether a
    // committed event is announced. Bytes never reach the DO anyway; only this record does.
    const seen = await watch(host, insider);
    open.push(seen);

    await attachmentDo().attachmentAdd(
      {
        id: '01JLIVEATT0000000000000001',
        entity: { entityType: 'note', entityId: NOTE_A },
        filename: 'note.txt',
        contentType: 'text/plain',
        size: 3,
        sha256: 'a'.repeat(64),
        visibility: 'internal',
        createdBy: writer,
        createdAt: new Date().toISOString(),
      },
      writer,
      t,
      s,
    );
    await settle();

    expect(seen.frames.map((f) => f.type)).toEqual(['attachment.added']);
    expect(seen.frames[0]).toMatchObject({ entityType: 'note', entityId: NOTE_A });
  });

  it('applies the same permission filter to an attachment change', async () => {
    // …and the filter is not skipped on that path either: `outsider` may read note B,
    // so an attachment on note A reaches it no more than a touch of note A does.
    const seen = await watch(host, outsider);
    open.push(seen);

    await attachmentDo().attachmentAdd(
      {
        id: '01JLIVEATT0000000000000002',
        entity: { entityType: 'note', entityId: NOTE_A },
        filename: 'note2.txt',
        contentType: 'text/plain',
        size: 3,
        sha256: 'b'.repeat(64),
        visibility: 'internal',
        createdBy: writer,
        createdAt: new Date().toISOString(),
      },
      writer,
      t,
      s,
    );
    await settle();

    expect(seen.frames).toEqual([]);
  });

  it('stops sending when the grant behind the frames is revoked', async () => {
    const seen = await watch(host, insider);
    open.push(seen);

    await touch(NOTE_A);
    await settle();
    expect(seen.frames).toHaveLength(1);

    // A subscription is not an authorization. The check runs per frame, against live
    // tuple state — so authority that goes away mid-socket takes the frames with it,
    // which a check made once at subscribe time would not.
    const stub = await host.getScope(writer, t, s);
    await stub.invoke('live/unshare', { principal: insider, noteId: NOTE_A });

    await touch(NOTE_A);
    await settle();
    expect(seen.frames).toHaveLength(1); // still just the first one

    // Put it back, so the suite's other cases are unaffected by ordering.
    await host.admin.grant(staff, {
      principalId: insider,
      permission: READ,
      node: { tenantId: t, scopeId: s },
      entity: { entityType: 'note', entityId: NOTE_A },
      grantedBy: writer,
    });
  });
});

describe('live reads: narrowed within an entity (#1853)', () => {
  let host: CloudflareScopeHost;
  const sw = scopeIdOf.parse(ulid());
  /** Holds `live:read` on IN_F1 and IN_F2 — both notes, so only `within` can tell them apart. */
  const reader = principalId.parse(ulid());
  /** Holds nothing at all. What it hears, it hears because a vertical vouched for it. */
  const stranger = principalId.parse(ulid());
  const F1 = '01JLIVEF100000000000000001';
  const F2 = '01JLIVEF200000000000000002';
  const IN_F1 = '01JLIVEN100000000000000001';
  const IN_F2 = '01JLIVEN200000000000000002';
  const IN_BOTH = '01JLIVEN300000000000000003';
  const MOVED = '01JLIVEN400000000000000004';
  const folder = (entityId: string) => ({ entityType: 'folder', entityId });
  const vouched = (entityId: string) => vouchedWithin(folder(entityId), { because: 'test vouches' });
  const open: { close(): void }[] = [];

  async function watchWithin(
    principal: typeof reader,
    within: { entityType: string; entityId: string } | VouchedWithin,
  ): Promise<{ frames: LiveFrame[] }> {
    const response = await host.liveReads.subscribe({ tenantId: t, scopeId: sw, principal, request: upgrade(), within });
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    const frames: LiveFrame[] = [];
    ws.accept();
    ws.addEventListener('message', (event) => {
      const data = String((event as MessageEvent).data);
      if (data !== 'pong') frames.push(JSON.parse(data) as LiveFrame);
    });
    open.push({ close: () => ws.close(1000, 'test over') });
    return { frames };
  }

  const as = async (op: string, input: Record<string, unknown>) =>
    (await host.getScope(writer, t, sw)).invoke(op, input);

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.LIVE_SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    await host.provisionScope(staff, { tenantId: t, scopeId: sw, vertical: 'live-vertical' });
    await host.admin.activateScope(staff, t, sw);
    await host.admin.grant(staff, { principalId: writer, permission: WRITE, node: { tenantId: t, scopeId: sw }, grantedBy: writer });
    for (const noteId of [IN_F1, IN_F2]) {
      await host.admin.grant(staff, {
        principalId: reader,
        permission: READ,
        node: { tenantId: t, scopeId: sw },
        entity: { entityType: 'note', entityId: noteId },
        grantedBy: writer,
      });
    }
    await as('live/file', { noteId: IN_F1, folderId: F1 });
    await as('live/file', { noteId: IN_F2, folderId: F2 });
    // Two parent edges, as ticket0 gives a public message: one to its conversation, one
    // to the widget session that may see it.
    await as('live/file', { noteId: IN_BOTH, folderId: F1 });
    await as('live/file', { noteId: IN_BOTH, folderId: F2 });
    await as('live/file', { noteId: MOVED, folderId: F1 });
  });

  afterAll(async () => {
    for (const w of open) w.close();
    await host.close();
  });

  // -- narrowing: ANDed with the principal's own check ------------------------

  it('sends nothing about an entity outside the root, though the subscriber may read it', async () => {
    const seen = await watchWithin(reader, folder(F1));
    await as('live/touch', { noteId: IN_F2 });
    await settle();
    // `reader` holds `live:read` on IN_F2, so an unnarrowed feed would carry this frame.
    expect(seen.frames).toEqual([]);
  });

  it('sends a change beneath the root — the positive twin', async () => {
    const seen = await watchWithin(reader, folder(F1));
    await as('live/touch', { noteId: IN_F1 });
    await as('live/touch', { noteId: IN_F2 });
    await settle();
    expect(seen.frames).toHaveLength(1);
    expect(seen.frames[0]).toMatchObject({ kind: 'change', type: 'live.note-touched', entityType: 'note', entityId: IN_F1 });
  });

  it('treats the root itself as within', async () => {
    const seen = await watchWithin(reader, { entityType: 'note', entityId: IN_F1 });
    await as('live/touch', { noteId: IN_F1 });
    await as('live/touch', { noteId: IN_F2 });
    await settle();
    expect(seen.frames.map((f) => (f as LiveChange).entityId)).toEqual([IN_F1]);
  });

  it('never widens: a plain `within` still needs the principal to pass the check', async () => {
    // The stranger holds nothing, so a plain root changes nothing for it. Only the
    // vouched form below drops the check, and only by being asked for by name.
    const seen = await watchWithin(stranger, folder(F1));
    await as('live/touch', { noteId: IN_F1 });
    await settle();
    expect(seen.frames).toEqual([]);
  });

  // -- vouched: the walk is the whole filter, and the frame names nothing ------

  it('nudges a vouched subscriber about a change beneath its root, naming no entity', async () => {
    const seen = await watchWithin(stranger, vouched(F1));
    await as('live/touch', { noteId: IN_F1 });
    await settle();
    expect(seen.frames).toHaveLength(1);
    expect(Object.keys(seen.frames[0]!).sort()).toEqual(['at', 'id', 'kind']);
    expect(seen.frames[0]!.kind).toBe('nudge');
  });

  it('sends a vouched subscriber nothing from outside its root — the negative twin', async () => {
    const seen = await watchWithin(stranger, vouched(F1));
    await as('live/touch', { noteId: IN_F2 });
    await as('live/touch-ledger', { ledgerId: LEDGER });
    await settle();
    expect(seen.frames).toEqual([]);
  });

  it.each([
    ['a look-alike object', { entity: { entityType: 'folder', entityId: F1 }, because: 'trust me' }],
    ['a spread copy of a vouched value', { ...vouchedWithin({ entityType: 'folder', entityId: F1 }, { because: 'copied' }) }],
    ['a plain ref carrying a vouched flag', { entityType: 'folder', entityId: F1, vouched: 'trust me' }],
  ])('refuses %s — the replacing mode is reachable by vouchedWithin alone', async (_label, within) => {
    await expect(
      host.liveReads.subscribe({
        tenantId: t,
        scopeId: sw,
        principal: stranger,
        request: upgrade(),
        within: within as unknown as VouchedWithin,
      }),
    ).rejects.toThrow(/vouchedWithin/);
  });

  // -- more than one parent, and a move ---------------------------------------

  it('reaches every root a multi-parent entity sits under', async () => {
    const one = await watchWithin(stranger, vouched(F1));
    const two = await watchWithin(stranger, vouched(F2));
    await as('live/touch', { noteId: IN_BOTH });
    await settle();
    expect(one.frames).toHaveLength(1);
    expect(two.frames).toHaveLength(1);
  });

  it('follows a move: the old root stops hearing the moved row, the new one starts', async () => {
    const left = await watchWithin(stranger, vouched(F1));
    const joined = await watchWithin(stranger, vouched(F2));
    await as('live/touch', { noteId: MOVED });
    await settle();
    expect(left.frames).toHaveLength(1);
    expect(joined.frames).toEqual([]);

    // The move's own `entity.relinked` is walked against the state it committed, so it
    // already belongs to the new root and not the old one.
    await as('live/move', { noteId: MOVED, from: F1, to: F2 });
    await as('live/touch', { noteId: MOVED });
    await settle();
    expect(left.frames).toHaveLength(1);
    expect(joined.frames).toHaveLength(2);
  });
});

describe('live reads: a root the principal is checked on (#938)', () => {
  let host: CloudflareScopeHost;
  const sc = scopeIdOf.parse(ulid());
  /** Holds `live:read` on cabinet C1 — so on every folder shelved there — and on no note. */
  const reader = principalId.parse(ulid());
  /** Holds nothing. */
  const stranger = principalId.parse(ulid());
  const C1 = '01JLIVEC100000000000000001';
  const C2 = '01JLIVEC200000000000000002';
  const F1 = '01JLIVEG100000000000000001';
  const F2 = '01JLIVEG200000000000000002';
  const F3 = '01JLIVEG300000000000000003';
  const F_OUT = '01JLIVEG400000000000000004';
  const IN_F1 = '01JLIVEM100000000000000001';
  const IN_F1B = '01JLIVEM100000000000000002';
  const IN_F2 = '01JLIVEM200000000000000001';
  const IN_F3 = '01JLIVEM300000000000000001';
  const IN_OUT = '01JLIVEM400000000000000001';
  const checked = (folderId: string) => checkedWithin({ entityType: 'folder', entityId: folderId }, 'live:read');
  const open: { close(): void }[] = [];
  const scopeDo = () => env.LIVE_SCOPE.get(env.LIVE_SCOPE.idFromName(sc));

  interface CheckedWatcher {
    readonly frames: LiveFrame[];
    /** The close code the scope sent, once it has closed the socket. */
    closedWith: number | null;
  }

  /** `folderId` null: an unnarrowed feed. `expiresAt`: the session's end, as a vertical passes it. */
  async function watchChecked(
    principal: typeof reader,
    folderId: string | null,
    expiresAt?: string,
  ): Promise<CheckedWatcher> {
    const response = await host.liveReads.subscribe({
      tenantId: t,
      scopeId: sc,
      principal,
      request: upgrade(),
      ...(folderId === null ? {} : { within: checked(folderId) }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    const watcher: CheckedWatcher = { frames: [], closedWith: null };
    ws.accept();
    ws.addEventListener('message', (event) => {
      const data = String((event as MessageEvent).data);
      if (data !== 'pong') watcher.frames.push(JSON.parse(data) as LiveFrame);
    });
    ws.addEventListener('close', (event) => {
      watcher.closedWith = (event as CloseEvent).code;
    });
    open.push({
      close: () => {
        try {
          ws.close(1000, 'test over');
        } catch {
          // Already closed by the scope.
        }
      },
    });
    return watcher;
  }

  const as = async (op: string, input: Record<string, unknown>) =>
    (await host.getScope(writer, t, sc)).invoke(op, input);

  /**
   * Count the root checks the fan-out makes, from inside the DO, and optionally make
   * them throw. Every live-read context is built under the `live.subscribe` operation
   * name, so only those are wrapped: the writer's own invokes are untouched.
   */
  async function instrumentRootChecks(opts: {
    throws: boolean;
    /** Hold each check this long before answering — a pass whose clock moves under it. */
    delayMs?: number;
  }): Promise<{ calls(): Promise<number>; restore(): Promise<void> }> {
    await runInDurableObject(scopeDo(), (instance) => {
      const target = instance as unknown as {
        operationContext: (...args: unknown[]) => { check: (...a: unknown[]) => Promise<unknown> };
        __liveChecks?: number;
        __liveOriginal?: unknown;
      };
      const original = target.operationContext;
      target.__liveOriginal = original;
      target.__liveChecks = 0;
      target.operationContext = function (this: unknown, ...args: unknown[]) {
        const ctx = original.apply(this, args);
        if (args[8] !== 'live.subscribe') return ctx;
        return Object.create(ctx, {
          check: {
            value: async (...a: unknown[]) => {
              target.__liveChecks = (target.__liveChecks ?? 0) + 1;
              if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
              if (opts.throws) throw new Error('permission evaluator unavailable');
              return ctx.check(...a);
            },
          },
        });
      };
    });
    return {
      calls: () =>
        runInDurableObject(scopeDo(), (instance) => (instance as unknown as { __liveChecks: number }).__liveChecks),
      restore: () =>
        runInDurableObject(scopeDo(), (instance) => {
          const target = instance as unknown as { operationContext: unknown; __liveOriginal: unknown };
          target.operationContext = target.__liveOriginal;
        }),
    };
  }

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.LIVE_SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    await host.provisionScope(staff, { tenantId: t, scopeId: sc, vertical: 'live-vertical' });
    await host.admin.activateScope(staff, t, sc);
    await host.admin.grant(staff, { principalId: writer, permission: WRITE, node: { tenantId: t, scopeId: sc }, grantedBy: writer });
    // The writer holds the read on the cabinet too: `ctx.revoke` is delegating.
    for (const principal of [writer, reader]) {
      await host.admin.grant(staff, {
        principalId: principal,
        permission: READ,
        node: { tenantId: t, scopeId: sc },
        entity: { entityType: 'cabinet', entityId: C1 },
        grantedBy: writer,
      });
    }
    // F1, F2 and F3 are all in C1, so `reader` passes the gate on each: only the walk
    // can tell what is beneath one root from what is beneath another. F_OUT is in C2.
    for (const folderId of [F1, F2, F3]) await as('live/shelve', { folderId, cabinetId: C1 });
    await as('live/shelve', { folderId: F_OUT, cabinetId: C2 });
    await as('live/file', { noteId: IN_F1, folderId: F1 });
    await as('live/file', { noteId: IN_F1B, folderId: F1 });
    await as('live/file', { noteId: IN_F2, folderId: F2 });
    await as('live/file', { noteId: IN_F3, folderId: F3 });
    await as('live/file', { noteId: IN_OUT, folderId: F_OUT });
  });

  // Each case's sockets are closed after it, so a count of checks is about that case's
  // socket alone: the gate is asked once per OPEN socket per pass.
  afterEach(async () => {
    for (const w of open.splice(0)) w.close();
    await settle();
  });

  afterAll(async () => {
    await host.close();
  });

  // -- the handshake ------------------------------------------------------------

  it('refuses a subscriber who may not watch the root, before any socket exists', async () => {
    const response = await host.liveReads.subscribe({
      tenantId: t,
      scopeId: sc,
      principal: stranger,
      request: upgrade(),
      within: checked(F1),
    });
    expect(response.status).toBe(403);
    expect(response.headers.get(LIVE_MODE_HEADER)).toBe('forbidden');
    expect(response.webSocket).toBeNull();
  });

  it('refuses a root outside the grant, though the same principal may watch its neighbour', async () => {
    const response = await host.liveReads.subscribe({
      tenantId: t,
      scopeId: sc,
      principal: reader,
      request: upgrade(),
      within: checked(F_OUT),
    });
    expect(response.status).toBe(403);
    // The positive twin: the same principal, a root its grant reaches.
    const ok = await watchChecked(reader, F1);
    expect(ok.closedWith).toBeNull();
  });

  // -- what is sent -------------------------------------------------------------

  it('nudges about a row beneath the root, naming no entity — though the subscriber may not read the row', async () => {
    const seen = await watchChecked(reader, F1);
    await as('live/touch', { noteId: IN_F1 });
    await settle();
    expect(seen.frames).toHaveLength(1);
    expect(Object.keys(seen.frames[0]!).sort()).toEqual(['at', 'id', 'kind']);
    expect(seen.frames[0]!.kind).toBe('nudge');
  });

  it('sends nothing about a row outside the root, though the gate would pass on its folder too', async () => {
    const seen = await watchChecked(reader, F1);
    await as('live/touch', { noteId: IN_F2 });
    await as('live/touch-ledger', { ledgerId: LEDGER });
    await settle();
    expect(seen.frames).toEqual([]);
    expect(seen.closedWith).toBeNull();
  });

  // -- the gate on every pass -------------------------------------------------

  it('asks the gate once per socket per pass, and not at all on a pass with nothing beneath the root', async () => {
    const seen = await watchChecked(reader, F1);
    const checks = await instrumentRootChecks({ throws: false });
    try {
      await as('live/touch', { noteId: IN_F2 });
      await settle();
      expect(await checks.calls()).toBe(0);
      // Two rows beneath the root in one pass: two nudges, one check.
      await as('live/touch-each', { noteIds: [IN_F1, IN_F1B] });
      await settle();
      expect(await checks.calls()).toBe(1);
      expect(seen.frames).toHaveLength(2);
    } finally {
      await checks.restore();
    }
  });

  it('closes the socket and sends nothing when the gate throws', async () => {
    const seen = await watchChecked(reader, F1);
    const checks = await instrumentRootChecks({ throws: true });
    try {
      await as('live/touch', { noteId: IN_F1 });
      await settle();
    } finally {
      await checks.restore();
    }
    expect(await checks.calls()).toBe(1);
    expect(seen.frames).toEqual([]);
    expect(seen.closedWith).toBe(1008);
  });

  it('closes the socket and sends nothing once the grant behind the root is revoked', async () => {
    const seen = await watchChecked(reader, F1);
    await as('live/touch', { noteId: IN_F1 });
    await settle();
    expect(seen.frames).toHaveLength(1);

    await as('live/unshare', { principal: reader, noteId: C1, entityType: 'cabinet' });
    try {
      await as('live/touch', { noteId: IN_F1 });
      await settle();
      expect(seen.frames).toHaveLength(1); // still only the first
      expect(seen.closedWith).toBe(1008);
      // And the client's reconnect meets the handshake's refusal.
      const again = await host.liveReads.subscribe({ tenantId: t, scopeId: sc, principal: reader, request: upgrade(), within: checked(F1) });
      expect(again.status).toBe(403);
    } finally {
      await host.admin.grant(staff, {
        principalId: reader,
        permission: READ,
        node: { tenantId: t, scopeId: sc },
        entity: { entityType: 'cabinet', entityId: C1 },
        grantedBy: writer,
      });
    }
  });

  it('closes the socket and sends nothing once the root itself moves out of the grant’s reach', async () => {
    const stays = await watchChecked(reader, F1);
    const moves = await watchChecked(reader, F3);
    await as('live/reshelve', { folderId: F3, from: C1, to: C2 });
    await as('live/touch-each', { noteIds: [IN_F3, IN_F1] });
    await settle();
    expect(moves.frames).toEqual([]);
    expect(moves.closedWith).toBe(1008);
    // The twin on the same pass: a root that stayed in reach still hears its row.
    expect(stays.frames).toHaveLength(1);
    expect(stays.closedWith).toBeNull();
  });

  // -- the session's end (#938, Codex round 1) ---------------------------------

  it('refuses a handshake whose session has already ended, though the grant still holds', async () => {
    const response = await host.liveReads.subscribe({
      tenantId: t,
      scopeId: sc,
      principal: reader,
      request: upgrade(),
      within: checked(F1),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(response.status).toBe(403);
    expect(response.headers.get(LIVE_MODE_HEADER)).toBe('forbidden');
  });

  it('refuses an expiry that is not an instant, rather than reading it as none', async () => {
    await expect(
      host.liveReads.subscribe({ tenantId: t, scopeId: sc, principal: reader, request: upgrade(), expiresAt: 'soon' }),
    ).rejects.toThrow(/expiresAt/);
  });

  it.each([
    ['a checked root', F1],
    ['an unnarrowed feed', null],
  ])('closes %s, unsent to, once the session that opened it has ended', async (_label, folderId) => {
    const ends = await watchChecked(reader, folderId, new Date(Date.now() + 400).toISOString());
    const stays = await watchChecked(reader, folderId, new Date(Date.now() + 60_000).toISOString());
    await as('live/touch', { noteId: IN_F1 });
    await settle();
    // Unnarrowed, `reader` hears a note only if it may read it, and it holds no note: so
    // that feed's evidence is the close alone, beside the twin that stays open.
    const heard = ends.frames.length;
    expect(stays.frames).toHaveLength(heard);

    await new Promise((resolve) => setTimeout(resolve, 500));
    await as('live/touch', { noteId: IN_F1 });
    await settle();
    expect(ends.frames).toHaveLength(heard);
    expect(ends.closedWith).toBe(1008);
    // The twin, from the same write: a session still current stays open, and hears it.
    expect(stays.closedWith).toBeNull();
    if (folderId !== null) expect(stays.frames).toHaveLength(heard + 1);
  });

  // -- many sockets from one principal (#938, Codex round 1) ------------------

  it("asks one principal's gate once per pass however many sockets it holds on the root", async () => {
    const tabs = [await watchChecked(reader, F1), await watchChecked(reader, F1), await watchChecked(reader, F1)];
    const checks = await instrumentRootChecks({ throws: false });
    try {
      await as('live/touch', { noteId: IN_F1 });
      await settle();
      expect(await checks.calls()).toBe(1);
    } finally {
      await checks.restore();
    }
    for (const tab of tabs) expect(tab.frames).toHaveLength(1);
  });

  // -- sockets that expire on a scope nobody writes to (#938, Codex round 2) -----

  const soon = (ms: number) => new Date(Date.now() + ms).toISOString();
  const later = () => soon(60_000);
  const idle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('admits a fresh session in place of sockets that expired with no write in between', async () => {
    const expiring: CheckedWatcher[] = [];
    for (let i = 0; i < LIVE_SOCKETS_PER_PRINCIPAL; i++) expiring.push(await watchChecked(reader, F1, soon(300)));
    await idle(500);
    // No write since: only admission can have noticed that the eight ended.
    const fresh = await watchChecked(reader, F1, later());
    await settle();
    expect(fresh.closedWith).toBeNull();
    for (const old of expiring) expect(old.closedWith).toBe(1008);
    await as('live/touch', { noteId: IN_F1 });
    await settle();
    expect(fresh.frames).toHaveLength(1);
  });

  it('still holds the cap against sockets whose sessions are current — the twin', async () => {
    for (let i = 0; i < LIVE_SOCKETS_PER_PRINCIPAL; i++) await watchChecked(reader, F1, later());
    const extra = await watchChecked(reader, F1, later());
    await settle();
    expect(extra.closedWith).toBe(LIVE_CLOSE.tooMany);
  });

  it('closes expired sockets on an idle scope by its alarm, the second by the alarm it re-armed', async () => {
    const first = await watchChecked(reader, F1, soon(400));
    const second = await watchChecked(reader, F1, soon(1_400));
    const stays = await watchChecked(reader, F1, later());
    const armed = await runInDurableObject(scopeDo(), (_i, state) => state.storage.getAlarm());
    expect(armed).not.toBeNull();
    await idle(900);
    expect(first.closedWith).toBe(1008);
    expect(second.closedWith).toBeNull();
    // No write and no new subscriber since: only the re-armed alarm can close the second.
    await idle(1_200);
    expect(second.closedWith).toBe(1008);
    expect(stays.closedWith).toBeNull();
    // And it re-armed again, for the socket still open.
    const next = await runInDurableObject(scopeDo(), (_i, state) => state.storage.getAlarm());
    expect(next).not.toBeNull();
  });

  it('sends nothing to a socket whose session ends while its pass is still deciding', { timeout: 20_000 }, async () => {
    // One socket per pass, so the only await between the pass's first look at the clock
    // and the send is this socket's own held root check — the window under test.
    const passWithHeldCheck = async (expiresAt: string) => {
      const watcher = await watchChecked(reader, F1, expiresAt);
      // The alarm would close it at its expiry; take it away, so only the pass decides.
      await runInDurableObject(scopeDo(), (_i, state) => state.storage.deleteAlarm());
      const checks = await instrumentRootChecks({ throws: false, delayMs: 2_500 });
      try {
        // Without this the case would prove nothing: a pass that starts after the expiry
        // is refused by the look at its start, not the one before the send.
        expect(Date.now()).toBeLessThan(Date.parse(expiresAt) - 500);
        await as('live/touch', { noteId: IN_F1 });
        await settle();
      } finally {
        await checks.restore();
      }
      for (const w of open.splice(0)) w.close();
      return watcher;
    };
    // The twin first: the same held check, a session still current when it answers.
    const current = await passWithHeldCheck(later());
    expect(current.frames).toHaveLength(1);
    // Then a session that ends while the check is held: nothing sent, the socket closed.
    const ends = await passWithHeldCheck(soon(1_500));
    expect(ends.frames).toEqual([]);
    expect(ends.closedWith).toBe(1008);
  });

  it(`holds a principal to ${LIVE_SOCKETS_PER_PRINCIPAL} sockets: the next is closed ${LIVE_CLOSE.tooMany} and sent nothing`, async () => {
    const tabs: CheckedWatcher[] = [];
    for (let i = 0; i < LIVE_SOCKETS_PER_PRINCIPAL; i++) tabs.push(await watchChecked(reader, F1));
    const extra = await watchChecked(reader, F1);
    // Another principal is not held to this one's count.
    const other = await watchChecked(writer, F1);
    await as('live/touch', { noteId: IN_F1 });
    await settle();
    expect(extra.closedWith).toBe(LIVE_CLOSE.tooMany);
    expect(extra.frames).toEqual([]);
    for (const tab of tabs) {
      expect(tab.closedWith).toBeNull();
      expect(tab.frames).toHaveLength(1);
    }
    expect(other.closedWith).toBeNull();
    expect(other.frames).toHaveLength(1);
  });

  it.each([
    ['a look-alike object', { entity: { entityType: 'folder', entityId: F1 }, permission: 'live:read' }],
    ['a spread copy of a checked value', { ...checkedWithin({ entityType: 'folder', entityId: F1 }, 'live:read') }],
    ['a plain ref carrying a checked key', { entityType: 'folder', entityId: F1, checked: 'live:read' }],
  ])('refuses %s — the checked mode is reachable by checkedWithin alone', async (_label, within) => {
    await expect(
      host.liveReads.subscribe({
        tenantId: t,
        scopeId: sc,
        principal: reader,
        request: upgrade(),
        within: within as unknown as CheckedWithin,
      }),
    ).rejects.toThrow(/checkedWithin/);
  });
});

describe('live reads: a socket whose narrowing cannot be read fails closed (#1853)', () => {
  const base = { principal: ulid(), tenantId: ulid(), scopeId: ulid(), since: new Date().toISOString() };

  it('keeps a socket with no narrowing (one opened before #1853) unnarrowed', () => {
    expect(readSubscription(base)).toMatchObject(base);
    expect(readSubscription(base)).not.toHaveProperty('within');
  });

  it('keeps a readable narrowing, vouched, checked or neither', () => {
    expect(readSubscription({ ...base, within: { entityType: 'folder', entityId: 'f' } })?.within).toEqual({
      entityType: 'folder',
      entityId: 'f',
    });
    expect(readSubscription({ ...base, within: { entityType: 'folder', entityId: 'f', vouched: 'why' } })?.within).toEqual({
      entityType: 'folder',
      entityId: 'f',
      vouched: 'why',
    });
    expect(readSubscription({ ...base, within: { entityType: 'folder', entityId: 'f', checked: 'live:read' } })?.within).toEqual({
      entityType: 'folder',
      entityId: 'f',
      checked: 'live:read',
    });
  });

  it.each([
    ['a non-object', 'folder:f'],
    ['no type', { entityId: 'f' }],
    ['an empty id', { entityType: 'folder', entityId: '' }],
    ['an empty reason', { entityType: 'folder', entityId: 'f', vouched: ' ' }],
    ['a non-string reason', { entityType: 'folder', entityId: 'f', vouched: true }],
    ['a checked key that is not a permission key', { entityType: 'folder', entityId: 'f', checked: 'not a key' }],
    ['both a reason and a checked key', { entityType: 'folder', entityId: 'f', vouched: 'why', checked: 'live:read' }],
  ])('drops a socket whose narrowing has %s, rather than widening it', (_label, within) => {
    expect(readSubscription({ ...base, within })).toBeNull();
  });

  it('keeps a readable expiry, and drops a socket whose expiry cannot be read rather than keeping it open (#938)', () => {
    expect(readSubscription({ ...base, expiresAt: '2030-01-01T00:00:00.000Z' })?.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    expect(readSubscription({ ...base, expiresAt: 'never' })).toBeNull();
    expect(readSubscription({ ...base, expiresAt: 0 })).toBeNull();
  });
});

describe('live reads: the door (#938)', () => {
  let host: CloudflareScopeHost;

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.LIVE_SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
  });

  afterAll(async () => host.close());

  it('refuses a request that is not an upgrade, without opening anything', async () => {
    const response = await host.liveReads.subscribe({
      tenantId: t,
      scopeId: s,
      principal: insider,
      request: new Request('https://vertical.test/live'),
    });
    expect(response.status).toBe(426);
    expect(response.webSocket).toBeNull();
  });

  it('refuses an orange-to-orange connection and names polling as the fallback', async () => {
    // Cloudflare does not carry WebSockets across an O2O hop, so an upgrade offered
    // there would fail where the vertical cannot see it. Refused at the door, with a
    // header the client can read — a downgrade nobody can observe is how "live updates
    // are broken" gets reported months later with no way to tell if it ever worked.
    const response = await host.liveReads.subscribe({
      tenantId: t,
      scopeId: s,
      principal: insider,
      request: upgrade({ [O2O_HEADER]: '1' }),
    });
    expect(response.status).toBe(501);
    expect(response.headers.get(LIVE_MODE_HEADER)).toBe('poll');
    expect(response.webSocket).toBeNull();
  });

  it('refuses a scope the lifecycle gate refuses, before any socket exists', async () => {
    // A subscription is a new way INTO a scope, and the permission filter answers a
    // different question — what a subscriber may SEE, not whether this scope should be
    // reachable at all. Without the same `validateScopeAccess` gate every other door
    // takes, an unknown, cross-tenant, suspended or archiving scope could still be
    // addressed and handed a 101: a scope refusing every ordinary read while quietly
    // holding an open socket.
    //
    // A never-provisioned scope is the cheapest instance of that class, and it is the
    // one an attacker supplies: the caller asserts the scope id, so "a scope id the
    // directory does not know" is one header away on any deployment with a control plane.
    const unknownScope = scopeIdOf.parse(ulid());
    await expect(
      host.liveReads.subscribe({
        tenantId: t,
        scopeId: unknownScope,
        principal: insider,
        request: upgrade(),
      }),
    ).rejects.toThrow();
  });

  it('is unmoved by an O2O header that is not exactly Cloudflare’s marker', async () => {
    // Compared exactly, not for truthiness: a `0` is an ordinary request, and reading
    // it as "yes" would downgrade every connection on a zone that sets the header at all.
    const response = await host.liveReads.subscribe({
      tenantId: t,
      scopeId: s,
      principal: insider,
      request: upgrade({ [O2O_HEADER]: '0' }),
    });
    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close(1000, 'test over');
  });
});

describe('live reads: the ping keep-alive (#1860)', () => {
  let host: CloudflareScopeHost;

  beforeAll(async () => {
    host = new CloudflareScopeHost({
      scope: env.LIVE_SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
  });

  afterAll(async () => host.close());

  /**
   * The DO's own count of `webSocketMessage` calls, read from inside its isolate —
   * `runInDurableObject` is what the suite elsewhere uses to reach a DO's private state
   * (contract.test.ts), and it is the only way to tell "answered by the runtime" apart
   * from "answered by the handler" when both send the same `'pong'` byte on the wire.
   */
  const handledCount = (): Promise<number> =>
    runInDurableObject(
      env.LIVE_SCOPE.get(env.LIVE_SCOPE.idFromName(s)),
      (instance) => (instance as unknown as { webSocketMessagesHandled: number }).webSocketMessagesHandled,
    );

  it('answers a ping with pong via the runtime auto-response, without waking webSocketMessage', async () => {
    const before = await handledCount();
    const response = await host.liveReads.subscribe({
      tenantId: t,
      scopeId: s,
      principal: insider,
      request: upgrade(),
    });
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    ws.accept();
    const pong = new Promise<void>((resolve) => {
      ws.addEventListener('message', (event) => {
        if (String((event as MessageEvent).data) === 'pong') resolve();
      });
    });
    ws.send('ping');
    await pong;
    // The load-bearing assertion: the count did not move. A pong on the wire alone
    // would also be true of the `webSocketMessage` fallback below — it is the SAME
    // count staying flat that proves the runtime intercepted it first.
    expect(await handledCount()).toBe(before);
    ws.close(1000, 'test over');
  });

  it('still reaches webSocketMessage for a non-ping message — the twin', async () => {
    // The positive control for the test above: if this count never moved either, the
    // ping test would be vacuous — proving nothing reaches the handler, not that PING
    // specifically is intercepted before it.
    const before = await handledCount();
    const response = await host.liveReads.subscribe({
      tenantId: t,
      scopeId: s,
      principal: insider,
      request: upgrade(),
    });
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    ws.accept();
    ws.send('not-a-ping');
    await settle();
    expect(await handledCount()).toBe(before + 1);
    ws.close(1000, 'test over');
  });
});

describe("live reads: the reaper's alarm and a scope's dump (#938)", () => {
  it('leaves workerd’s own _cf_* tables out of an export, and a wipe-and-load past them', async () => {
    const host = new CloudflareScopeHost({
      scope: env.LIVE_SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
    });
    const sx = scopeIdOf.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: sx, vertical: 'live-vertical' });
    await host.admin.activateScope(staff, t, sx);
    const response = await host.liveReads.subscribe({
      tenantId: t,
      scopeId: sx,
      principal: writer,
      request: upgrade(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(response.status).toBe(101);
    response.webSocket!.accept();
    const stub = env.LIVE_SCOPE.get(env.LIVE_SCOPE.idFromName(sx));
    // The alarm is armed, and workerd keeps its table for it in the scope's SQLite.
    const cf = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE name GLOB '_cf_*'`).toArray(),
    );
    expect(cf.length).toBeGreaterThan(0);

    const scope = stub as unknown as {
      exportDump(): Promise<{ name: string }[]>;
      importDump(tables: unknown[], dest?: string): Promise<unknown>;
    };
    const dump = await scope.exportDump();
    expect(dump.map((d) => d.name).filter((n) => n.startsWith('_cf_'))).toEqual([]);
    await expect(scope.importDump(dump, sx)).resolves.not.toThrow();
    response.webSocket!.close(1000, 'test over');
    await host.close();
  });
});
