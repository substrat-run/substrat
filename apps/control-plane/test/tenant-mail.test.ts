import { describe, expect, it } from 'vitest';
import { platformActorId, substratError, type Connection } from '@substrat-run/contracts';
import { ulid, type MailSender, type OpenedAttachment, type OutboundMail, type ScopeHost } from '@substrat-run/kernel';
import {
  sendAsTenant,
  TENANT_MAIL_MAX_ATTACHMENT_BYTES,
  TenantMailRefusal,
  type TenantMailDeps,
} from '../src/tenant-mail.js';

/**
 * Sending as a tenant's own address (#2098): which connection sends, and what it is handed.
 *
 * The host is a stand-in that answers `listConnections` — the only directory read the
 * resolution makes — so each case states the tenant's connections outright. The relay route
 * around this, and the proven-caller gate in front of it, are driven through the real worker
 * in relay-caller.test.ts.
 */
const actor = platformActorId.parse(ulid());
const tenantId = ulid() as Connection['tenantId'];

const connection = (provider: string, over: Partial<Connection> = {}): Connection =>
  ({
    id: ulid(),
    tenantId,
    vertical: 'desk',
    provider,
    label: provider,
    status: 'active',
    externalAccountRef: null,
    scopes: [],
    expiresAt: null,
    lastOkAt: null,
    lastError: null,
    lastErrorAt: null,
    createdBy: 'someone',
    createdAt: new Date().toISOString(),
    revokedAt: null,
    ...over,
  }) as Connection;

/** A mail sender that may send as `addresses` and records what it was asked to send. */
function recordingSender(addresses: string[]) {
  const sent: { connection: Connection; mail: OutboundMail }[] = [];
  const sender: MailSender = {
    senders: async () => addresses,
    send: async (_host, conn, mail) => {
      sent.push({ connection: conn, mail });
      return { delivered: [], queued: mail.to.map((t) => t.email), bounced: [] };
    },
  };
  return { sender, sent };
}

const deps = (
  connections: Connection[],
  senders: Record<string, MailSender>,
  openAttachment: TenantMailDeps['openAttachment'] = async () => null,
): TenantMailDeps => ({
  host: { admin: { listConnections: async () => connections } } as unknown as ScopeHost,
  actor,
  senders,
  openAttachment,
});

const input = (over: Partial<Parameters<typeof sendAsTenant>[1]> = {}) => ({
  tenantId,
  vertical: 'desk',
  from: 'office@acme.example',
  to: 'customer@example.com',
  subject: 'Your offer',
  html: '<p>Attached.</p>',
  text: 'Attached.',
  attachmentIds: [],
  ...over,
});

const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(TenantMailRefusal);
  return e as TenantMailRefusal;
};

