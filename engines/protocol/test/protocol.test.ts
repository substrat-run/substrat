import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EntityRef } from '@substrat-run/contracts';
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
        { instanceId, method: 'scrive', parties: [{ label, kind: 'external' }] },
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
            { label: 'Beställare', kind: 'external', authLevel: 'strong' },
            { label: 'Leverantör', kind: 'principal' }, // says nothing
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
      const [evt] = h.eventsOfType('protocol.signed');
      expect(evt!.subjectId).toBe(customer);
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
          { label: 'Beställare', kind: 'external' },
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
          { label: 'Beställare', kind: 'external' },
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
      expect(detail.requests.filter((r) => r.status === 'cancelled')).toHaveLength(1);
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
            { label: 'B', kind: 'external', signatureKind: 'primary' },
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
        parties: [{ label: 'Beställare', kind: 'external', ref: addressee }],
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
