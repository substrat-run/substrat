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
import { env } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  permissionKey,
  platformActorId,
  principalId,
  scopeId as scopeIdOf,
  tenantId as tenantIdOf,
} from '@substrat-run/contracts';
import { ulid, webCryptoSecretBox, type LiveChange } from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { LIVE_MODE_HEADER, O2O_HEADER } from '../src/live-reads.js';
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
