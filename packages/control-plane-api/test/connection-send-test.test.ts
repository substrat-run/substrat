import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid, webCryptoSecretBox, type MailSender, type OutboundMail } from '@substrat-run/kernel';
import { connectionId, platformActorId, tenantId } from '@substrat-run/contracts';
import { createControlPlaneApi, DEV_ACTOR_HEADER, UNSAFE_devPlatformActorAuth } from '../src/index.js';

/**
 * `POST /tenants/:t/connections/:id/send-test` (#2343) — mail's probe, which has to send. The
 * route is transport over the provider's `MailSender`: it admits only one of the connection's
 * own senders, and carries the connector's answer back as `ok: false` in the connector's words.
 */
describe('a connection send test (#2343)', () => {
  const staff = platformActorId.parse(ulid());
  const acme = tenantId.parse(ulid());
  const id = connectionId.parse(ulid());
  const headers = { [DEV_ACTOR_HEADER]: staff, 'content-type': 'application/json' };
  let dir: string;
  let host: SqliteScopeHost;

  const sent: OutboundMail[] = [];
  let outcome: () => Promise<void> = async () => {};
  const sender: MailSender = {
    senders: async () => ['Office@acme.example'],
    send: async (_h, _row, mail) => {
      sent.push(mail);
      await outcome();
      return { delivered: [], queued: mail.to.map((t) => t.email), bounced: [] };
    },
  };
  const sendTest = (body: unknown, mailSenders: Record<string, MailSender> = { mailer: sender }) =>
    createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth(), mailSenders }).request(
      `/tenants/${acme}/connections/${id}/send-test`,
      { method: 'POST', headers, body: JSON.stringify(body) },
    );
  const failing = (message: string, status?: number) => async () => {
    throw Object.assign(new Error(message), status === undefined ? {} : { status });
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-send-test-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k1', new Uint8Array(32).fill(7)) });
    await host.admin.createTenant(staff, { id: acme, slug: 'acme', name: 'Acme' });
    await host.admin.createConnection(staff, {
      id, tenantId: acme, vertical: 'desk', provider: 'mailer', label: 'Mail', scopes: [], secret: { k: 'v' },
    });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['sent', async () => {}, { ok: true, status: null, error: null }],
    ['outside the granted scope', failing('Exchange refused to send as it', 403), { ok: false, status: 403, error: 'Exchange refused to send as it' }],
    ['throttled', failing('Exchange is throttling this mailbox', 429), { ok: false, status: 429, error: 'Exchange is throttling this mailbox' }],
    ['sign-in failed', failing('Microsoft 365 sign-in failed: no application'), { ok: false, status: null, error: 'Microsoft 365 sign-in failed: no application' }],
  ])('%s: answers 200 with the connector’s own words', async (_case, thrown, answer) => {
    outcome = thrown;
    sent.length = 0;
    const res = await sendTest({ from: 'office@acme.example', to: 'me@example.com' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
    expect(sent).toMatchObject([{ from: { email: 'office@acme.example' }, to: [{ email: 'me@example.com' }] }]);
  });

  it('refuses a from that is not one of the connection’s senders, or a body that is not two addresses, and sends nothing', async () => {
    sent.length = 0;
    expect((await sendTest({ from: 'ceo@acme.example', to: 'me@example.com' })).status).toBe(400);
    expect((await sendTest({ from: 'office@acme.example' })).status).toBe(400);
    expect(sent).toEqual([]);
  });

  it('a provider with no mail sender answers 501', async () => {
    expect((await sendTest({ from: 'office@acme.example', to: 'me@example.com' }, {})).status).toBe(501);
  });
});
