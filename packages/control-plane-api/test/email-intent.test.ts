import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { mountPlatformSurface, type VerticalScopeHost } from '@substrat-run/vertical-host';
import {
  EMAIL_DEAD_LETTERED,
  dataSubjectId,
  EMAIL_REFUSED,
  EMAIL_SENT,
  SEND_EMAIL_KIND,
  moduleManifest,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type EmailOutcomePayload,
  type PrincipalId,
  type ScopeId,
  type SendEmailRequest,
  type TenantId,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  requestEmail,
  ulid,
  webCryptoSecretBox,
  type ConsumerHandler,
  type OperationHandler,
} from '@substrat-run/kernel';
import {
  drainScopePlatformRequests,
  MAX_EMAIL_SEND_ATTEMPTS,
  sendEmailHandler,
  VerticalClient,
  type SendEmailDeps,
} from '../src/index.js';

/**
 * #2102 end to end: an operation requests mail, the drain sends it, and the outcome comes back
 * as an event a consumer of the vertical receives — a real SQLite host behind the real platform
 * surface, so the settle and its event cross the same wire a hosted vertical speaks.
 */

type Env = { PLATFORM_SECRET: string };
const SECRET = 'sekret';
const SEND = permissionKey.parse('mailer:send');

const mailerMod = {
  manifest: moduleManifest.parse({
    id: '@test/mailer',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [{ key: 'mailer:send', description: 'send mail' }],
    events: {
      emits: [],
      consumes: [
        { type: EMAIL_SENT, schemaVersion: 1 },
        { type: EMAIL_REFUSED, schemaVersion: 1 },
        { type: EMAIL_DEAD_LETTERED, schemaVersion: 1 },
      ],
    },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'mailer',
  }),
  migrations: [
    { version: '0001-init', sql: 'CREATE TABLE delivery (request TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL)' },
  ],
  operations: {
    'mailer/send': (async (ctx, input: SendEmailRequest) => {
      assertAllowed(await ctx.check(SEND));
      return requestEmail(ctx, input);
    }) as OperationHandler<never, unknown>,
    'mailer/send-then-throw': (async (ctx, input: SendEmailRequest) => {
      assertAllowed(await ctx.check(SEND));
      requestEmail(ctx, input);
      throw new Error('the operation failed after asking for the mail');
    }) as OperationHandler<never, unknown>,
    'mailer/deliveries': ((ctx) =>
      ctx.sql.query<{ request: string; type: string; payload: string }>(
        'SELECT request, type, payload FROM delivery',
      )) as OperationHandler<never, unknown>,
  },
  consumers: Object.fromEntries(
    [EMAIL_SENT, EMAIL_REFUSED, EMAIL_DEAD_LETTERED].map((type) => [
      type,
      ((ctx, event) => {
        const payload = event.payload as EmailOutcomePayload;
        ctx.sql.exec('INSERT INTO delivery (request, type, payload) VALUES (?, ?, ?)', [
          payload.request,
          event.type,
          JSON.stringify(payload),
        ]);
      }) as ConsumerHandler,
    ]),
  ),
};

const MAIL: SendEmailRequest = { to: 'ada@example.com', subject: 'Kvitto', html: '<p>Tack</p>', text: 'Tack' };

/** A sender's refusal, shaped as a provider's: a status, and a `Retry-After` on a throttle. */
const providerError = (status: number, retryAfter?: number) =>
  Object.assign(new Error(`provider answered ${status}`), { status, ...(retryAfter ? { retryAfter } : {}) });

/** A tenant send that failed in the provider: the relay's 502, the provider's answer as `cause`. */
const relayed = (cause: Error) => Object.assign(new Error('the mail connection could not send', { cause }), { status: 502 });

interface Sent {
  as: 'platform' | 'tenant';
  to: string;
  from?: string;
}