describe('sending as a tenant address (#2098)', () => {
  it('sends through the connection whose sender covers the address, case-insensitively', async () => {
    const m365 = recordingSender(['Office@Acme.example']);
    const conn = connection('m365');
    const result = await sendAsTenant(deps([conn], { m365: m365.sender }), input({ fromName: 'Acme' }));

    expect(result.queued).toEqual(['customer@example.com']);
    expect(m365.sent).toHaveLength(1);
    expect(m365.sent[0]!.connection.id).toBe(conn.id);
    expect(m365.sent[0]!.mail).toMatchObject({
      from: { email: 'office@acme.example', name: 'Acme' },
      to: [{ email: 'customer@example.com' }],
      attachments: [],
    });
  });

  it('refuses an address no connection covers, naming it — never the platform sender instead', async () => {
    const m365 = recordingSender(['office@acme.example']);
    const e = await refusal(
      sendAsTenant(deps([connection('m365')], { m365: m365.sender }), input({ from: 'ceo@acme.example' })),
    );
    expect(e.status).toBe(403);
    expect(e.message).toContain("'ceo@acme.example'");
    expect(m365.sent).toHaveLength(0);
  });

  it('skips an expired or revoked connection, and one whose connector sends no mail', async () => {
    for (const status of ['expired', 'revoked'] as const) {
      const m365 = recordingSender(['office@acme.example']);
      const e = await refusal(
        sendAsTenant(deps([connection('m365', { status }), connection('planima')], { m365: m365.sender }), input()),
      );
      expect(e.status).toBe(403);
      expect(m365.sent).toHaveLength(0);
    }
  });

  it('sends through a connection whose last use failed, so a retry after a throttle reaches the provider', async () => {
    // A 429 or a 5xx records the use as failed and the adapter marks the connection `error`;
    // refusing it here held every later send at a 403 until someone re-saved the connection.
    const m365 = recordingSender(['office@acme.example']);
    const conn = connection('m365', { status: 'error', lastError: 'HTTP 429 from microsoft365' });
    await sendAsTenant(deps([conn], { m365: m365.sender }), input());
    expect(m365.sent.map((x) => x.connection.id)).toEqual([conn.id]);
  });

  it('refuses when two connections claim the address, rather than choosing one', async () => {
    const a = recordingSender(['office@acme.example']);
    const b = recordingSender(['office@acme.example']);
    const e = await refusal(
      sendAsTenant(deps([connection('m365'), connection('gws')], { m365: a.sender, gws: b.sender }), input()),
    );
    expect(e.status).toBe(409);
    expect([...a.sent, ...b.sent]).toHaveLength(0);
  });

  it("a provider's refusal comes back as a 502 carrying the connector's own words (#2100)", async () => {
    const refusing: MailSender = {
      senders: async () => ['office@acme.example'],
      send: async () => {
        throw new Error('Exchange refused to send as office@acme.example — outside the scope the tenant granted');
      },
    };
    const e = await refusal(sendAsTenant(deps([connection('m365')], { m365: refusing }), input()));
    expect(e.status).toBe(502);
    expect(e.message).toContain('outside the scope the tenant granted');
  });

  describe('a connection that cannot say what it covers', () => {
    const broken: MailSender = {
      senders: async () => {
        throw new Error('secret will not open');
      },
      send: async () => {
        throw new Error('never');
      },
    };

    it('does not stop the connection that does cover the address', async () => {
      const m365 = recordingSender(['office@acme.example']);
      await sendAsTenant(
        deps([connection('gws'), connection('m365')], { gws: broken, m365: m365.sender }),
        input(),
      );
      expect(m365.sent).toHaveLength(1);
    });

    it('when nothing that answered covers the address, is a 503 naming it, not a 403 claiming no coverage', async () => {
      const conn = connection('gws');
      const e = await refusal(sendAsTenant(deps([conn], { gws: broken }), input()));
      expect(e.status).toBe(503);
      expect(e.message).toContain(conn.id);
    });
  });

  describe('attachments, read as the sending connection', () => {
    const file = (filename: string, bytes: number): OpenedAttachment =>
      ({ record: { filename }, body: new Uint8Array(bytes), contentType: 'application/pdf' }) as unknown as OpenedAttachment;

    it('reads each id as the connection that sends, and hands the sender the bytes', async () => {
      const m365 = recordingSender(['office@acme.example']);
      const conn = connection('m365');
      const reads: [string, string][] = [];
      await sendAsTenant(
        deps([conn], { m365: m365.sender }, async (connectionId, attachmentId) => {
          reads.push([connectionId, attachmentId]);
          return file(`${attachmentId}.pdf`, 3);
        }),
        input({ attachmentIds: ['01A', '01B'] }),
      );
      expect(reads).toEqual([
        [conn.id, '01A'],
        [conn.id, '01B'],
      ]);
      expect(m365.sent[0]!.mail.attachments.map((a) => [a.filename, a.contentType, a.content.byteLength])).toEqual([
        ['01A.pdf', 'application/pdf', 3],
        ['01B.pdf', 'application/pdf', 3],
      ]);
    });

    it('an id the scope does not hold is a 400, and nothing is sent', async () => {
      const m365 = recordingSender(['office@acme.example']);
      const e = await refusal(
        sendAsTenant(deps([connection('m365')], { m365: m365.sender }), input({ attachmentIds: ['01GONE'] })),
      );
      expect(e.status).toBe(400);
      expect(m365.sent).toHaveLength(0);
    });

    it('a file the connection was not granted is a 403 that says which grant is missing', async () => {
      const m365 = recordingSender(['office@acme.example']);
      const e = await refusal(
        sendAsTenant(
          deps([connection('m365')], { m365: m365.sender }, async () => {
            throw substratError('permission_denied', 'nope');
          }),
          input({ attachmentIds: ['01SECRET'] }),
        ),
      );
      expect(e.status).toBe(403);
      expect(e.message).toContain('read permission');
      expect(m365.sent).toHaveLength(0);
    });

    it('more bytes than one message may carry is a 413, and nothing is sent', async () => {
      const m365 = recordingSender(['office@acme.example']);
      const half = Math.floor(TENANT_MAIL_MAX_ATTACHMENT_BYTES / 2) + 1;
      const e = await refusal(
        sendAsTenant(
          deps([connection('m365')], { m365: m365.sender }, async (_c, id) => file(id, half)),
          input({ attachmentIds: ['01A', '01B'] }),
        ),
      );
      expect(e.status).toBe(413);
      expect(m365.sent).toHaveLength(0);
    });
  });
});
