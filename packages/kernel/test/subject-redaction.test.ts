import { describe, expect, it } from 'vitest';
import {
  connectorDispatchPayload,
  domainEvent,
  eventId,
  instant,
  scopeId,
  tenantId,
  type ConnectorDispatchPayload,
} from '@substrat-run/contracts';
import {
  intentPayloadCarriesSubject,
  platformRequestRedactionQuery,
  redactedIntentPayload,
  REDACTED_INTENT_MARKER,
  ulid,
} from '../src/index.js';

/**
 * The decision behind the intent journal's half of a subject erasure (#1600).
 *
 * The adapters are held to the BEHAVIOUR by the shared contract suite; this holds the
 * predicate to the CONTRACT TYPE. Everything below is built through
 * `connectorDispatchPayload` / `domainEvent` rather than from a hand-copied literal, so a
 * field rename on the envelope breaks this file instead of quietly making the predicate
 * blind to the one payload shape it exists for.
 */
describe('subject redaction — which intents an erasure selects', () => {
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());

  const dispatchFor = (subject: string, said: string, piiClass = 'direct'): string => {
    const payload = {
      executorId: 'signer',
      event: domainEvent.parse({
        id: eventId.parse(ulid()),
        type: 'protocol.signatures-requested',
        schemaVersion: 1,
        occurredAt: instant.parse(new Date().toISOString()),
        tenantId: t,
        scopeId: s,
        actor: { system: '@substrat-run/engine-protocol' },
        entity: { entityType: 'protocol', entityId: ulid() },
        piiClass,
        subjectId: subject,
        payload: { senderParty: { label: said }, parties: [{ label: said }] },
      }),
    } satisfies ConnectorDispatchPayload;
    return JSON.stringify(connectorDispatchPayload.parse(payload));
  };

  it('selects the routed copy of an event the outbox redaction would redact', () => {
    const subject = ulid();
    expect(intentPayloadCarriesSubject(dispatchFor(subject, 'Anna Ek'), subject)).toBe(true);
  });

  it('spares another subject — the same shape, a different person', () => {
    expect(intentPayloadCarriesSubject(dispatchFor(ulid(), 'Bo Lund'), ulid())).toBe(false);
  });

  it("spares a `piiClass: 'none'` event, exactly as the outbox does", () => {
    // `subject_id = ? AND pii_class != 'none'` is the outbox's whole predicate. A COPY of
    // an event judged more harshly than its original is incoherent, not stricter.
    const subject = ulid();
    expect(intentPayloadCarriesSubject(dispatchFor(subject, 'Anna Ek', 'none'), subject)).toBe(
      false,
    );
  });

  it('finds an envelope at any depth, so the rule is about events and not about kinds', () => {
    const subject = ulid();
    const nested = JSON.stringify({
      batch: [{ wrapper: { inner: JSON.parse(dispatchFor(subject, 'Anna Ek')) } }],
    });
    expect(intentPayloadCarriesSubject(nested, subject)).toBe(true);
  });

  it('declines a payload that merely mentions the id with no classified event', () => {
    // `archive-scope`-shaped: an id is a reference, not a declaration that this payload
    // holds the person's data — and there is no `piiClass` here to say otherwise.
    const subject = ulid();
    expect(intentPayloadCarriesSubject(JSON.stringify({ scopeId: subject }), subject)).toBe(false);
  });

  it('declines its own tombstone, so a re-run after a crash converges', () => {
    const subject = ulid();
    const tombstone = redactedIntentPayload(subject, new Date().toISOString());
    expect(JSON.parse(tombstone)).toHaveProperty(REDACTED_INTENT_MARKER);
    expect(intentPayloadCarriesSubject(tombstone, subject)).toBe(false);
  });

  it('the tombstone is refused by the handler that would have drained the intent', () => {
    // The backstop under "never silently drain a redacted intent": even a drain that read
    // the row before the redaction and parses it after must fail loudly, not deliver a
    // shape it can read halfway.
    const parsed = connectorDispatchPayload.safeParse(
      JSON.parse(redactedIntentPayload(ulid(), new Date().toISOString())),
    );
    expect(parsed.success).toBe(false);
  });

  it('declines a payload that is not JSON rather than guessing at it', () => {
    expect(intentPayloadCarriesSubject('not json at all', ulid())).toBe(false);
  });

  it('narrows the candidate read to the id as the payload actually spells it', () => {
    const subject = ulid();
    const q = platformRequestRedactionQuery(subject);
    expect(q.sql).toContain('instr(payload, ?)');
    // A ULID needs no JSON escaping, so the needle IS the id — and the escaped form is
    // what is bound, so a subject id that did need escaping would still be found.
    expect(q.params).toEqual([subject]);
    expect(dispatchFor(subject, 'Anna Ek')).toContain(q.params[0]!);
  });
});
