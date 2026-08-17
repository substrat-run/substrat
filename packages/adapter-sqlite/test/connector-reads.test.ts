import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectionId,
  moduleManifest,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PrincipalId,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  webCryptoSecretBox,
  type ConnectorContext,
  type OpenedAttachment,
  type OperationHandler,
} from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * Reading an attachment from INSIDE a connector dispatch (#711).
 *
 * The outbound half of a signing connector has to be handed the vertical's own
 * document — the bytes a signatory is actually asked to sign. Those bytes live in
 * the attachment store, which the platform has had since #473, and a connector
 * already writes to it on the return path. What it could not do was READ during
 * dispatch, and the reason is the subject of the first test below.
 */
describe('connector attachment reads during dispatch (#711)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** Promises a `doc/hold` invocation parks on, keyed so a test can release its own. */
  const holds = new Map<string, Promise<void>>();

  const DOC_READ = permissionKey.parse('doc:read');
  const DOC_WRITE = permissionKey.parse('doc:write');
  const DOC_SEND = permissionKey.parse('doc:send');

  const docMod = {
    manifest: moduleManifest.parse({
      id: '@test/doc',
      version: '1.0.0',
      kernelContract: '^0.0.1',
      permissions: [
        { key: 'doc:read', description: 'read a doc and its attachments' },
        { key: 'doc:write', description: 'attach to / detach from a doc' },
        { key: 'doc:send', description: 'send a doc out for signature' },
      ],
      events: {
        emits: [
          { type: 'attachment.added', schemaVersion: 1 },
          { type: 'attachment.removed', schemaVersion: 1 },
          { type: 'doc.send-requested', schemaVersion: 1 },
        ],
        consumes: [],
      },
      migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
      attachmentTargets: [
        { entityType: 'doc', readPermission: 'doc:read', writePermission: 'doc:write' },
      ],
      entitlementKey: 'doc',
    }),
    operations: {
      // The mutation whose event the connector answers — the shape every outbound
      // connector rides: an operation commits, and the delivery goes out after it.
      // Holds the scope's actor open until the test releases it — the way to see
      // whether another reader queues behind it or walks past it.
      'doc/hold': (async (ctx, input: { key: string }) => {
        assertAllowed(await ctx.check(DOC_SEND));
        await holds.get(input.key);
        return { held: true };
      }) as OperationHandler<never, unknown>,
      'doc/send': (async (ctx, input: { docId: string }) => {
        assertAllowed(await ctx.check(DOC_SEND));
        ctx.emit({
          type: 'doc.send-requested',
          schemaVersion: 1,
          entity: { entityType: 'doc', entityId: input.docId },
          piiClass: 'none',
          payload: { docId: input.docId },
        });
        return { ok: true };
      }) as OperationHandler<never, unknown>,
    },
  };

  /**
   * Stand up a scope with the doc module, a blob store, a connection, and one
   * attachment already landed on `doc/d1`. `connector` is the handler under test.
   *
   * `grantRead` is the connection's own `doc:read` — the permission-diff line an
   * operator would have to add for a connector to read the vertical's document.
   * Off in one test precisely to show the read is gated on it.
   */
  const world = async (
    connector: (ctx: ConnectorContext) => Promise<void>,
    opts: { grantRead?: boolean } = {},
  ) => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-connector-reads-'));
    const host = new SqliteScopeHost({
      dir,
      secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(5)),
      fetch: async () => new Response('{}', { status: 200 }),
    });
    host.registerModule(docMod);
    // The registration id is deliberately NOT the provider slug: the connector asks
    // for its credential by name (`ctx.connection('provider')`) and the read hangs
    // off that connection, so nothing here can be passing by accident on the id.
    host.registerConnector('outbound', 'doc.send-requested', (ctx) => connector(ctx), {
      maxAttempts: 1,
    });

    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    const author: PrincipalId = principalId.parse(ulid());

    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.admin.grantEntitlement(staff, t, 'doc');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, {
      key: 'author',
      permissions: [DOC_READ, DOC_WRITE, DOC_SEND],
      source: 'vertical',
    });
    await host.admin.assignRole(staff, {
      principalId: author,
      roleKey: 'author',
      node: { tenantId: t, scopeId: s },
    });
    await host.provisionBlobStore(staff, { tenantId: t, vertical: 'docs', binding: 'ATTACHMENTS' });

    const connId = connectionId.parse(ulid());
    await host.admin.createConnection(staff, {
      id: connId,
      tenantId: t,
      vertical: 'docs',
      provider: 'provider',
      label: 'Provider',
      secret: { accessToken: 'tok' },
    });
    if (opts.grantRead !== false) {
      await host.admin.grantToConnection(staff, {
        connectionId: connId,
        permission: DOC_READ,
        node: { tenantId: t, scopeId: s },
        grantedBy: staff,
      });
    }

    // The vertical's own rendered document, bound to the entity the connector will
    // be told about. Landed as the AUTHOR — a person uploading from a screen.
    const attachments = await host.attachments(author, t, s);
    const record = await attachments.upload({
      entity: { entityType: 'doc', entityId: 'd1' },
      filename: 'avtal.pdf',
      contentType: 'application/pdf',
      visibility: 'customer',
      body: new TextEncoder().encode('%PDF-1.4 the real avtal'),
    });

    const stub = await host.getScope(author, t, s);
    return { host, staff, t, s, connId, record, stub };
  };

  /** Resolves to 'timeout' if `p` has not settled within `ms` — a wedge, observable. */
  const within = async (ms: number, p: Promise<unknown>): Promise<'settled' | 'timeout'> => {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
    });
    return Promise.race([
      p.then(() => 'settled' as const).catch(() => 'settled' as const),
      timeout,
    ]).finally(() => clearTimeout(timer));
  };

  /**
   * The hazard this seam exists to avoid, pinned so it cannot be reintroduced.
   *
   * A connector runs INSIDE the scope's actor task: `invoke` calls
   * `dispatchExecutors` from within `rt.actor.enqueue`, post-commit but still
   * holding the tail. `getConnectorAttachments` mints the ORDINARY surface, whose
   * every verb re-enqueues on that same actor — and `ScopeActor` is a plain
   * promise-tail serializer with no reentrancy awareness, so the nested task waits
   * on a task that is waiting on it. Nothing throws; the invoke simply never returns.
   *
   * This is the same wall that put the connector's dispatch ledger in the DIRECTORY
   * rather than the scope. It was documented for writes and never tested for reads,
   * because until #711 no connector read from the scope during dispatch.
   *
   * The asymmetry that makes it easy to miss: `dispatchConnector` — the platform
   * half of a routed `connector:<provider>` intent — deliberately does NOT enqueue.
   * So the naive implementation works on the routed path and hangs under
   * `invoke`/`drainDue`, i.e. it passes in whichever test happens to be written
   * first. Hence a test for the hanging path specifically.
   */
  it('WEDGES the scope if a connector re-enters it through getConnectorAttachments', async () => {
    let reached = false;
    const { host, t, s, connId, record, stub } = await world(async (ctx) => {
      reached = true;
      // The top-level surface, used from inside dispatch. Right authority, wrong
      // place: it re-enqueues on an actor this very task is holding.
      const att = await host.getConnectorAttachments(connId, ctx.scopeId);
      await att.open(record.id);
    });

    const sending = stub.invoke('doc/send', { docId: 'd1' });
    expect(await within(250, sending)).toBe('timeout');
    // Not a crash and not a refusal — the handler ran, and then stopped existing.
    expect(reached).toBe(true);

    // The actor is wedged for good: any later work on this scope queues behind a
    // task that will never finish. Left dangling deliberately — `close` does not
    // enqueue, so the host tears down around it.
    expect(await within(150, host.drainDue(t, s))).toBe('timeout');
    await host.close();
  });

  /**
   * The seam: `conn.openAttachment` reads without re-entering the actor. Same
   * permission gate, same bytes, same integrity check — it simply does not queue
   * behind itself.
   */
  it('reads the vertical’s own document during dispatch through conn.openAttachment', async () => {
    let seen: OpenedAttachment | null | undefined;
    const { host, record, stub } = await world(async (ctx) => {
      seen = await (await ctx.connection('provider')).openAttachment(record.id);
    });

    await stub.invoke('doc/send', { docId: 'd1' });

    expect(seen).toBeDefined();
    expect(new TextDecoder().decode(seen!.body)).toBe('%PDF-1.4 the real avtal');
    expect(seen!.record.filename).toBe('avtal.pdf');
    expect(seen!.contentType).toBe('application/pdf');
    await host.close();
  });

  /**
   * The OTHER dispatch path, and the reason the reentrancy is a parameter rather
   * than an assumption.
   *
   * `dispatchConnector` — the platform half of a routed `connector:<provider>`
   * intent — deliberately does not enqueue, so a connector running there holds
   * nothing. Building the read reentrant everywhere would work, and would quietly
   * drop this path out of the strict serialization the adapter promises (K-6): a
   * read on the same SQLite connection while another task has a transaction open
   * sees that task's uncommitted rows.
   *
   * So the adapter is told which case it is in. Here the actor is deliberately
   * busy, and the read must WAIT for it — that wait is the serialization, visible.
   */
  it('takes an ordinary serialized turn when dispatched outside the actor', async () => {
    let release!: () => void;
    holds.set('k', new Promise<void>((r) => { release = r; }));

    let read: OpenedAttachment | null | undefined;
    const { host, t, s, record, stub } = await world(async (ctx) => {
      read = await (await ctx.connection('provider')).openAttachment(record.id);
    });

    // Occupy the actor. `doc/hold` parks mid-operation, so the scope's task queue
    // is not empty until the test says so.
    const held = stub.invoke('doc/hold', { key: 'k' });
    await new Promise((r) => setTimeout(r, 30));

    const dispatched = host.dispatchConnector(
      t,
      s,
      // The same handler `world` was given; dispatchConnector takes it directly.
      async (ctx) => {
        read = await (await ctx.connection('provider')).openAttachment(record.id);
      },
      {
        id: ulid(),
        type: 'doc.send-requested',
        schemaVersion: 1,
        tenantId: t,
        scopeId: s,
        entity: { entityType: 'doc', entityId: 'd1' },
        piiClass: 'none',
        subjectId: null,
        actor: { system: 'test' },
        occurredAt: new Date().toISOString(),
        payload: { docId: 'd1' },
      } as never,
    );

    // Queued, not jumped: nothing has been read while the actor is occupied.
    expect(await within(200, dispatched)).toBe('timeout');
    expect(read).toBeUndefined();

    release();
    await held;
    await dispatched;
    expect(new TextDecoder().decode(read!.body)).toBe('%PDF-1.4 the real avtal');
    await host.close();
  }, 20_000);

  /** An id this scope does not know is `null`, not a throw — the caller falls back. */
  it('answers null for an unknown attachment id', async () => {
    let seen: OpenedAttachment | null | undefined;
    const { host, stub } = await world(async (ctx) => {
      seen = await (await ctx.connection('provider')).openAttachment(ulid());
    });
    await stub.invoke('doc/send', { docId: 'd1' });
    expect(seen).toBeNull();
    await host.close();
  });

  /**
   * Authority is the CONNECTION's, not the ambient one of whoever triggered the
   * event. This connection was granted nothing, so the read is refused — running
   * inside a permitted operation buys a connector no authority of its own.
   */
  it('refuses the read when the connection holds no read grant', async () => {
    let error: string | undefined;
    const { host, record, stub } = await world(
      async (ctx) => {
        try {
          await (await ctx.connection('provider')).openAttachment(record.id);
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
      },
      { grantRead: false },
    );
    await stub.invoke('doc/send', { docId: 'd1' });
    expect(error).toBeDefined();
    expect(error).toMatch(/doc:read|permission|denied/i);
    await host.close();
  });
});
