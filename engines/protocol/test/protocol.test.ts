import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { platformActorId, principalId, type EntityRef } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import {
  PROTOCOL_PERM as PERM,
  protocolModule,
  requireSigned,
  type ProtocolInstanceRow,
  type ProtocolSignatureRequestRow,
  type ProtocolTemplateRow,
  type SignResult,
} from '../src/index.js';

/**
 * The protocol engine, tested directly. Its reason to exist is one invariant —
 * **sign freezes the document forever** — and the compliance value of the whole
 * engine rests on that holding on the adverse paths, not the happy one.
 */

const BIKE: EntityRef = { entityType: 'workorder', entityId: '01JWORKORDER000000000000000' };
const ORDER = BIKE;

const CONTENT = {
  sections: [
    {
      title: 'Broms',
      items: [
        { key: 'front-brake', label: 'Frambroms', type: 'check' as const },
        { key: 'pad-mm', label: 'Belägg', type: 'value' as const, unit: 'mm' },
      ],
    },
  ],
};

describe('engine-protocol', () => {
  let h: EngineHarness;
  let staff: Awaited<ReturnType<EngineHarness['as']>>;

  beforeEach(async () => {
    h = await engineHarness({
      modules: [protocolModule],
      // The engine has never heard of a work order — a vertical declares this
      // edge, and the kernel refuses `ctx.link` without it. The harness plays
      // the vertical's part.
      entityRelations: [{ entityType: 'protocol', parentType: 'workorder' }],
      // #687: `requestSignatures` seals every party's delivery address to the
      // connector that will send the document, so the scope needs a live 'scrive'
      // connection to seal to. Without one the operation refuses — which is the
      // behaviour, not a fixture inconvenience, and has its own test below.
      connections: ['scrive'],
      // #711: the engine declares a `protocol` attachment target, and a rendered
      // document is bound through it. Bytes need the per-tenant store the platform
      // mints for a vertical, so the harness plays that part too.
      attachments: true,
    });
    staff = await h.as([
      PERM.create,
      PERM.fill,
      PERM.bind,
      PERM.requestSignature,
      PERM.recordSignature,
      PERM.sign,
      PERM.countersign,
      PERM.read,
      PERM.void,
    ]);
  });
  afterEach(async () => {
    await h.close();
  });

  const defineTemplate = (key = 'self-inspection', content = CONTENT) =>
    staff.invoke<ProtocolTemplateRow>('protocol/define-template', {
      key,
      title: 'Self-inspection',
      content,
    });

  const instantiate = (templateKey = 'self-inspection') =>
    staff.invoke<ProtocolInstanceRow>('protocol/instantiate', {
      templateKey,
      entityType: BIKE.entityType,
      entityId: BIKE.entityId,
    });

  // -- templates version immutably -----------------------------------------

  it('redefining a template makes a NEW version and never touches the old row', async () => {
    const v1 = await defineTemplate();
    expect(v1.version).toBe(1);

    const v2 = await defineTemplate('self-inspection', {
      sections: [{ title: 'Broms', items: [{ key: 'front-brake', label: 'Frambroms', type: 'check' }] }],
    });
    expect(v2.version).toBe(2);
    expect(v2.id).not.toBe(v1.id); // the v1 row still exists, untouched
  });

  it('an instance pins the template version it was created from', async () => {
    await defineTemplate();
    const inst = await instantiate();
    expect(inst.template_version).toBe(1);

    // Editing the template afterwards must not retro-change the instance.
    await defineTemplate('self-inspection', {
      sections: [{ title: 'Ny', items: [{ key: 'other', label: 'Annat', type: 'check' }] }],
    });
    const again = await staff.invoke<{ instance: ProtocolInstanceRow }>('protocol/get', {
      instanceId: inst.id,
    });
    expect(again.instance.template_version).toBe(1);
  });

  // -- the sign → immutable invariant --------------------------------------

  it('sign freezes the protocol: no further fill is accepted', async () => {
    await defineTemplate();
    const inst = await instantiate();
    await staff.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'front-brake', value: true });

    await staff.invoke('protocol/sign', { instanceId: inst.id });

    await expect(
      staff.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'pad-mm', value: '3.5' }),
    ).rejects.toThrow();
  });

  it('cannot sign twice — signing is once', async () => {
    await defineTemplate();
    const inst = await instantiate();
    await staff.invoke('protocol/sign', { instanceId: inst.id });
    await expect(staff.invoke('protocol/sign', { instanceId: inst.id })).rejects.toThrow(
      /only an open protocol can be signed/,
    );
  });

  it('sign emits protocol.signed with the content hash', async () => {
    await defineTemplate();
    const inst = await instantiate();
    await staff.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'front-brake', value: true });
    await staff.invoke('protocol/sign', { instanceId: inst.id });

    const [evt] = h.eventsOfType('protocol.signed');
    expect(evt).toBeDefined();
    expect(evt!.schemaVersion).toBe(1);
  });

  // -- the content hash is the tamper evidence ------------------------------

  it('refuses a second open instance of one template on one entity', async () => {
    await defineTemplate();
    await instantiate();
    await expect(instantiate()).rejects.toThrow(/already open/);
  });

  /** Sign a fresh instance on its own entity, answering `value`. */
  const signWith = async (entityId: string, value: boolean | string) => {
    const inst = await staff.invoke<ProtocolInstanceRow>('protocol/instantiate', {
      templateKey: 'self-inspection',
      entityType: 'workorder',
      entityId,
    });
    await staff.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'front-brake', value });
    return staff.invoke<SignResult>('protocol/sign', { instanceId: inst.id });
  };

  it('the content hash covers the RESPONSES — different answers, different hash', async () => {
    // The hash is the tamper evidence on a compliance artifact. If "brake OK"
    // and "brake NOT OK" hashed alike, the signature would attest to nothing.
    await defineTemplate();
    const passed = await signWith('01JWORKORDER000000000000001', true);
    const failed = await signWith('01JWORKORDER000000000000002', false);

    expect(passed.signature.content_hash).not.toBe(failed.signature.content_hash);
    expect(passed.signature.content_hash).toMatch(/^[0-9a-f]{64}$/); // SHA-256, hex
  });

  it('the content hash is identical for identical content — it is a function of the content', async () => {
    await defineTemplate();
    const a = await signWith('01JWORKORDER000000000000001', true);
    const b = await signWith('01JWORKORDER000000000000002', true);
    expect(a.signature.content_hash).toBe(b.signature.content_hash);
  });

  it('the content hash covers the TEMPLATE VERSION, not just the answers', async () => {
    // Same answer against a different template version must not attest alike —
    // otherwise a template edit could silently relabel what was signed.
    await defineTemplate();
    const v1 = await signWith('01JWORKORDER000000000000001', true);

    await defineTemplate('self-inspection', {
      sections: [
        {
          title: 'Broms',
          items: [
            { key: 'front-brake', label: 'Frambroms (reviderad)', type: 'check' as const },
            { key: 'pad-mm', label: 'Belägg', type: 'value' as const, unit: 'mm' },
          ],
        },
      ],
    });
    const v2 = await signWith('01JWORKORDER000000000000002', true);

    expect(v1.signature.content_hash).not.toBe(v2.signature.content_hash);
  });

  // -- the requireSigned guard ---------------------------------------------

  it('requireSigned throws while the protocol is open and passes once signed', async () => {
    await defineTemplate();
    const inst = await instantiate();

    await expect(h.run((ctx) => requireSigned(ctx, BIKE, 'self-inspection'))).rejects.toThrow();

    await staff.invoke('protocol/sign', { instanceId: inst.id });
    await expect(h.run((ctx) => requireSigned(ctx, BIKE, 'self-inspection'))).resolves.toBeUndefined();
  });

  // -- void -----------------------------------------------------------------

  it('void records a reason and takes the protocol out of play', async () => {
    await defineTemplate();
    const inst = await instantiate();
    const voided = await staff.invoke<ProtocolInstanceRow>('protocol/void', {
      instanceId: inst.id,
      reason: 'fel cykel',
    });
    expect(voided.status).toBe('voided');
    await expect(staff.invoke('protocol/sign', { instanceId: inst.id })).rejects.toThrow(
      /only an open protocol can be signed/,
    );
  });

  // -- permissions ----------------------------------------------------------

  it('is default-deny: a principal with no permissions does nothing', async () => {
    const nobody = await h.as([]);
    await expect(nobody.invoke('protocol/list-templates')).rejects.toThrow(/permission denied/);
  });

  it('separates fill from sign: a filler cannot sign', async () => {
    await defineTemplate();
    const inst = await instantiate();
    const filler = await h.as([PERM.read, PERM.fill]);
    await filler.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'front-brake', value: true });
    await expect(filler.invoke('protocol/sign', { instanceId: inst.id })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('separates sign from countersign — the second pair of eyes is a different key', async () => {
    await defineTemplate();
    const inst = await instantiate();
    const signer = await h.as([PERM.read, PERM.sign]);
    await signer.invoke('protocol/sign', { instanceId: inst.id });
    await expect(signer.invoke('protocol/countersign', { instanceId: inst.id })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('recording an external signature is its own key — signing does not confer it', async () => {
    // `protocol:record-signature` speaks for an external provider, not for a
    // person. A staff signer holding `protocol:sign` must not be able to assert
    // that some customer signed with BankID.
    const signer = await h.as([PERM.read, PERM.sign, PERM.requestSignature]);
    await expect(
      signer.invoke('protocol/record-signature', {
        requestId: 'whatever',
        signatory: { kind: 'external', ref: ulid() },
        signedAt: '2026-03-01T10:00:00.000Z',
        contentHash: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/permission denied/);
  });

  // -- document content kind -------------------------------------------------

  describe('the document content kind', () => {
    const AVTAL = { entityType: 'avtal', entityId: '01JAVTAL00000000000000000A' };
    const HASH_A = 'a1'.repeat(32);
    const HASH_B = 'b2'.repeat(32);

    const defineAvtal = () =>
      staff.invoke<ProtocolTemplateRow>('protocol/define-template', {
        key: 'avtal',
        title: 'Avtal',
        content: {
          kind: 'document',
          documentType: 'avtal',
          hashRecipe: 'sha256 over the avtal rows, line items sorted by article',
        },
      });

    const instantiateAvtal = (entityId = ORDER.entityId) =>
      staff.invoke<ProtocolInstanceRow>('protocol/instantiate', {
        templateKey: 'avtal',
        entityType: 'workorder',
        entityId,
      });

    it('carries no items: filling a document protocol is refused', async () => {
      await defineAvtal();
      const inst = await instantiateAvtal();
      await expect(
        staff.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'anything', value: true }),
      ).rejects.toThrow(/carries no items/);
    });

    it('refuses to bind document content to a checklist', async () => {
      await defineTemplate();
      const inst = await instantiate();
      await expect(
        staff.invoke('protocol/bind-document', {
          instanceId: inst.id,
          contentRef: AVTAL,
          contentHash: HASH_A,
        }),
      ).rejects.toThrow(/fill its items instead/);
    });

    it('refuses to sign a document whose content was never bound', async () => {
      // The alternative would be attesting to an empty template — the exact
      // false audit trail a degenerate one-item checklist produces.
      await defineAvtal();
      const inst = await instantiateAvtal();
      await expect(staff.invoke('protocol/sign', { instanceId: inst.id })).rejects.toThrow(
        /no bound content/,
      );
    });

    it('the signature attests to the BOUND hash — rebinding changes what is signed', async () => {
      await defineAvtal();
      const a = await instantiateAvtal('01JWORKORDER00000000000000A');
      await staff.invoke('protocol/bind-document', {
        instanceId: a.id,
        contentRef: AVTAL,
        contentHash: HASH_A,
      });
      const signedA = await staff.invoke<SignResult>('protocol/sign', { instanceId: a.id });

      const b = await instantiateAvtal('01JWORKORDER00000000000000B');
      await staff.invoke('protocol/bind-document', {
        instanceId: b.id,
        contentRef: AVTAL,
        contentHash: HASH_A,
      });
      // Renegotiated before it went out: the price moved, so the hash must too.
      await staff.invoke('protocol/bind-document', {
        instanceId: b.id,
        contentRef: AVTAL,
        contentHash: HASH_B,
      });
      const signedB = await staff.invoke<SignResult>('protocol/sign', { instanceId: b.id });

      expect(signedA.signature.content_hash).not.toBe(signedB.signature.content_hash);
      expect(signedA.instance.bound_hash).toBe(HASH_A);
      expect(signedB.instance.bound_hash).toBe(HASH_B);
    });

    /**
     * The RENDERED document (#711) — which bytes a signatory is shown, as opposed
     * to `boundHash`, which is what the signature attests to. Two different facts,
     * and before this the engine could only carry the second, so a signing
     * connector had nothing to send but a sheet of identifiers.
     *
     * Tested against real attachments through the real kernel path — the harness's
     * own principal is minted here because the upload has to be a genuine
     * `_substrat_attachments` row with a kernel-computed sha256. A hand-forged row
     * would prove only that the SELECT below matches what the test wrote.
     */
    describe('the rendered document (#711)', () => {
      const AVTAL_BYTES = new TextEncoder().encode('%PDF-1.4 §1 Lön: 42 000 kr/mån');

      /** A principal holding the doc permissions, plus the scope's attachment surface. */
      const uploader = async () => {
        const staffActor = platformActorId.parse(ulid());
        const who = principalId.parse(ulid());
        const roleKey = `att-${ulid().toLowerCase()}`;
        await h.host.admin.defineRole(staffActor, h.tenant, {
          key: roleKey,
          permissions: [PERM.read, PERM.attach, PERM.create, PERM.bind, PERM.requestSignature],
          source: 'vertical',
        });
        await h.host.admin.assignRole(staffActor, {
          principalId: who,
          roleKey,
          node: { tenantId: h.tenant, scopeId: h.scope },
        });
        return {
          stub: await h.host.getScope(who, h.tenant, h.scope),
          attachments: await h.host.attachments(who, h.tenant, h.scope),
        };
      };

      it('binds the attachment, and carries it onto the freeze event', async () => {
        const { stub, attachments } = await uploader();
        await stub.invoke('protocol/define-template', {
          key: 'avtal-doc',
          title: 'Avtal',
          content: { kind: 'document', documentType: 'avtal', hashRecipe: 'sha256 over terms' },
        });
        const inst = await stub.invoke<ProtocolInstanceRow>('protocol/instantiate', {
          templateKey: 'avtal-doc',
          entityType: BIKE.entityType,
          entityId: '01JWORKORDER0000000000000D1',
        });
        const record = await attachments.upload({
          entity: { entityType: 'protocol', entityId: inst.id },
          filename: 'avtal.pdf',
          contentType: 'application/pdf',
          visibility: 'customer',
          body: AVTAL_BYTES,
        });

        const bound = await stub.invoke<ProtocolInstanceRow>('protocol/bind-document', {
          instanceId: inst.id,
          contentRef: AVTAL,
          contentHash: HASH_A,
          documentAttachmentId: record.id,
        });
        expect(bound.document_attachment_id).toBe(record.id);

        // The binding event says which bytes, and witnesses them: the sha256 comes
        // from the attachment row, so a consumer learns what was bound without a
        // second read and cannot be told a hash the kernel did not compute.
        const [contentBound] = h.eventsOfType('protocol.content-bound');
        expect((contentBound!.payload as { documentAttachmentId: string }).documentAttachmentId).toBe(
          record.id,
        );
        expect((contentBound!.payload as { documentSha256: string }).documentSha256).toBe(
          record.sha256,
        );

        // And the freeze carries it to whoever dispatches the signature request —
        // fat, so a connector never needs a cross-module read to know what to send.
        await stub.invoke('protocol/request-signatures', {
          instanceId: inst.id,
          method: 'scrive',
          parties: [
            { label: 'Egeryds', kind: 'principal', signatureKind: 'primary' },
            { label: 'Beställare', kind: 'external', contact: { email: 'kund@example.se' } },
          ],
        });
        const [requested] = h.eventsOfType('protocol.signatures-requested');
        expect(
          (requested!.payload as { documentAttachmentId: string | null }).documentAttachmentId,
        ).toBe(record.id);
      });

      it('stays null when no document is named — the field is optional, not implied', async () => {
        // The acceptance criterion that protects every caller who renders nothing.
        // A protocol with no rendered document is not a lesser one; it is what every
        // instance bound before this field existed looks like.
        await defineAvtal();
        const inst = await instantiateAvtal('01JWORKORDER0000000000000D2');
        const bound = await staff.invoke<ProtocolInstanceRow>('protocol/bind-document', {
          instanceId: inst.id,
          contentRef: AVTAL,
          contentHash: HASH_A,
        });
        expect(bound.document_attachment_id).toBeNull();
        const [contentBound] = h.eventsOfType('protocol.content-bound');
        expect(
          (contentBound!.payload as { documentAttachmentId: string | null }).documentAttachmentId,
        ).toBeNull();
        expect((contentBound!.payload as { documentSha256: string | null }).documentSha256).toBeNull();
      });

      it('refuses an attachment that belongs to another instance, or to nothing', async () => {
        // The engine's own check, made at the only point where the document and the
        // hash are named together. It refuses the accidents — a stale id, another
        // instance's paperwork — without pretending to verify a hash recipe it has
        // never been able to run.
        const { stub, attachments } = await uploader();
        await stub.invoke('protocol/define-template', {
          key: 'avtal-doc-2',
          title: 'Avtal',
          content: { kind: 'document', documentType: 'avtal', hashRecipe: 'sha256 over terms' },
        });
        const mine = await stub.invoke<ProtocolInstanceRow>('protocol/instantiate', {
          templateKey: 'avtal-doc-2',
          entityType: BIKE.entityType,
          entityId: '01JWORKORDER0000000000000D3',
        });
        const theirs = await stub.invoke<ProtocolInstanceRow>('protocol/instantiate', {
          templateKey: 'avtal-doc-2',
          entityType: BIKE.entityType,
          entityId: '01JWORKORDER0000000000000D4',
        });
        const elsewhere = await attachments.upload({
          entity: { entityType: 'protocol', entityId: theirs.id },
          filename: 'someone-elses.pdf',
          contentType: 'application/pdf',
          visibility: 'customer',
          body: AVTAL_BYTES,
        });

        await expect(
          stub.invoke('protocol/bind-document', {
            instanceId: mine.id,
            contentRef: AVTAL,
            contentHash: HASH_A,
            documentAttachmentId: elsewhere.id,
          }),
        ).rejects.toThrow(/not to protocol\//);

        await expect(
          stub.invoke('protocol/bind-document', {
            instanceId: mine.id,
            contentRef: AVTAL,
            contentHash: HASH_A,
            documentAttachmentId: ulid(),
          }),
        ).rejects.toThrow(/no attachment/);

        // A refused binding leaves the instance alone. The check runs before the
        // UPDATE and the whole operation rolls back, so there is no half-write —
        // a bound hash with the document rejected would be the worst of both.
        const after = await stub.invoke<{ instance: ProtocolInstanceRow }>('protocol/get', {
          instanceId: mine.id,
        });
        expect(after.instance.document_attachment_id).toBeNull();
        expect(after.instance.bound_hash).toBeNull();
      });
    });

    it('a signed document is frozen: the binding cannot move under the signature', async () => {
      await defineAvtal();
      const inst = await instantiateAvtal();
      await staff.invoke('protocol/bind-document', {
        instanceId: inst.id,
        contentRef: AVTAL,
        contentHash: HASH_A,
      });
      await staff.invoke('protocol/sign', { instanceId: inst.id });
      await expect(
        staff.invoke('protocol/bind-document', {
          instanceId: inst.id,
          contentRef: AVTAL,
          contentHash: HASH_B,
        }),
      ).rejects.toThrow(/frozen/);
    });
  });

  // -- asynchronous, non-principal signing -----------------------------------

  describe('external signing (requestSignatures / recordSignature)', () => {
    const later = '2026-03-01T10:00:00.000Z';

    const requestOne = async (instanceId: string, label = 'Beställare') =>
      staff.invoke<{ contentHash: string; requests: ProtocolSignatureRequestRow[] }>(
        'protocol/request-signatures',
        {
          instanceId,
          method: 'scrive',
          // #687: an issuer who is never invited (the author at the provider) plus the
          // party who actually receives the document. One party alone is refused —
          // it would BECOME the author and the document would reach nobody.
          parties: [
            { label, kind: 'external', contact: { email: 'part@example.se' } },
            { label: 'Utställare', kind: 'principal', signatureKind: 'primary' },
          ],
        },
      );

    // #620: how hard the provider must prove WHO signed, chosen by the caller.
    // Provider-agnostic on purpose — `se_bankid` is Scrive's word for `strong` and
    // belongs in the connector, so a vertical is never picking a Scrive enum through
    // an engine that speaks to several providers.
    it('carries the requested auth level onto the row and the event, defaulting to basic', async () => {
      await defineTemplate();
      const inst = await instantiate();
      const { requests } = await staff.invoke<{ requests: ProtocolSignatureRequestRow[] }>(
        'protocol/request-signatures',
        {
          instanceId: inst.id,
          method: 'scrive',
          parties: [
            // The FIRST party is the issuer by fall-through, so it needs no contact.
            { label: 'Beställare', kind: 'external', authLevel: 'strong' },
            {
              label: 'Leverantör',
              kind: 'principal', // says nothing about authLevel
              contact: { email: 'leverantor@example.se' },
            },
          ],
        },
      );
      // Stored as asked; an unspecified party stores NULL rather than a guess, so
      // the default lives in one place and rows written before 0003 read the same.
      expect(requests.map((r) => r.auth_level)).toEqual(['strong', null]);

      // The event resolves it, so no consumer re-derives the default.
      const [requested] = h.eventsOfType('protocol.signatures-requested');
      const parties = (requested!.payload as { parties: { label: string; authLevel: string }[] })
        .parties;
      expect(parties.map((p) => [p.label, p.authLevel])).toEqual([
        ['Beställare', 'strong'],
        ['Leverantör', 'basic'],
      ]);
    });

    it('freezes the content for the whole time it is out for signature', async () => {
      // THE bug this whole shape exists for: signing used to freeze, so an
      // instance sitting at Scrive for days stayed `open` and writable, and the
      // document the customer saw could drift from the one that was hashed.
      await defineTemplate();
      const inst = await instantiate();
      await staff.invoke('protocol/fill', {
        instanceId: inst.id,
        itemKey: 'front-brake',
        value: true,
      });
      const { contentHash } = await requestOne(inst.id);

      const detail = await staff.invoke<{ instance: ProtocolInstanceRow }>('protocol/get', {
        instanceId: inst.id,
      });
      expect(detail.instance.status).toBe('pending_signature');
      expect(detail.instance.frozen_hash).toBe(contentHash);

      await expect(
        staff.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'pad-mm', value: '3.5' }),
      ).rejects.toThrow(/out for signature/);
    });

    it('records a signatory with no account, at the provider\'s time, with evidence', async () => {
      await defineTemplate();
      const inst = await instantiate();
      const { contentHash, requests } = await requestOne(inst.id);
      const customer = ulid();

      // The issuer signs first, so the CUSTOMER's signature is the one that
      // completes the instance — which is what puts them on the `protocol.signed`
      // event as its data subject, asserted at the end.
      await staff.invoke<SignResult>('protocol/record-signature', {
        requestId: requests[1]!.id,
        signatory: { kind: 'principal', ref: principalId.parse(ulid()) },
        signedAt: later,
        contentHash,
      });

      const result = await staff.invoke<SignResult>('protocol/record-signature', {
        requestId: requests[0]!.id,
        signatory: { kind: 'external', ref: customer, label: 'Anna Beställare' },
        signedAt: later,
        contentHash,
        evidenceRef: 'scrive:tx-9912/sealed.pdf',
      });

      expect(result.instance.status).toBe('signed');
      expect(result.signature.signatory_kind).toBe('external');
      expect(result.signature.signed_by).toBe(customer); // not ctx.principal
      expect(result.signature.signed_at).toBe(later); // not "now"
      expect(result.signature.method).toBe('scrive'); // not 'in-app'
      expect(result.signature.evidence_ref).toBe('scrive:tx-9912/sealed.pdf');
      expect(result.signature.request_id).toBe(requests[0]!.id);

      // The spine event names the external person as the data subject, so
      // crypto-shredding can key the erasure on someone with no principal.
      //
      // `countersigned`, not `signed`: the issuing party's signature is the one
      // that emits `protocol.signed`, and the issuer is the side that SENDS the
      // document. An external counterparty is by construction a counter-signer
      // (#687 — a set with no counterparty is refused), so this is the event that
      // names them.
      const [countersigned] = h.eventsOfType('protocol.countersigned');
      expect(countersigned!.subjectId).toBe(customer);
    });

    // -- #687: how a party is REACHED -------------------------------------
    //
    // The gap these cover is the whole of why every external signature this
    // platform ever sent failed: a request carried a role label and no address,
    // so the document started at the provider and had nobody to deliver to.

    it('seals each party contact to the connector, and puts NO readable address in the spine', async () => {
      await defineTemplate();
      const inst = await instantiate();
      const { requests } = await staff.invoke<{ requests: ProtocolSignatureRequestRow[] }>(
        'protocol/request-signatures',
        {
          instanceId: inst.id,
          method: 'scrive',
          parties: [
            { label: 'Beställare', kind: 'external', contact: { email: 'anna@kund.se' } },
            { label: 'Utställare', kind: 'principal', signatureKind: 'primary' },
          ],
        },
      );

      // The row holds an envelope naming its key — never the address.
      const [invited, issuer] = requests;
      expect(invited!.contact_key_id).toMatch(/^connection:/);
      expect(invited!.contact_ciphertext).toBeTruthy();
      expect(JSON.stringify(invited)).not.toContain('anna@kund.se');
      // The issuer is the author at the provider and is never invited, so it
      // carries nothing to seal.
      expect(issuer!.contact_key_id).toBeNull();

      // And neither does the event — which is the point, because the event is
      // the copy the platform keeps in `_substrat_outbox` and cannot erase.
      const [requested] = h.eventsOfType('protocol.signatures-requested');
      expect(JSON.stringify(requested!.payload)).not.toContain('anna@kund.se');
      const parties = (
        requested!.payload as {
          parties: { label: string; contact: { keyId: string; ciphertext: string } | null }[];
        }
      ).parties;
      expect(parties[0]!.contact!.keyId).toBe(invited!.contact_key_id);
      expect(parties[1]!.contact).toBeNull();
      // Still 'none': the address is unreadable to the spine, and its erasure is
      // the destruction of a key the scope does not hold, not a redaction here.
      expect(requested!.piiClass).toBe('none');
    });

    it('refuses a party that will be invited but carries no address', async () => {
      await defineTemplate();
      const inst = await instantiate();
      await expect(
        staff.invoke('protocol/request-signatures', {
          instanceId: inst.id,
          method: 'scrive',
          parties: [
            { label: 'Utställare', kind: 'principal', signatureKind: 'primary' },
            { label: 'Beställare', kind: 'external' },
          ],
        }),
      ).rejects.toThrow(/carries no contact/);

      // And it refused BEFORE freezing: an instance stuck in `pending_signature`
      // for a document that was never sent is worse than the refusal.
      const detail = await staff.invoke<{ instance: ProtocolInstanceRow }>('protocol/get', {
        instanceId: inst.id,
      });
      expect(detail.instance.status).toBe('open');
    });

    it('refuses a set with no counterparty — the party would become the author', async () => {
      // The production failure, pinned. "The declared primary, else the FIRST" is
      // total, so a one-party request never failed here — it failed at the
      // provider, where that party was the sender and was never invited to sign.
      await defineTemplate();
      const inst = await instantiate();
      await expect(
        staff.invoke('protocol/request-signatures', {
          instanceId: inst.id,
          method: 'scrive',
          parties: [{ label: 'Kund', kind: 'external', contact: { email: 'kund@example.se' } }],
        }),
      ).rejects.toThrow(/needs a counterparty/);
    });

    it('refuses, legibly, when no key for the method has reached this scope', async () => {
      // The deploy-order hazard (§7 point 2): control plane and key projection
      // first, vertical second. Between the two, a request must fail LOUDLY —
      // emitting one with its addresses silently dropped is the invisible failure
      // this whole carrier exists to end, wearing a new hat.
      await defineTemplate();
      const inst = await instantiate();
      await expect(
        staff.invoke('protocol/request-signatures', {
          instanceId: inst.id,
          method: 'assently', // a provider this tenant has never connected
          parties: [
            { label: 'Utställare', kind: 'principal', signatureKind: 'primary' },
            { label: 'Kund', kind: 'external', contact: { email: 'kund@example.se' } },
          ],
        }),
      ).rejects.toThrow(/no 'assently' sealing key is available/);

      const detail = await staff.invoke<{ instance: ProtocolInstanceRow }>('protocol/get', {
        instanceId: inst.id,
      });
      expect(detail.instance.status).toBe('open');
    });

    it('fails closed when the provider signed a different document than we froze', async () => {
      await defineTemplate();
      const inst = await instantiate();
      const { requests } = await requestOne(inst.id);
      await expect(
        staff.invoke('protocol/record-signature', {
          requestId: requests[0]!.id,
          signatory: { kind: 'external', ref: ulid() },
          signedAt: later,
          contentHash: 'f'.repeat(64),
        }),
      ).rejects.toThrow(/does not match the frozen protocol/);
    });

    it('is signed only when EVERY requested party has signed', async () => {
      await defineTemplate();
      const inst = await instantiate();
      const { contentHash, requests } = await staff.invoke<{
        contentHash: string;
        requests: ProtocolSignatureRequestRow[];
      }>('protocol/request-signatures', {
        instanceId: inst.id,
        method: 'scrive',
        parties: [
          { label: 'Leverantör', kind: 'external', signatureKind: 'primary' },
          { label: 'Beställare', kind: 'external', contact: { email: 'kund@example.se' } },
        ],
      });
      expect(requests).toHaveLength(2);

      const first = await staff.invoke<SignResult>('protocol/record-signature', {
        requestId: requests[0]!.id,
        signatory: { kind: 'external', ref: ulid() },
        signedAt: later,
        contentHash,
      });
      expect(first.instance.status).toBe('pending_signature'); // one down, one to go

      const second = await staff.invoke<SignResult>('protocol/record-signature', {
        requestId: requests[1]!.id,
        signatory: { kind: 'external', ref: ulid() },
        signedAt: later,
        contentHash,
      });
      expect(second.instance.status).toBe('signed');
      await expect(
        h.run((ctx) => requireSigned(ctx, BIKE, 'self-inspection')),
      ).resolves.toBeUndefined();
    });

    it('a declined party does NOT complete the protocol', async () => {
      // The trap: after a decline nothing is `pending` any more. Counting
      // pending rows would mark an avtal fully executed that a party refused.
      await defineTemplate();
      const inst = await instantiate();
      const { contentHash, requests } = await staff.invoke<{
        contentHash: string;
        requests: ProtocolSignatureRequestRow[];
      }>('protocol/request-signatures', {
        instanceId: inst.id,
        method: 'scrive',
        parties: [
          { label: 'Leverantör', kind: 'external', signatureKind: 'primary' },
          { label: 'Beställare', kind: 'external', contact: { email: 'kund@example.se' } },
        ],
      });

      await staff.invoke('protocol/decline-signature', {
        requestId: requests[1]!.id,
        reason: 'priset för högt',
      });
      const after = await staff.invoke<SignResult>('protocol/record-signature', {
        requestId: requests[0]!.id,
        signatory: { kind: 'external', ref: ulid() },
        signedAt: later,
        contentHash,
      });

      expect(after.instance.status).toBe('pending_signature'); // NOT signed
      await expect(h.run((ctx) => requireSigned(ctx, BIKE, 'self-inspection'))).rejects.toThrow();
    });

    it('cancelling thaws the protocol so it can be renegotiated', async () => {
      await defineTemplate();
      const inst = await instantiate();
      await requestOne(inst.id);

      const thawed = await staff.invoke<ProtocolInstanceRow>('protocol/cancel-signatures', {
        instanceId: inst.id,
        reason: 'omförhandlas',
      });
      expect(thawed.status).toBe('open');
      expect(thawed.frozen_hash).toBeNull();

      // Writable again, and a fresh request freezes at a NEW hash — so a party
      // who signed the withdrawn version has not signed this one.
      await staff.invoke('protocol/fill', {
        instanceId: inst.id,
        itemKey: 'front-brake',
        value: false,
      });
      const again = await requestOne(inst.id);
      const detail = await staff.invoke<{ requests: ProtocolSignatureRequestRow[] }>(
        'protocol/get',
        { instanceId: inst.id },
      );
      // Both parties' requests are cancelled — the issuer's too (#687).
      expect(detail.requests.filter((r) => r.status === 'cancelled')).toHaveLength(2);
      expect(again.contentHash).not.toBe(detail.requests[0]!.content_hash);
    });

    it('holds the (template, entity) slot while out for signature', async () => {
      await defineTemplate();
      const inst = await instantiate();
      await requestOne(inst.id);
      await expect(instantiate()).rejects.toThrow(/already open/);
    });

    it('refuses more than one issuing party', async () => {
      await defineTemplate();
      const inst = await instantiate();
      await expect(
        staff.invoke('protocol/request-signatures', {
          instanceId: inst.id,
          method: 'scrive',
          parties: [
            { label: 'A', kind: 'external', signatureKind: 'primary' },
            { label: 'B', kind: 'external', signatureKind: 'primary', contact: { email: 'b@example.se' } },
          ],
        }),
      ).rejects.toThrow(/at most one party may sign as primary/);
    });

    it('will not record the same request twice', async () => {
      await defineTemplate();
      const inst = await instantiate();
      const { contentHash, requests } = await requestOne(inst.id);
      const sign = () =>
        staff.invoke('protocol/record-signature', {
          requestId: requests[0]!.id,
          signatory: { kind: 'external', ref: ulid() },
          signedAt: later,
          contentHash,
        });
      await sign();
      await expect(sign()).rejects.toThrow(/already signed/);
    });

    it('refuses a signatory the request was not addressed to', async () => {
      await defineTemplate();
      const inst = await instantiate();
      const addressee = ulid();
      const { contentHash, requests } = await staff.invoke<{
        contentHash: string;
        requests: ProtocolSignatureRequestRow[];
      }>('protocol/request-signatures', {
        instanceId: inst.id,
        method: 'scrive',
        parties: [
          {
            label: 'Beställare',
            kind: 'external',
            ref: addressee,
            contact: { email: 'kund@example.se' },
          },
          { label: 'Utställare', kind: 'principal', signatureKind: 'primary' },
        ],
      });
      await expect(
        staff.invoke('protocol/record-signature', {
          requestId: requests[0]!.id,
          signatory: { kind: 'external', ref: ulid() }, // someone else entirely
          signedAt: later,
          contentHash,
        }),
      ).rejects.toThrow(/addressed to a different party/);
    });
  });
});
