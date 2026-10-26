import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAIL_IN_MAX_MESSAGE_BYTES,
  MAIL_IN_PROVIDER,
  mailInChange,
  moduleManifest,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type MailInChange,
} from '@substrat-run/contracts';
import { assertAllowed, ulid, webCryptoSecretBox, type OperationHandler } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { testOperations } from '@substrat-run/contract-tests';
import {
  MAX_DELIVERY_ATTEMPTS,
  MailInError,
  SMTP_REFUSALS,
  acceptInboundMail,
  authVerdict,
  deliverInboundMail,
  headerFields,
  mailInAddressOf,
  memoryMailInStore,
  messageEntries,
  probeMailInConnection,
  requestMailInAddress,
  revokeMailInAddress,
  rotateMailInAddress,
  sweepMailIn,
  type MailInLanding,
} from '../src/index.js';

/**
 * Inbound mail end to end on the pure adapter (#2611): a real scope running a vertical module that
 * declares a mail-in landing, an address minted for it, messages accepted the way the control
 * plane's `email()` handler hands them over, and delivery landing through the vertical's own
 * operation as the address's connection — attachment bytes included.
 */

const RECEIVE = permissionKey.parse('docs:receive-mail');
const READ = permissionKey.parse('docs:read');
const DOMAIN = 'in.example.test';
const LANDING: MailInLanding = { operation: 'docs/receive-mail', permission: RECEIVE };

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A raw message, CRLF-joined, with Cloudflare's stamp first unless `auth` is null. */
function mail(o: {
  from?: string;
  to?: string;
  messageId?: string | null;
  subject?: string;
  auth?: string | null;
  extraHeaders?: string[];
  attachment?: { filename: string; contentType: string; bytes: Uint8Array };
  text?: string;
}): Uint8Array {
  const boundary = 'b0undary';
  const auth =
    o.auth === null
      ? []
      : [`Authentication-Results: ${o.auth ?? 'mx.cloudflare.net; dkim=pass header.d=supplier.example header.s=s1; spf=pass smtp.mailfrom=billing@supplier.example; dmarc=pass header.from=supplier.example'}`];
  const head = [
    ...auth,
    ...(o.extraHeaders ?? []),
    `From: Supplier Billing <${o.from ?? 'billing@supplier.example'}>`,
    `To: ${o.to ?? 'someone@example.test'}`,
    `Subject: ${o.subject ?? 'Invoice 1042'}`,
    'Date: Mon, 26 Oct 2026 09:00:00 +0000',
    ...(o.messageId === null ? [] : [`Message-ID: ${o.messageId ?? '<inv-1042@supplier.example>'}`]),
    'MIME-Version: 1.0',
  ];
  const text = o.text ?? 'Please find the invoice attached.';
  if (!o.attachment) {
    return new TextEncoder().encode([...head, 'Content-Type: text/plain; charset=utf-8', '', text, ''].join('\r\n'));
  }
  const b64 = Buffer.from(o.attachment.bytes).toString('base64');
  return new TextEncoder().encode(
    [
      ...head,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
      `--${boundary}`,
      `Content-Type: ${o.attachment.contentType}; name="${o.attachment.filename}"`,
      `Content-Disposition: attachment; filename="${o.attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      b64,
      `--${boundary}--`,
      '',
    ].join('\r\n'),
  );
}

const PDF = new TextEncoder().encode('%PDF-1.7 a supplier invoice, as bytes');

async function world(opts: { landing?: MailInLanding | null; failTimes?: number } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'substrat-mail-in-'));
  const landed: MailInChange[] = [];
  const fail = { times: opts.failTimes ?? 0 };
  const docsMod = {
    manifest: moduleManifest.parse({
      id: '@test/docs',
      version: '1.0.0',
      kernelContract: '^0.0.1',
      permissions: [
        { key: 'docs:receive-mail', description: 'land a mailed document' },
        { key: 'docs:read', description: 'read a document and its files' },
      ],
      events: { emits: [{ type: 'attachment.added', schemaVersion: 1 }, { type: 'attachment.removed', schemaVersion: 1 }], consumes: [] },
      migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
      attachmentTargets: [{ entityType: 'document', readPermission: 'docs:read', writePermission: 'docs:receive-mail' }],
      entitlementKey: 'docs',
    }),
    ...testOperations({
      'docs/receive-mail': (async (ctx, input: unknown) => {
        assertAllowed(await ctx.check(RECEIVE));
        const change = mailInChange.parse(input);
        if (change.change === 'message' && fail.times > 0) {
          fail.times -= 1;
          throw new Error('the vertical could not take it this time');
        }
        landed.push(change);
        if (change.change === 'message') return { entity: { entityType: 'document', entityId: `doc-${change.messageId.slice(0, 12)}` } };
        return { ok: true };
      }) as OperationHandler<never, unknown>,
    }),
  };

  const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(7)) });
  host.registerModule(docsMod);
  const actor = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const reader = principalId.parse(ulid());
  await host.admin.createTenant(actor, { id: t, slug: 'acme', name: 'Acme' });
  await host.admin.grantEntitlement(actor, t, 'docs');
  await host.provisionScope(actor, { tenantId: t, scopeId: s, vertical: 'docs' });
  await host.admin.activateScope(actor, t, s);
  await host.admin.defineRole(actor, t, { key: 'reader', permissions: [READ], source: 'vertical' });
  await host.admin.assignRole(actor, { principalId: reader, roleKey: 'reader', node: { tenantId: t, scopeId: s } });
  await host.provisionBlobStore(actor, { tenantId: t, vertical: 'docs', binding: 'ATTACHMENTS' });

  const clock = { now: new Date('2026-10-26T09:00:00.000Z') };
  const store = memoryMailInStore();
  const landing = opts.landing === undefined ? LANDING : opts.landing;
  const deps = {
    actor,
    store,
    domain: DOMAIN,
    landingOf: async () => landing,
    now: () => clock.now,
  };
  const request = (allowlist?: string[]) => requestMailInAddress(host, deps, { tenantId: t, scopeId: s, createdBy: reader, ...(allowlist ? { allowlist } : {}) });
  const send = (to: string, raw: Uint8Array, envelopeFrom = 'billing@supplier.example') =>
    acceptInboundMail(host, deps, { to, envelopeFrom, rawSize: raw.byteLength, raw: async () => raw });
  const advance = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  const files = async (entityId: string) => (await host.attachments(reader, t, s)).list({ entityType: 'document', entityId });
  return { host, deps, actor, t, s, reader, store, landed, fail, request, send, advance, files };
}

describe('the address', () => {
  it('is minted once per scope, as its own connection holding the declared key on that scope', async () => {
    const w = await world();
    const first = await w.request();
    expect(first.address).toMatch(/^docs-[a-z2-7]{16}@in\.example\.test$/);
    expect(first.operation).toBe('docs/receive-mail');
    const again = await w.request();
    expect(again.address).toBe(first.address);

    const [conn, ...others] = await w.host.admin.listConnections(w.actor, { tenantId: w.t, provider: MAIL_IN_PROVIDER });
    expect(others).toHaveLength(0);
    expect(conn!.label).toBe(first.address);
    expect(conn!.createdBy).toBe(w.reader);
    const grants = await w.host.connectionGrantsInScope(w.t, w.s);
    expect(grants.filter((g) => g.connectionId === conn!.id).map((g) => g.permission)).toEqual([RECEIVE]);
  });

  it('is refused for a vertical that declares no mail-in landing, and on a deployment with no domain', async () => {
    const w = await world({ landing: null });
    await expect(w.request()).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/declares no mail-in landing/) });
    await expect(requestMailInAddress(w.host, { ...w.deps, domain: undefined }, { tenantId: w.t, scopeId: w.s, createdBy: w.reader })).rejects.toBeInstanceOf(MailInError);
  });

  it('rotates: the old address is refused, the new one delivers, and mail in flight moves with it', async () => {
    const w = await world({ failTimes: 1 });
    const old = await w.request(['@supplier.example']);
    expect((await w.send(old.address, mail({ to: old.address }))).accepted).toBe(true);
    const oldConn = (await w.send(old.address, mail({ to: old.address }))) as { connectionId: string };
    // Fails once, so it is still pending when the address rotates.
    await sweepMailIn(w.host, w.deps, oldConn.connectionId as never);

    const next = await rotateMailInAddress(w.host, w.deps, { tenantId: w.t, scopeId: w.s, createdBy: w.reader });
    expect(next.address).not.toBe(old.address);
    expect(next.allowlist).toEqual(['@supplier.example']);
    expect(next.stats.pending).toBe(1);
    expect(await w.send(old.address, mail({ to: old.address, messageId: '<other@supplier.example>' }))).toMatchObject({ accepted: false, smtp: SMTP_REFUSALS.unknown });

    w.advance(60 * 60 * 1000);
    expect(await sweepMailIn(w.host, w.deps, next.connectionId)).toMatchObject({ delivered: 1 });
    expect(w.landed.filter((c) => c.change === 'message')).toHaveLength(1);
    expect((await mailInAddressOf(w.host, w.actor, w.t, w.s))!.address).toBe(next.address);
  });

  it('revokes: mail is refused from then on, and what was waiting is deleted', async () => {
    const w = await world();
    const a = await w.request();
    await w.send(a.address, mail({ to: a.address }));
    expect(w.store.keys()).toHaveLength(1);
    expect(await revokeMailInAddress(w.host, w.deps, { tenantId: w.t, scopeId: w.s })).toBe(true);
    expect(w.store.keys()).toHaveLength(0);
    expect(await mailInAddressOf(w.host, w.actor, w.t, w.s)).toBeNull();
    expect(await w.send(a.address, mail({ to: a.address, messageId: '<later@supplier.example>' }))).toMatchObject({ accepted: false, smtp: SMTP_REFUSALS.unknown });
    expect(await revokeMailInAddress(w.host, w.deps, { tenantId: w.t, scopeId: w.s })).toBe(false);
  });
});

describe('accepting at SMTP time', () => {
  it('refuses an address nobody minted, one at another domain, and one that is not ours in shape', async () => {
    const w = await world();
    await w.request();
    const raw = mail({});
    for (const to of ['docs-aaaaaaaaaaaaaaaa@in.example.test', 'docs-abc@in.example.test', 'postmaster@in.example.test']) {
      expect(await w.send(to, raw)).toMatchObject({ accepted: false, smtp: SMTP_REFUSALS.unknown, reason: 'unknown-address' });
    }
    const a = await mailInAddressOf(w.host, w.actor, w.t, w.s);
    expect(await w.send(a!.address.replace('in.example.test', 'elsewhere.test'), raw)).toMatchObject({ accepted: false, smtp: SMTP_REFUSALS.unknown });
    expect(w.store.keys()).toHaveLength(0);
  });

  it('refuses a message over the size cap before reading it', async () => {
    const w = await world();
    const a = await w.request();
    let read = false;
    const outcome = await acceptInboundMail(w.host, w.deps, {
      to: a.address,
      envelopeFrom: 'x@supplier.example',
      rawSize: MAIL_IN_MAX_MESSAGE_BYTES + 1,
      raw: async () => {
        read = true;
        return new Uint8Array();
      },
    });
    expect(outcome).toMatchObject({ accepted: false, smtp: SMTP_REFUSALS.tooLarge });
    expect(read).toBe(false);
    expect((await mailInAddressOf(w.host, w.actor, w.t, w.s))!.stats).toMatchObject({ rejected: 1, lastRejectReason: 'too-large' });
  });

  it('holds an allowlist to proven senders: a miss, an unproven From and a forged stamp are all refused', async () => {
    const w = await world();
    const a = await w.request(['billing@supplier.example', '@owner.example']);

    // On the list, and DMARC passed for its domain.
    expect(await w.send(a.address, mail({ to: a.address }))).toMatchObject({ accepted: true });
    // Off the list.
    expect(
      await w.send(a.address, mail({ to: a.address, from: 'mallory@else.example', messageId: '<m1@else.example>', auth: 'mx.cloudflare.net; dkim=pass header.d=else.example; spf=pass smtp.mailfrom=mallory@else.example; dmarc=pass header.from=else.example' }), 'mallory@else.example'),
    ).toMatchObject({ accepted: false, smtp: SMTP_REFUSALS.notAllowed, reason: 'sender-not-allowed' });
    // On the list by name, but nothing proves the From: DMARC passed for another domain.
    expect(
      await w.send(a.address, mail({ to: a.address, messageId: '<m2@x>', auth: 'mx.cloudflare.net; dkim=pass header.d=else.example; spf=pass smtp.mailfrom=bounce@else.example; dmarc=pass header.from=else.example' }), 'bounce@else.example'),
    ).toMatchObject({ accepted: false, reason: 'sender-not-allowed' });
    // A stamp the sender wrote itself, under the receiver's real one, is never read.
    expect(
      await w.send(
        a.address,
        mail({
          to: a.address,
          messageId: '<m3@x>',
          auth: 'mx.cloudflare.net; dkim=fail; spf=fail smtp.mailfrom=billing@supplier.example; dmarc=fail header.from=supplier.example',
          extraHeaders: ['Authentication-Results: mx.cloudflare.net; dkim=pass header.d=supplier.example; spf=pass smtp.mailfrom=billing@supplier.example; dmarc=pass header.from=supplier.example'],
        }),
      ),
    ).toMatchObject({ accepted: false, reason: 'sender-not-allowed' });
    // No stamp at all.
    expect(await w.send(a.address, mail({ to: a.address, messageId: '<m4@x>', auth: null }))).toMatchObject({ accepted: false, reason: 'sender-unverified' });
    // A domain entry, proven by SPF on the envelope (a forward from the owner's own mailbox).
    expect(
      await w.send(
        a.address,
        mail({ to: a.address, messageId: '<m5@x>', auth: 'mx.cloudflare.net; dkim=none; spf=pass smtp.mailfrom=me@owner.example; dmarc=none' }),
        'me@owner.example',
      ),
    ).toMatchObject({ accepted: true });
  });

  it('accepts the same Message-ID once, and it lands once', async () => {
    const w = await world();
    const a = await w.request();
    const first = await w.send(a.address, mail({ to: a.address }));
    const again = await w.send(a.address, mail({ to: a.address, subject: 'Invoice 1042 (resent)' }));
    expect(first).toMatchObject({ accepted: true, duplicate: false });
    expect(again).toMatchObject({ accepted: true, duplicate: true });
    expect(w.store.keys()).toHaveLength(1);
    await sweepMailIn(w.host, w.deps, a.connectionId);
    await sweepMailIn(w.host, w.deps, a.connectionId);
    expect(w.landed.filter((c) => c.change === 'message')).toHaveLength(1);
    // A message with no Message-ID dedupes on its bytes.
    const bare = mail({ to: a.address, messageId: null });
    expect(await w.send(a.address, bare)).toMatchObject({ duplicate: false });
    expect(await w.send(a.address, bare)).toMatchObject({ duplicate: true });
  });
});

describe('delivery', () => {
  it('lands the message through the declared operation as the connection, then the attachment bytes', async () => {
    const w = await world();
    const a = await w.request();
    const accepted = await w.send(a.address, mail({ to: a.address, attachment: { filename: 'invoice-1042.pdf', contentType: 'application/pdf', bytes: PDF } }));
    if (!accepted.accepted) throw new Error('refused');
    expect(await deliverInboundMail(w.host, w.deps, accepted.connectionId, accepted.messageId)).toEqual({ status: 'delivered', attachments: 1 });

    const [message, attachment] = w.landed;
    expect(message).toMatchObject({
      change: 'message',
      to: a.address,
      envelopeFrom: 'billing@supplier.example',
      from: { address: 'billing@supplier.example', name: 'Supplier Billing' },
      recipients: { to: [a.address], cc: [] },
      subject: 'Invoice 1042',
      headerMessageId: '<inv-1042@supplier.example>',
      authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
      attachments: [{ index: 0, filename: 'invoice-1042.pdf', contentType: 'application/pdf', size: PDF.byteLength, lands: true }],
    });
    expect(message!.change === 'message' && message!.text).toContain('invoice attached');
    expect(attachment).toMatchObject({ change: 'attachment', index: 0, attachment: { filename: 'invoice-1042.pdf', size: PDF.byteLength } });

    const entityId = `doc-${accepted.messageId.slice(0, 12)}`;
    const [record] = await w.files(entityId);
    expect(record!.createdBy).toBe(accepted.connectionId);
    const opened = await (await w.host.attachments(w.reader, w.t, w.s)).open(record!.id);
    expect(new Uint8Array(opened!.body as Uint8Array)).toEqual(PDF);

    // The platform keeps no bytes once the scope has them, and no sender on the dedupe record.
    expect(w.store.keys()).toHaveLength(0);
    const [entry] = await messageEntries(w.host, accepted.connectionId);
    expect(entry!.entry).toMatchObject({ status: 'delivered' });
    expect(entry!.entry.envelopeFrom).toBeUndefined();
    expect((await probeMailInConnection(w.host, { id: accepted.connectionId })).ok).toBe(true);
  });

  it('retries a failed delivery with backoff, and dead-letters it after the last attempt', async () => {
    const w = await world({ failTimes: MAX_DELIVERY_ATTEMPTS + 5 });
    const a = await w.request();
    const accepted = await w.send(a.address, mail({ to: a.address }));
    if (!accepted.accepted) throw new Error('refused');
    const first = await deliverInboundMail(w.host, w.deps, accepted.connectionId, accepted.messageId);
    expect(first).toMatchObject({ status: 'retrying', attempts: 1 });
    // Not due yet: the sweep leaves it.
    expect(await sweepMailIn(w.host, w.deps, a.connectionId)).toMatchObject({ delivered: 0, retrying: 0 });
    let last;
    for (let i = 1; i < MAX_DELIVERY_ATTEMPTS; i++) {
      w.advance(7 * 60 * 60 * 1000);
      last = await sweepMailIn(w.host, w.deps, a.connectionId);
    }
    expect(last).toMatchObject({ deadLettered: 1, failed: [{ scopeId: w.s }] });
    // Kept for an operator, and no longer retried.
    expect(w.store.keys()).toHaveLength(1);
    w.advance(7 * 60 * 60 * 1000);
    expect(await sweepMailIn(w.host, w.deps, a.connectionId)).toMatchObject({ retrying: 0, deadLettered: 0 });
    expect((await mailInAddressOf(w.host, w.actor, w.t, w.s))!.stats).toMatchObject({ deadLettered: 1, pending: 0 });
  });

  it('resumes after a failure without landing a message twice', async () => {
    const w = await world({ failTimes: 1 });
    const a = await w.request();
    const accepted = await w.send(a.address, mail({ to: a.address, attachment: { filename: 'a.pdf', contentType: 'application/pdf', bytes: PDF } }));
    if (!accepted.accepted) throw new Error('refused');
    expect((await deliverInboundMail(w.host, w.deps, accepted.connectionId, accepted.messageId)).status).toBe('retrying');
    w.advance(60 * 60 * 1000);
    expect((await sweepMailIn(w.host, w.deps, a.connectionId)).delivered).toBe(1);
    expect(w.landed.map((c) => c.change)).toEqual(['message', 'attachment']);
    expect(await w.files(`doc-${accepted.messageId.slice(0, 12)}`)).toHaveLength(1);
  });
});

describe('the receiving MX stamp', () => {
  it('reads only the topmost result of the trusted receiver', () => {
    const raw = new TextEncoder().encode(
      [
        'Authentication-Results: other.mx; spf=pass smtp.mailfrom=a@b.example',
        'ARC-Authentication-Results: i=1; mx.cloudflare.net;',
        ' dkim=pass header.d=b.example header.s=x;',
        ' spf=softfail (domain does not designate) smtp.mailfrom=a@b.example; dmarc=pass header.from=b.example',
        'Authentication-Results: mx.cloudflare.net; dkim=fail; spf=fail; dmarc=fail',
        'Subject: x',
        '',
        'body',
      ].join('\r\n'),
    );
    expect(authVerdict(headerFields(raw)!)).toMatchObject({ stamped: true, dkim: 'pass', spf: 'fail', dmarc: 'pass', dmarcDomain: 'b.example', dkimDomains: ['b.example'] });
  });
});
