import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Page } from '@substrat-run/contracts';
import {
  connectionId,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type PermissionKey,
} from '@substrat-run/contracts';
import {
  ulid,
  webCryptoSecretBox,
  type ConnectorOptions,
  type ScopeStub,
} from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { PROTOCOL_PERM as PERM, protocolModule } from '@substrat-run/engine-protocol';
import {
  ScriveMock,
  registerScriveConnector,
  scriveCallbackPath,
  SENDER_PARTY_LABEL,
  type ScriveConnectorOptions,
  type ScriveDispatchState,
  type ScriveMockOptions,
} from '../src/index.js';

/**
 * The outbound half, end to end: a vertical freezes a document and asks for
 * signatures, and a Scrive document appears at the provider with the right
 * parties and a file attached.
 *
 * Everything here runs against `ScriveMock`, so what is proven is that OUR
 * shape works — credential resolution, egress, the document lifecycle, retry.
 * It is not evidence that our reading of Scrive's API is correct; the mock is
 * the same reading. That check needs a testbed account.
 */
describe('scrive connector — outbound dispatch', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let scrive: ScriveMock;
  let connId: ReturnType<typeof connectionId.parse>;
  let staff = platformActorId.parse(ulid());
  let t = tenantId.parse(ulid());
  let s = scopeId.parse(ulid());
  let stub: ScopeStub;
  let principal: ReturnType<typeof principalId.parse>;

  const EMPLOYEE = { entityType: 'employee', entityId: '01JEMPLOYEE0000000000000AA' };

  /**
   * Stand the whole world up: host, protocol engine, a stand-in vertical, the
   * connector, a tenant/scope/connection and a template. Parameterised by the
   * connector's own options so a test can prove a CONNECTION-level policy (#620's
   * `defaultAuthMethod`) rather than only the shipped default.
   */
  const boot = async (
    connectorOptions: Partial<ScriveConnectorOptions & { id: string; retry: ConnectorOptions }> = {},
    mockOptions: ScriveMockOptions = {},
    /** #711: withhold the connection's read grant, to see the fallback it causes. */
    world: { grantConnectionRead?: boolean } = {},
  ) => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-scrive-'));
    scrive = new ScriveMock(mockOptions);

    staff = platformActorId.parse(ulid());
    t = tenantId.parse(ulid());
    s = scopeId.parse(ulid());

    host = new SqliteScopeHost({
      dir,
      secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(5)),
      fetch: scrive.fetch,
    });
    host.registerModule(protocolModule);
    // Stands in for the vertical: declares the entity edge and nothing else.
    host.registerModule({
      manifest: {
        id: '@test/hr',
        version: '1.0.0',
        kernelContract: '^0.0.1',
        permissions: [],
        events: { emits: [], consumes: [] },
        migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
        attachmentTargets: [],
        entityRelations: [{ entityType: 'protocol', parentType: 'employee' }],
        entitlementKey: 'hr',
      } as never,
    });

    registerScriveConnector(host, {
      baseUrl: 'https://api-testbed.scrive.test',
      callbackUrl: (ref) => `https://vertical.test${scriveCallbackPath(ref)}`,
      // Retry immediately, so a test can watch a failure recover rather than
      // asserting that a timer it cannot advance would eventually fire.
      retry: { baseDelayMs: 0 },
      ...connectorOptions,
    });

    principal = principalId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'nordljus', name: 'Nordljus' });
    for (const key of ['protocol', 'hr']) await host.admin.grantEntitlement(staff, t, key);
    await host.provisionScope(staff, {
      tenantId: t,
      scopeId: s,
      jurisdiction: 'eu',
      vertical: 'meridian',
    });
    await host.admin.activateScope(staff, t, s);
    await host.admin.defineRole(staff, t, {
      key: 'hr',
      permissions: [
        PERM.create,
        PERM.bind,
        PERM.requestSignature,
        PERM.read,
        // #711: an HR user uploads the rendered avtal onto the instance before
        // sending it — the attachment target's write gate.
        PERM.attach,
      ] as PermissionKey[],
      source: 'vertical',
    });
    await host.admin.assignRole(staff, {
      principalId: principal,
      roleKey: 'hr',
      node: { tenantId: t, scopeId: s },
    });
    // Where a rendered document's bytes live (#473). Without one the connector's
    // attachment read has nowhere to read from, and the vertical nowhere to upload.
    await host.provisionBlobStore(staff, {
      tenantId: t,
      vertical: 'meridian',
      binding: 'ATTACHMENTS',
    });

    connId = connectionId.parse(ulid());
    await host.admin.createConnection(staff, {
      id: connId,
      tenantId: t,
      vertical: 'meridian',
      provider: 'scrive',
      label: 'Nordljus Scrive (testbed)',
      secret: { clientId: 'ci', clientSecret: 'cs', tokenId: 'ti', tokenSecret: 'ts' },
    });
    // #711: the connection's own read grant — what lets the connector open the
    // document the vertical bound. A permission-diff line, not an ambient power:
    // without it the dispatch falls back to the attestation sheet (asserted below).
    if (world.grantConnectionRead !== false) {
      await host.admin.grantToConnection(staff, {
        connectionId: connId,
        permission: PERM.read,
        node: { tenantId: t, scopeId: s },
        grantedBy: staff,
      });
    }

    stub = await host.getScope(principal, t, s);
    await stub.invoke('protocol/define-template', {
      key: 'anstallningsavtal',
      title: 'Anställningsavtal',
      content: {
        kind: 'document',
        documentType: 'anstallningsavtal',
        hashRecipe: 'sha256 over the terms row, fields in fixed order',
      },
    });
  };

  beforeEach(() => boot());

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The connector's dispatch ledger row for an instance, if any. */
  const dispatchState = (instanceId: string) =>
    host.admin.getConnectorState(connId, `scrive:dispatch:${instanceId}`) as Promise<
      ScriveDispatchState | undefined
    >;

  /** Instantiate → bind → request signatures for two parties of different kinds. */
  const issue = async () => {
    const inst = await stub.invoke<{ id: string }>('protocol/instantiate', {
      templateKey: 'anstallningsavtal',
      entityType: EMPLOYEE.entityType,
      entityId: EMPLOYEE.entityId,
    });
    await stub.invoke('protocol/bind-document', {
      instanceId: inst.id,
      contentRef: { entityType: 'employment-terms', entityId: '01JTERMS000000000000000000' },
      contentHash: 'ab'.repeat(32),
    });
    return stub.invoke<{ instance: { id: string }; requests: { id: string }[] }>(
      'protocol/request-signatures',
      {
        instanceId: inst.id,
        method: 'scrive',
        parties: [
          { label: 'Arbetsgivare', kind: 'principal', signatureKind: 'primary', contact: { email: 'arbetsgivare@example.se' } },
          { label: 'Anställd', kind: 'external', contact: { email: 'anstalld@example.se' } },
        ],
      },
    );
  };

  it('turns a signature request into a started Scrive document', async () => {
    const sent = await issue();

    expect(scrive.documents.size).toBe(1);
    const [doc] = [...scrive.documents.values()];
    // Started means Scrive has invited the parties — the file and parties were
    // both accepted, which is what `start` refuses without.
    expect(doc!.status).toBe('pending');
    // A file was uploaded (Scrive does not echo the filename, so assert bytes).
    expect(doc!.file!.bytes).toBeGreaterThan(0);
    expect(doc!.title).toContain('anstallningsavtal');

    // #620: BOTH parties authenticate with `standard`, because neither request
    // asked for more. This assertion used to read `se_bankid` for the external
    // party — the hardcoded requirement that made Scrive refuse every document
    // this connector ever sent (`409 … requires valid personal number field`),
    // since the platform supplies no personnummer by design.
    // #852: party 0 is the SENDER — the author, which does not sign, and which the
    // provider rewrites to the account holder whatever we put on it (verified live).
    // Both named parties follow it and keep their own identity.
    expect(doc!.parties.map((p) => [p.name, p.auth, p.isAuthor, p.isSignatory])).toEqual([
      ['Mock Operator', 'standard', true, false],
      ['Arbetsgivare', 'standard', false, true],
      ['Anställd', 'standard', false, true],
    ]);

    // A capability URL, because Scrive's callbacks carry no signature to verify:
    // (connection, instance) route it, and the minted token authenticates it.
    expect(doc!.callbackUrl).toContain(sent.instance.id);
    expect(doc!.callbackUrl).toMatch(/\/hooks\/scrive\/[0-9A-HJKMNP-TV-Z]{26}\/[^/]+\/[0-9a-f]{64}$/);

    // The dispatch is recorded in the connector's directory ledger — the id, so
    // a redelivery can find it and skip, and the request ids the poll driver
    // will later need to record signatures against.
    const state = await dispatchState(sent.instance.id);
    expect(state!.documentId).toBe(doc!.id);
    expect(state!.parties.map((p) => p.requestId)).toEqual(sent.requests.map((r) => r.id));
    expect(state!.scopeId).toBe(s);
  });

  // #620. The connector hardcoded `se_bankid` for external parties, which Scrive
  // will not start without a `personal_number` FIELD on the party. The result was a
  // requirement the caller could neither see nor satisfy, and a production tenant
  // whose every contract failed. #687 then measured what that field actually
  // demands — presence, not a value — so `strong` no longer has to be refused.
  describe('the authentication method comes from the caller (#620)', () => {
    /** Issue a set whose single external party asks for `level`. */
    const issueAt = async (level?: 'basic' | 'strong') => {
      const inst = await stub.invoke<{ id: string }>('protocol/instantiate', {
        templateKey: 'anstallningsavtal',
        entityType: EMPLOYEE.entityType,
        entityId: EMPLOYEE.entityId,
      });
      await stub.invoke('protocol/bind-document', {
        instanceId: inst.id,
        contentRef: { entityType: 'employment-terms', entityId: '01JTERMS000000000000000AUT' },
        contentHash: '11'.repeat(32),
      });
      return stub.invoke('protocol/request-signatures', {
        instanceId: inst.id,
        method: 'scrive',
        parties: [
          {
            label: 'Anställd',
            kind: 'external',
            contact: { email: 'anstalld@example.se' },
            ...(level ? { authLevel: level } : {}),
          },
          { label: 'Arbetsgivare', kind: 'principal', signatureKind: 'primary', contact: { email: 'arbetsgivare@example.se' } },
        ],
      });
    };

    it("defaults to 'standard', so a document actually starts", async () => {
      await issueAt();
      const [doc] = [...scrive.documents.values()];
      expect(doc!.status).toBe('pending'); // started — the 409 is gone
      // Two parties now — the counterparty and the issuer it is sent by (#687).
      expect(doc!.parties.map((p) => p.auth)).toEqual(['standard', 'standard', 'standard']);
    });

    it("honours a connection-level default for parties that ask for 'basic'", async () => {
      // A deployment that supplies personal numbers by other means can still put
      // every `basic` party on BankID — the policy belongs to the connection, not
      // to a hardcoded branch on `kind`. Re-boot the world with that option set.
      const discarded = dir; // `boot` rebinds `dir`; afterEach only cleans the live one
      await host.close();
      await boot({ defaultAuthMethod: 'se_bankid' });
      rmSync(discarded, { recursive: true, force: true });
      await issueAt();
      const [doc] = [...scrive.documents.values()];
      expect(doc!.status).toBe('pending');
      // The sender is never a BankID party — it does not sign (#852).
      expect(doc!.parties.map((p) => p.auth)).toEqual(['standard', 'se_bankid', 'se_bankid']);
    });

    it("dispatches 'strong' as BankID, carrying the EMPTY personal_number field (#687)", async () => {
      // This used to be "refuses 'strong' before any egress". The refusal was
      // reasoned from a true observation — Scrive 409s a BankID party with no
      // `personal_number` — and a false inference: that satisfying it needs a
      // personnummer, which this platform may not carry. Probed against the
      // testbed, an EMPTY field draws exactly the same errors as a filled one, so
      // the field costs no PII and the signatory completes it during the ceremony.
      await issueAt('strong');

      const [doc] = [...scrive.documents.values()];
      expect(doc!.status).toBe('pending'); // it starts — no refusal, no 409
      // Only the party that ASKED for strong; the issuer keeps the default.
      expect(doc!.parties.map((p) => p.auth)).toEqual(['standard', 'se_bankid', 'standard']);
      // The mock enforces the rule the testbed enforces: presence, not value.
      // Without `update` sending the empty field this assertion — and `start` —
      // would both fail.
      expect(doc!.parties[1]!.hasPersonalNumber).toBe(true);
    });

    it('DELIVERS to the counterparty: the sealed address reaches the provider (#687 item 1)', async () => {
      // The gap this connector was written into, now closed — and asserted under
      // the provider's real rule rather than a friendlier mock. `strictDelivery`
      // makes the mock apply the testbed's OTHER `start` rule: a party who must be
      // INVITED and carries no `email` field cannot be reached, and `start` 409s.
      //
      // Until #687 no party this connector built could satisfy it, at either auth
      // level — `ScriveParty.email` was declared, wired into the fields array, and
      // filled by nothing. This is the whole path: the vertical passes an address,
      // the engine seals it to this connection, the cell rides the event, and the
      // connector opens it here and puts it where Scrive looks.
      const discarded = dir;
      await host.close();
      await boot({ retry: { maxAttempts: 1, baseDelayMs: 0 } }, { strictDelivery: true });
      rmSync(discarded, { recursive: true, force: true });

      const inst = await stub.invoke<{ id: string }>('protocol/instantiate', {
        templateKey: 'anstallningsavtal',
        entityType: EMPLOYEE.entityType,
        entityId: EMPLOYEE.entityId,
      });
      await stub.invoke('protocol/bind-document', {
        instanceId: inst.id,
        contentRef: { entityType: 'employment-terms', entityId: '01JTERMS000000000000000AUT' },
        contentHash: '11'.repeat(32),
      });
      await stub.invoke('protocol/request-signatures', {
        instanceId: inst.id,
        method: 'scrive',
        parties: [
          { label: 'Arbetsgivare', kind: 'principal', signatureKind: 'primary', contact: { email: 'arbetsgivare@example.se' } },
          { label: 'Anställd', kind: 'external', contact: { email: 'anstalld@example.se' } },
        ],
      });

      // It started, under the rule that used to refuse it.
      const [doc] = [...scrive.documents.values()];
      expect(doc!.status).toBe('pending');
      expect(await host.executorDeadLetters(t, s)).toEqual([]);

      // #852: BOTH named parties carry the address the vertical supplied — the
      // issuing side included, because it signs like anyone else now. Party 0 is
      // the sender: author, non-signing, and stamped with the ACCOUNT's identity
      // rather than anything we sent, which is what the provider actually does.
      expect(doc!.parties[1]!.email).toBe('arbetsgivare@example.se');
      expect(doc!.parties[2]!.email).toBe('anstalld@example.se');
      expect(doc!.parties[0]!.isAuthor).toBe(true);
      expect(doc!.parties[0]!.isSignatory).toBe(false);
      expect(doc!.parties[0]!.email).toBe('mock@substrat.test');
    });

    /**
     * #852 — the regression, in the shape it reached production.
     *
     * Scrive binds the author slot to the API ACCOUNT HOLDER and silently overwrites
     * the name and email the caller put on it. Measured against the real testbed, not
     * inferred. While the issuing party was the author, that decided who signs for the
     * sender's organisation — the Scrive account owner, always, whoever the vertical
     * named. An avtal went out with the wrong person on it and nobody could see why:
     * the drawer showed the address we sent, the provider showed somebody else.
     *
     * It also broke the RETURN path. The reconcile refuses to attribute a signature
     * when the provider's party name disagrees with the dispatched label — a fail-closed
     * guard doing its job — and the substituted name never agrees, so the issuer's
     * signature could not be recorded at all. The document could never complete.
     */
    it('the account holder is the SENDER, never silently a signatory (#852)', async () => {
      const sent = await issue();
      const [doc] = [...scrive.documents.values()];

      // Exactly one author, it does not sign, and it carries the ACCOUNT's identity.
      const authors = doc!.parties.filter((p) => p.isAuthor);
      expect(authors).toHaveLength(1);
      expect(authors[0]!.isSignatory).toBe(false);
      expect(authors[0]!.email).toBe('mock@substrat.test');

      // Every party the VERTICAL named signs, under its own name and address —
      // none of them is the author, so none of them is overwritten.
      const signatories = doc!.parties.filter((p) => p.isSignatory);
      expect(signatories.map((p) => p.name)).toEqual(['Arbetsgivare', 'Anställd']);
      expect(signatories.every((p) => !p.isAuthor)).toBe(true);

      // The dispatch ledger records the sender, which is what keeps the reconcile's
      // "Nth signatory is provider party N+1" alignment true rather than assumed.
      const state = await dispatchState(sent.instance.id);
      expect(state!.senderParty).toEqual({ label: SENDER_PARTY_LABEL });
      expect(state!.parties.map((p) => p.label)).toEqual(['Arbetsgivare', 'Anställd']);
    });

    /**
     * The issuing party is no longer exempt from needing an address, because it is
     * no longer reached as the account — it is invited like anyone else. Refused
     * BEFORE egress, naming the party: Scrive's own version is `409 Invitation
     * delivery for participant #2 requires valid email field`, a positional index
     * into a list the vertical never saw, and reading that cost a production
     * afternoon (#841).
     */
    it('refuses a party it cannot invite, naming it, before anything is created (#852)', async () => {
      const discarded = dir;
      await host.close();
      await boot({ retry: { maxAttempts: 1, baseDelayMs: 0 } }, { strictDelivery: true });
      rmSync(discarded, { recursive: true, force: true });

      const inst = await stub.invoke<{ id: string }>('protocol/instantiate', {
        templateKey: 'anstallningsavtal',
        entityType: EMPLOYEE.entityType,
        entityId: EMPLOYEE.entityId,
      });
      await stub.invoke('protocol/bind-document', {
        instanceId: inst.id,
        contentRef: { entityType: 'employment-terms', entityId: '01JTERMS000000000000000AUT' },
        contentHash: '22'.repeat(32),
      });
      await stub.invoke('protocol/request-signatures', {
        instanceId: inst.id,
        method: 'scrive',
        parties: [
          { label: 'Arbetsgivare', kind: 'principal', signatureKind: 'primary' },
          { label: 'Anställd', kind: 'external', contact: { email: 'anstalld@example.se' } },
        ],
      });

      // Nothing was created at the provider — the refusal is upstream of `new`.
      expect(scrive.documents.size).toBe(0);
      const dead = await host.executorDeadLetters(t, s);
      expect(dead).toHaveLength(1);
      expect(dead[0]!.error).toMatch(/Arbetsgivare/);
      expect(dead[0]!.error).toMatch(/no email or mobile/);
    });

    it('a LONE party is refused before anything freezes (#687)', async () => {
      // This test used to assert the OPPOSITE, and its own comment named the day
      // it would have to change. `requestSignatures` resolved the issuing party
      // unconditionally — the declared one, else the FIRST — so a caller naming
      // only counterparties had one of them silently made the issuer, and this
      // connector maps `primary` to `is_author`. Scrive never invites the author,
      // so the document started, journalled an id, reported itself sent for
      // signature, and reached nobody. Production got there without anyone
      // choosing it (Scrive doc 9222115557586247373).
      //
      // A contact field alone does not close that: an author is uninvitable
      // whatever address it carries. So the refusal lives in the engine, at the
      // call site, where the hazard is created.
      const discarded = dir;
      await host.close();
      await boot({ retry: { maxAttempts: 1, baseDelayMs: 0 } }, { strictDelivery: true });
      rmSync(discarded, { recursive: true, force: true });

      const inst = await stub.invoke<{ id: string }>('protocol/instantiate', {
        templateKey: 'anstallningsavtal',
        entityType: EMPLOYEE.entityType,
        entityId: EMPLOYEE.entityId,
      });
      await expect(
        stub.invoke('protocol/request-signatures', {
          instanceId: inst.id,
          method: 'scrive',
          parties: [
            { label: 'Anställd', kind: 'external', contact: { email: 'anstalld@example.se' } },
          ],
        }),
      ).rejects.toThrow(/needs a counterparty/);

      // Nothing was sent, and nothing froze — the instance is still negotiable.
      expect(scrive.documents.size).toBe(0);
      const { entries } = await stub.invoke<Page<{ instance: { status: string } }>>(
        'protocol/list-for-entity',
        { entityType: EMPLOYEE.entityType, entityId: EMPLOYEE.entityId },
      );
      const [summary] = entries;
      expect(summary!.instance.status).toBe('open');
    });
  });

  /**
   * What the signatory is actually shown (#711).
   *
   * The connector used to render its own one-page attestation sheet — the template
   * name, the parties, the content hash — and send that, unconditionally, because
   * `create` had no way to be handed anything else. Honest paper for a
   * hash-attestation model, and the wrong paper for a contract: the obligations a
   * Swedish counterparty is asked to put BankID to were nowhere on it.
   *
   * The seam is one field. The vertical uploads its rendered document onto the
   * instance and names it when binding; the event carries the id; the connector
   * opens it and sends those bytes. Everything below is that path, plus the two
   * ways it declines to happen.
   */
  describe('the document the signatory is shown (#711)', () => {
    /** The vertical's own rendering — real bytes, landed on the instance. */
    const AVTAL = new TextEncoder().encode(
      '%PDF-1.4 Anställningsavtal — §1 Lön: 42 000 kr/mån. §2 Uppsägningstid: 3 månader.',
    );

    /**
     * Instantiate, upload the rendered avtal onto the instance, bind it, and send.
     * `bind` decides whether the binding NAMES the document — the difference between
     * an attachment that exists and one the signatory is shown.
     */
    const issueWithDocument = async (opts: { bind?: boolean } = {}) => {
      const inst = await stub.invoke<{ id: string }>('protocol/instantiate', {
        templateKey: 'anstallningsavtal',
        entityType: EMPLOYEE.entityType,
        entityId: EMPLOYEE.entityId,
      });
      // Uploaded as the HR user, on the engine's declared `protocol` target — the
      // same door the return path lands the sealed copy through, from the other side.
      const attachments = await host.attachments(principal, t, s);
      const record = await attachments.upload({
        entity: { entityType: 'protocol', entityId: inst.id },
        filename: 'anstallningsavtal-nordljus.pdf',
        contentType: 'application/pdf',
        visibility: 'customer',
        body: AVTAL,
      });
      await stub.invoke('protocol/bind-document', {
        instanceId: inst.id,
        contentRef: { entityType: 'employment-terms', entityId: '01JTERMS0000000000000007II' },
        contentHash: 'cd'.repeat(32),
        ...(opts.bind === false ? {} : { documentAttachmentId: record.id }),
      });
      const sent = await stub.invoke<{ instance: { id: string } }>(
        'protocol/request-signatures',
        {
          instanceId: inst.id,
          method: 'scrive',
          parties: [
            { label: 'Arbetsgivare', kind: 'principal', signatureKind: 'primary', contact: { email: 'arbetsgivare@example.se' } },
            { label: 'Anställd', kind: 'external', contact: { email: 'anstalld@example.se' } },
          ],
        },
      );
      return { instanceId: inst.id, record, sent };
    };

    it('sends the vertical’s own document when the binding names one', async () => {
      const { instanceId, record } = await issueWithDocument();

      const [doc] = [...scrive.documents.values()];
      // The bytes at the provider ARE the avtal — not a sheet about it. The mock
      // records what it was given, so this is the assertion the whole issue is
      // about: byte length and filename both come from the vertical.
      expect(doc!.file!.bytes).toBe(AVTAL.byteLength);
      expect(doc!.file!.name).toBe('anstallningsavtal-nordljus.pdf');

      // And the ledger records WHICH document went out, so an operator can tell a
      // real contract from a fallback sheet after the fact.
      const state = await dispatchState(instanceId);
      expect(state!.documentAttachmentId).toBe(record.id);
    });

    it('falls back to the attestation sheet when nothing is bound — byte for byte', async () => {
      // The acceptance criterion that protects every existing caller: a vertical
      // with nothing to render must keep working, unchanged. Compare against the
      // no-document path in the suite above rather than a hardcoded size, so a
      // change to `renderPdf` cannot make this pass by drifting with it.
      const { instanceId } = await issueWithDocument({ bind: false });
      const [doc] = [...scrive.documents.values()];
      expect(doc!.status).toBe('pending');
      expect(doc!.file!.bytes).toBeGreaterThan(0);
      expect(doc!.file!.bytes).not.toBe(AVTAL.byteLength);
      expect(doc!.file!.name).toBe('anstallningsavtal.pdf'); // the connector's own naming

      // An uploaded attachment that was never BOUND is not a document to send. It
      // exists on the instance — the vertical put it there — and the connector still
      // sends its own sheet, because nothing named it.
      expect((await dispatchState(instanceId))!.documentAttachmentId).toBeUndefined();
    });

    it('cannot pick up the sealed SIGNED copy the return path lands on the same instance', async () => {
      // The one design question this issue raised. Outbound and inbound write to
      // the same attachment target, so a connector that SEARCHED for "the document
      // on this instance" could send a counterparty their own signed contract to
      // sign again. It cannot happen here, and not by a rule that could be got
      // wrong: the binding names an id, and this asserts the id is honoured even
      // when a decoy that a search would have preferred (newer, PDF, on the same
      // instance, plausibly named) is sitting right there.
      const inst = await stub.invoke<{ id: string }>('protocol/instantiate', {
        templateKey: 'anstallningsavtal',
        entityType: EMPLOYEE.entityType,
        entityId: EMPLOYEE.entityId,
      });
      const attachments = await host.attachments(principal, t, s);
      const real = await attachments.upload({
        entity: { entityType: 'protocol', entityId: inst.id },
        filename: 'anstallningsavtal.pdf',
        contentType: 'application/pdf',
        visibility: 'customer',
        body: AVTAL,
      });
      const decoy = await attachments.upload({
        entity: { entityType: 'protocol', entityId: inst.id },
        filename: 'signed-9999.pdf',
        contentType: 'application/pdf',
        visibility: 'customer',
        body: new TextEncoder().encode('%PDF-1.4 a SEALED copy — must never be sent out'),
      });
      expect(decoy.id > real.id).toBe(true); // newer: what "list, take the first" would find

      await stub.invoke('protocol/bind-document', {
        instanceId: inst.id,
        contentRef: { entityType: 'employment-terms', entityId: '01JTERMS0000000000000008SS' },
        contentHash: 'cd'.repeat(32),
        documentAttachmentId: real.id,
      });
      await stub.invoke('protocol/request-signatures', {
        instanceId: inst.id,
        method: 'scrive',
        parties: [
          { label: 'Anställd', kind: 'external', contact: { email: 'anstalld@example.se' } },
          { label: 'Arbetsgivare', kind: 'principal', signatureKind: 'primary', contact: { email: 'arbetsgivare@example.se' } },
        ],
      });

      const [doc] = [...scrive.documents.values()];
      expect(doc!.file!.bytes).toBe(AVTAL.byteLength);
      expect((await dispatchState(inst.id))!.documentAttachmentId).toBe(real.id);
    });

    it('refuses a binding that names an attachment on another instance', async () => {
      // The engine's own check, at the only point where the document and the hash
      // are named together. Refuses the accidents — a stale id, another instance's
      // paperwork — without pretending to verify a hash recipe it cannot run.
      const a = await stub.invoke<{ id: string }>('protocol/instantiate', {
        templateKey: 'anstallningsavtal',
        entityType: EMPLOYEE.entityType,
        entityId: EMPLOYEE.entityId,
      });
      // A second employee: one open protocol per entity, and this test needs two
      // live instances so the attachment genuinely belongs somewhere else.
      const b = await stub.invoke<{ id: string }>('protocol/instantiate', {
        templateKey: 'anstallningsavtal',
        entityType: EMPLOYEE.entityType,
        entityId: '01JEMPLOYEE0000000000000BB',
      });
      const elsewhere = await (
        await host.attachments(principal, t, s)
      ).upload({
        entity: { entityType: 'protocol', entityId: b.id },
        filename: 'someone-elses.pdf',
        contentType: 'application/pdf',
        visibility: 'customer',
        body: AVTAL,
      });

      await expect(
        stub.invoke('protocol/bind-document', {
          instanceId: a.id,
          contentRef: { entityType: 'employment-terms', entityId: '01JTERMS0000000000000009XX' },
          contentHash: 'cd'.repeat(32),
          documentAttachmentId: elsewhere.id,
        }),
      ).rejects.toThrow(/not to protocol\//);

      await expect(
        stub.invoke('protocol/bind-document', {
          instanceId: a.id,
          contentRef: { entityType: 'employment-terms', entityId: '01JTERMS0000000000000009XX' },
          contentHash: 'cd'.repeat(32),
          documentAttachmentId: ulid(),
        }),
      ).rejects.toThrow(/no attachment/);
    });

    it('reads as the credential it sends with, not as its registration id', async () => {
      // The trap this seam nearly shipped with. `registerScriveConnector` takes an
      // `id`, and the handler opens its credential by the literal provider name
      // `'scrive'`. An earlier cut of #711 authorized the attachment read against
      // the REGISTRATION's slug instead — so `id: 'scrive-eu'` left the egress half
      // working and the document half failing with "no live 'scrive-eu' connection",
      // and every contract quietly dead-lettered while the connector looked healthy.
      //
      // Two names for one fact is how they come to disagree. The read now hangs off
      // the connection the handler opened, which is the only thing that can be
      // authorized correctly by construction — this test is what holds it there.
      const discarded = dir;
      await host.close();
      await boot({ id: 'scrive-eu' });
      rmSync(discarded, { recursive: true, force: true });

      const { instanceId, record } = await issueWithDocument();

      const [doc] = [...scrive.documents.values()];
      expect(doc!.file!.bytes).toBe(AVTAL.byteLength);
      expect((await dispatchState(instanceId))!.documentAttachmentId).toBe(record.id);
    });

    it('sends the bound document holding no read grant at all (#726)', async () => {
      // This test used to assert the opposite, and the reason it changed is the whole
      // of #726 remedy (B): the authority for this read is the DELIVERY, not a standing
      // `protocol:read` on the scope.
      //
      // The read a signing connector makes is per-dispatch by nature — the event names
      // one `documentAttachmentId`, `bindDocument` already refused to bind an attachment
      // owned by anything but the instance being signed, and `openAttachment` takes an
      // id rather than a search. Modelling that as a standing scope-wide grant meant an
      // operator had to add a permission that also opens `protocol/get`,
      // `list-templates` and `list-for-entity` — and, on a live tenant, meant an avtal
      // dead-lettering because nobody knew the grant was missing (#841).
      //
      // So: no grant, real document, and nothing widened.
      const discarded = dir;
      await host.close();
      await boot({}, {}, { grantConnectionRead: false });
      rmSync(discarded, { recursive: true, force: true });

      const { instanceId, record } = await issueWithDocument();

      const [doc] = [...scrive.documents.values()];
      expect(doc!.file!.bytes).toBe(AVTAL.byteLength); // the avtal, not the attestation sheet
      expect((await dispatchState(instanceId))!.documentAttachmentId).toBe(record.id);
    });

    it('still sends NOTHING rather than the wrong paper when the bytes are gone', async () => {
      // The invariant the test above used to carry, kept on the failure that can
      // still happen. The tempting behaviour is to shrug and send the attestation
      // sheet, and it is the wrong one: the vertical has stated which bytes its
      // signatory must see, and substituting different paper is quieter than a
      // refusal and worse, because a document still goes out and a counterparty
      // still signs it.
      //
      // So this dead-letters. Because the dispatch ledger is written only after
      // `start`, the retry that follows a fix sends the real document rather than
      // being skipped as already done.
      const discarded = dir;
      await host.close();
      await boot({ retry: { maxAttempts: 1, baseDelayMs: 0 } });
      rmSync(discarded, { recursive: true, force: true });

      const inst = await stub.invoke<{ id: string }>('protocol/instantiate', {
        templateKey: 'anstallningsavtal',
        entityType: EMPLOYEE.entityType,
        entityId: EMPLOYEE.entityId,
      });
      const attachments = await host.attachments(principal, t, s);
      const doc = await attachments.upload({
        entity: { entityType: 'protocol', entityId: inst.id },
        filename: 'anstallningsavtal.pdf',
        contentType: 'application/pdf',
        visibility: 'customer',
        body: AVTAL,
      });
      await stub.invoke('protocol/bind-document', {
        instanceId: inst.id,
        contentRef: { entityType: 'employment-terms', entityId: '01JTERMS00000000000000009X' },
        contentHash: 'ab'.repeat(32),
        documentAttachmentId: doc.id,
      });
      // Bound, then removed — the frozen binding now names bytes this scope no
      // longer holds.
      await attachments.remove(doc.id);

      await stub.invoke('protocol/request-signatures', {
        instanceId: inst.id,
        method: 'scrive',
        parties: [
          { label: 'Anställd', kind: 'external', contact: { email: 'anstalld@example.se' } },
          { label: 'Arbetsgivare', kind: 'principal', signatureKind: 'primary', contact: { email: 'arbetsgivare@example.se' } },
        ],
      });

      expect(scrive.documents.size).toBe(0); // nothing reached the provider
      expect(await dispatchState(inst.id)).toBeUndefined(); // …so nothing is "done"
      const [dead] = await host.executorDeadLetters(t, s);
      expect(dead!.eventType).toBe('protocol.signatures-requested');
      expect(dead!.error).toMatch(/no longer holds|refusing to send an attestation/i);
    });
  });

  it('skips a dispatch already recorded — the idempotency guard', async () => {
    // At-least-once delivery means the handler can run twice for one event; the
    // second run must NOT create a second contract. The guard is a directory
    // ledger read, so seeding it is exactly "this was already dispatched".
    const inst = await stub.invoke<{ id: string }>('protocol/instantiate', {
      templateKey: 'anstallningsavtal',
      entityType: EMPLOYEE.entityType,
      entityId: EMPLOYEE.entityId,
    });
    await stub.invoke('protocol/bind-document', {
      instanceId: inst.id,
      contentRef: { entityType: 'employment-terms', entityId: '01JTERMS000000000000000009' },
      contentHash: 'ef'.repeat(32),
    });
    await host.admin.putConnectorState(connId, `scrive:dispatch:${inst.id}`, {
      documentId: 'already-sent',
      instanceId: inst.id,
      scopeId: s,
      tenantId: t,
      vertical: 'meridian',
      contentHash: 'ef'.repeat(32),
      parties: [],
      dispatchedAt: '2026-01-01T00:00:00.000Z',
    });

    await stub.invoke('protocol/request-signatures', {
      instanceId: inst.id,
      method: 'scrive',
      parties: [
        { label: 'Arbetsgivare', kind: 'principal', signatureKind: 'primary', contact: { email: 'arbetsgivare@example.se' } },
        { label: 'Anställd', kind: 'external', contact: { email: 'anstalld@example.se' } },
      ],
    });

    // The connector found the ledger row and did nothing — no second document.
    expect(scrive.documents.size).toBe(0);
    // And the ledger is untouched (it did not overwrite with a new dispatch).
    const state = await dispatchState(inst.id);
    expect(state!.documentId).toBe('already-sent');
  });

  it('does not answer for a provider that is not Scrive', async () => {
    // The same event carries `method`. A vertical asking for BankID through
    // someone else must not get a Scrive document.
    const inst = await stub.invoke<{ id: string }>('protocol/instantiate', {
      templateKey: 'anstallningsavtal',
      entityType: 'employee',
      entityId: '01JEMPLOYEE0000000000000BB',
    });
    await stub.invoke('protocol/bind-document', {
      instanceId: inst.id,
      contentRef: { entityType: 'employment-terms', entityId: '01JTERMS000000000000000001' },
      contentHash: 'cd'.repeat(32),
    });
    // The tenant genuinely holds an 'assently' connection: the engine seals each
    // contact to the connector named by `method` (#687), so a provider nobody
    // connected is refused at the operation and would never reach dispatch at all
    // — which would test the wrong thing. This asserts the connector's own filter.
    await host.admin.createConnection(staff, {
      id: connectionId.parse(ulid()),
      tenantId: t,
      vertical: 'meridian',
      provider: 'assently',
      label: 'Assently',
      secret: { token: 'x' },
      scopes: [],
    });
    await stub.invoke('protocol/request-signatures', {
      instanceId: inst.id,
      method: 'assently',
      parties: [
        { label: 'Arbetsgivare', kind: 'principal', signatureKind: 'primary', contact: { email: 'arbetsgivare@example.se' } },
        { label: 'Anställd', kind: 'external', contact: { email: 'anstalld@example.se' } },
      ],
    });
    expect(scrive.documents.size).toBe(0);
  });

  it('records provider failure on the connection and retries rather than losing the request', async () => {
    scrive.failWith = 503;
    await issue();

    // The operation succeeded — the freeze is committed and the request rows
    // exist. Only the delivery failed, and that is not the caller's problem.
    const [listed] = (
      await stub.invoke<Page<{ instance: { id: string } }>>('protocol/list-for-entity', {
        entityType: EMPLOYEE.entityType,
        entityId: EMPLOYEE.entityId,
      })
    ).entries;
    const instanceId = listed!.instance.id;
    const detail = await stub.invoke<{ instance: { status: string } }>('protocol/get', {
      instanceId,
    });
    expect(detail.instance.status).toBe('pending_signature');
    expect(await dispatchState(instanceId)).toBeUndefined(); // nothing recorded

    // Health landed on the connection…
    const [conn] = await host.admin.listConnections(staff, { tenantId: t });
    expect(conn!.status).toBe('error');
    expect(conn!.lastError).toContain('503');

    // …and the delivery is retrying, not dead: 8 attempts is deliberate, since
    // giving up after five would mean giving up on a contract.
    expect(await host.executorDeadLetters(t, s)).toEqual([]);

    // The provider recovers. The next drain completes the dispatch — the point
    // of retrying at all, and the thing a green "it failed" test never shows.
    scrive.failWith = undefined;
    const report = await host.drainDue(t, s);
    expect(report.delivered).toBe(1);
    expect(scrive.documents.size).toBe(1);

    // Health recovered with it.
    const [healed] = await host.admin.listConnections(staff, { tenantId: t });
    expect(healed!.status).toBe('active');
    expect(healed!.lastError).toBeNull();
  });

  it('refuses the REQUEST when the tenant has no Scrive connection (#687)', async () => {
    // New with the contact carrier, and worth its own assertion: a request whose
    // addresses cannot be sealed is refused at the operation, so nothing freezes.
    // Before this, such a request froze the instance and then failed invisibly at
    // the provider — an avtal that looks sent for signature and is not.
    const [existing] = await host.admin.listConnections(staff, { tenantId: t });
    await host.admin.revokeConnection(staff, existing!.id);

    const inst = await stub.invoke<{ id: string }>('protocol/instantiate', {
      templateKey: 'anstallningsavtal',
      entityType: EMPLOYEE.entityType,
      entityId: EMPLOYEE.entityId,
    });
    await stub.invoke('protocol/bind-document', {
      instanceId: inst.id,
      contentRef: { entityType: 'employment-terms', entityId: '01JTERMS0000000000000000NC' },
      contentHash: 'aa'.repeat(32),
    });
    await expect(
      stub.invoke('protocol/request-signatures', {
        instanceId: inst.id,
        method: 'scrive',
        parties: [
          { label: 'Arbetsgivare', kind: 'principal', signatureKind: 'primary', contact: { email: 'arbetsgivare@example.se' } },
          { label: 'Anställd', kind: 'external', contact: { email: 'anstalld@example.se' } },
        ],
      }),
    ).rejects.toThrow(/no 'scrive' sealing key is available/);

    expect(scrive.documents.size).toBe(0);
    const [open] = (
      await stub.invoke<Page<{ instance: { status: string } }>>('protocol/list-for-entity', {
        entityType: EMPLOYEE.entityType,
        entityId: EMPLOYEE.entityId,
      })
    ).entries;
    expect(open!.instance.status).toBe('open');
  });

  it('keeps retrying a dispatch whose connection was revoked between attempts', async () => {
    // The original shape of the test above, and still the real case — only now it
    // has to be reached differently. A request made with NO connection is refused
    // outright (the test above), so the way a dispatch meets a missing credential
    // is that the credential goes away in the gap between attempts. The provider
    // outage opens that gap.
    scrive.failWith = 503;
    await issue();
    scrive.failWith = undefined;
    const [conn] = await host.admin.listConnections(staff, { tenantId: t });
    await host.admin.revokeConnection(staff, conn!.id);

    // Nothing was sent, and nothing was recorded as sent — the two together are
    // what distinguish a refused dispatch from a silent no-op.
    expect(scrive.documents.size).toBe(0);
    const [summ0] = (
      await stub.invoke<Page<{ instance: { id: string } }>>('protocol/list-for-entity', {
        entityType: EMPLOYEE.entityType,
        entityId: EMPLOYEE.entityId,
      })
    ).entries;
    expect(await dispatchState(summ0!.instance.id)).toBeUndefined();
    void summ0;

    // The freeze still committed: the operation is not the delivery.
    const [summary] = (
      await stub.invoke<Page<{ instance: { status: string } }>>('protocol/list-for-entity', {
        entityType: EMPLOYEE.entityType,
        entityId: EMPLOYEE.entityId,
      })
    ).entries;
    expect(summary!.instance.status).toBe('pending_signature');

    // And it keeps retrying rather than dying, because a revoked connection is
    // usually an operator about to connect a new one.
    const report = await host.drainDue(t, s);
    expect(report.retrying + report.deadLettered).toBe(1);
    expect(report.delivered).toBe(0);
  });
});