describe('send-email as a transactional platform intent (#2102)', () => {
  let dir: string | undefined;
  let host: SqliteScopeHost | undefined;
  afterEach(async () => {
    await host?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    host = undefined;
    dir = undefined;
  });

  let staffOf: ReturnType<typeof platformActorId.parse>;
  const world = async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-email-intent-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(3)) });
    host.registerModule(mailerMod);
    const staff = platformActorId.parse(ulid());
    staffOf = staff;
    const t: TenantId = tenantId.parse(ulid());
    const s: ScopeId = scopeId.parse(ulid());
    const clerk: PrincipalId = principalId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `mail-${ulid().toLowerCase()}`, name: 'Mail' });
    await host.admin.grantEntitlement(staff, t, 'mailer');
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'mailer' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, { key: 'clerk', permissions: [SEND], source: 'vertical' });
    await host.admin.assignRole(staff, { principalId: clerk, roleKey: 'clerk', node: { tenantId: t, scopeId: s } });

    // The real platform surface over the host, and the client the control plane drains with.
    const app = new Hono<{ Bindings: Env }>();
    mountPlatformSurface<Env>(app, {
      platformSecret: (env) => env.PLATFORM_SECRET,
      hostFor: () => host as unknown as VerticalScopeHost,
      roles: [],
      ownerRoleKey: 'clerk',
    });
    const client = new VerticalClient({
      fetch: ((input: RequestInfo, init?: RequestInit) =>
        app.request(input, init, { PLATFORM_SECRET: SECRET })) as typeof fetch,
      platformSecret: SECRET,
    });

    const sent: Sent[] = [];
    let clock = new Date('2026-10-07T12:00:00.000Z');
    const senders = {
      platform: async (): Promise<{ messageId?: string }> => ({ messageId: `cf-${sent.length}` }),
      tenant: async (): Promise<{ messageId?: string }> => ({}),
    };
    const deps: SendEmailDeps = {
      mayEmail: async (vertical) => vertical === 'mailer',
      sendAsPlatform: async (mail) => {
        const out = await senders.platform();
        sent.push({ as: 'platform', to: mail.to });
        return out;
      },
      sendAsTenant: async (input) => {
        const out = await senders.tenant();
        sent.push({ as: 'tenant', to: input.to, from: input.from });
        return out;
      },
      now: () => clock,
    };
    const drain = () =>
      drainScopePlatformRequests(
        client,
        {
          tenantId: t,
          scopeId: s,
          vertical: 'mailer',
          scope: { kind: 'app', forkedFrom: null },
          lifecycle: { scope: 'active', tenant: 'active' },
        },
        // A fresh handler per pass, as the control plane builds one per drain.
        { [SEND_EMAIL_KIND]: sendEmailHandler(deps) },
      );
    const stub = await host.getScope(clerk, t, s);
    const deliveries = async () =>
      (await stub.invoke<{ request: string; type: string; payload: string }[]>('mailer/deliveries')).map((d) => ({
        type: d.type,
        ...(JSON.parse(d.payload) as EmailOutcomePayload),
      }));
    const intent = async (id: string) => (await host!.listPlatformRequestHistory(t, s)).find((r) => r.id === id)!;
    return {
      stub,
      t,
      s,
      drain,
      sent,
      senders,
      deliveries,
      intent,
      advance: (ms: number) => (clock = new Date(clock.getTime() + ms)),
    };
  };

  it('an operation that throws after requesting a send delivers nothing', async () => {
    const w = await world();
    await expect(w.stub.invoke('mailer/send-then-throw', MAIL)).rejects.toThrow(/failed after asking/);
    expect(await w.drain()).toMatchObject({ drained: 0 });
    expect(w.sent).toEqual([]);
    expect(await w.deliveries()).toEqual([]);
  });

  it('a committed send goes once, as the platform, and the vertical hears `email.sent` with the message id', async () => {
    const w = await world();
    const id = await w.stub.invoke<string>('mailer/send', { ...MAIL, about: { entityType: 'receipt', entityId: 'r1' } });
    expect(w.sent).toEqual([]); // nothing leaves inside the operation

    expect(await w.drain()).toMatchObject({ drained: 1, done: 1 });
    expect(w.sent).toEqual([{ as: 'platform', to: 'ada@example.com' }]);
    expect(await w.deliveries()).toEqual([
      {
        type: EMAIL_SENT,
        request: id,
        about: { entityType: 'receipt', entityId: 'r1' },
        sender: 'platform',
        messageId: 'cf-0',
        attempts: 1,
        code: null,
        status: null,
      },
    ]);
    // Over: the next pass finds nothing to send.
    expect(await w.drain()).toMatchObject({ drained: 0 });
    expect(w.sent).toHaveLength(1);
  });

  it.each([
    ['platform', undefined],
    ['tenant', 'kansli@acme.example'],
  ] as const)('a throttled %s send waits out Retry-After, then is delivered', async (as, from) => {
    const w = await world();
    let throttle = true;
    w.senders[as] = async () => {
      if (throttle) throw as === 'tenant' ? relayed(providerError(429, 120)) : providerError(429, 120);
      return { messageId: 'm-1' };
    };
    const id = await w.stub.invoke<string>('mailer/send', { ...MAIL, ...(from ? { from } : {}) });

    expect(await w.drain()).toMatchObject({ pending: 1 });
    expect(await w.intent(id)).toMatchObject({ status: 'pending', attempts: 1 });
    throttle = false;

    // Inside the provider's two minutes: not tried, and no attempt counted.
    w.advance(60_000);
    await w.drain();
    expect(w.sent).toEqual([]);
    expect((await w.intent(id)).attempts).toBe(1);

    w.advance(61_000);
    expect(await w.drain()).toMatchObject({ done: 1 });
    expect(w.sent).toEqual([{ as, to: 'ada@example.com', ...(from ? { from } : {}) }]);
    expect(await w.deliveries()).toMatchObject([{ type: EMAIL_SENT, request: id, sender: as, messageId: 'm-1', attempts: 2 }]);
  });

  it.each([
    ['platform', undefined],
    ['tenant', 'kansli@acme.example'],
  ] as const)('a permanently refused %s send is not retried and emits `email.refused`', async (as, from) => {
    const w = await world();
    w.senders[as] = async () => {
      throw as === 'tenant' ? relayed(providerError(403)) : providerError(400);
    };
    const id = await w.stub.invoke<string>('mailer/send', { ...MAIL, ...(from ? { from } : {}) });

    expect(await w.drain()).toMatchObject({ failed: 1 });
    expect(await w.intent(id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await w.deliveries()).toMatchObject([
      { type: EMAIL_REFUSED, request: id, sender: as, attempts: 1, status: as === 'tenant' ? 403 : 400 },
    ]);
  });

  it.each([
    ['platform', undefined],
    ['tenant', 'kansli@acme.example'],
  ] as const)('a %s send that never stops failing dead-letters after the bound', async (as, from) => {
    const w = await world();
    w.senders[as] = async () => {
      throw as === 'tenant' ? relayed(providerError(503)) : providerError(503);
    };
    const id = await w.stub.invoke<string>('mailer/send', { ...MAIL, ...(from ? { from } : {}) });

    for (let pass = 1; pass < MAX_EMAIL_SEND_ATTEMPTS; pass++) {
      await w.drain();
      expect(await w.deliveries()).toEqual([]);
      w.advance(60 * 60_000); // past any backoff
    }
    expect(await w.drain()).toMatchObject({ failed: 1 });
    expect(await w.intent(id)).toMatchObject({ status: 'failed', attempts: MAX_EMAIL_SEND_ATTEMPTS });
    expect(await w.deliveries()).toMatchObject([
      { type: EMAIL_DEAD_LETTERED, request: id, sender: as, attempts: MAX_EMAIL_SEND_ATTEMPTS, status: 503 },
    ]);
  });

  it('a mailbox that answers 429 is not tried again in the same pass', async () => {
    const w = await world();
    let calls = 0;
    w.senders.tenant = async () => {
      calls++;
      throw relayed(providerError(429, 30));
    };
    const from = 'kansli@acme.example';
    const first = await w.stub.invoke<string>('mailer/send', { ...MAIL, from });
    const second = await w.stub.invoke<string>('mailer/send', { ...MAIL, from });

    expect(await w.drain()).toMatchObject({ drained: 2, pending: 2 });
    expect(calls).toBe(1);
    expect((await w.intent(first)).attempts).toBe(1);
    expect((await w.intent(second)).attempts).toBe(0); // deferred, never tried
  });

  it('a vertical without the email-sender grant is refused, and told so', async () => {
    const w = await world();
    const id = await w.stub.invoke<string>('mailer/send', MAIL);
    const outcome = await drainScopePlatformRequests(
      { listPlatformRequests: async () => [await w.intent(id)], settlePlatformRequest: async () => undefined },
      {
        tenantId: tenantId.parse(ulid()),
        scopeId: scopeId.parse(ulid()),
        vertical: 'someone-else',
        scope: { kind: 'app', forkedFrom: null },
        lifecycle: { scope: 'active', tenant: 'active' },
      },
      {
        [SEND_EMAIL_KIND]: sendEmailHandler({
          mayEmail: async () => false,
          sendAsPlatform: async () => ({}),
          sendAsTenant: async () => ({}),
        }),
      },
    );
    expect(outcome).toMatchObject({ failed: 1 });
    expect(w.sent).toEqual([]);
  });

  it('a subject erasure cancels a held send to that person and leaves no address in the row', async () => {
    const w = await world();
    const person = dataSubjectId.parse(ulid());
    const other = dataSubjectId.parse(ulid());
    const theirs = await w.stub.invoke<string>('mailer/send', { ...MAIL, subjectId: person });
    const kept = await w.stub.invoke<string>('mailer/send', { ...MAIL, to: 'bo@example.com', subjectId: other });

    await host!.admin.shredSubject(staffOf, w.t, w.s, person);

    const erased = await w.intent(theirs);
    expect(erased.status).toBe('failed'); // cancelled before it was ever sent
    expect(JSON.stringify(erased.payload)).not.toContain('ada@example.com');
    expect((await w.intent(kept)).status).toBe('pending');

    await w.drain();
    expect(w.sent).toEqual([{ as: 'platform', to: 'bo@example.com' }]);
  });

  it('module code is refused a malformed mail inside the operation, not at drain time', async () => {
    const w = await world();
    await expect(w.stub.invoke('mailer/send', { ...MAIL, to: 'not an address' })).rejects.toThrow();
    await expect(
      w.stub.invoke('mailer/send', { ...MAIL, attachments: [{ attachmentId: 'a1' }] }),
    ).rejects.toThrow(/attachments ride only with `from`/);
    expect(await w.drain()).toMatchObject({ drained: 0 });
  });
});
