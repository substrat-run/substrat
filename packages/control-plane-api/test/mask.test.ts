import { describe, expect, it } from 'vitest';
import type { ScopeDumpTable } from '@substrat-run/contracts';
import { maskDump, maskRecords } from '../src/mask.js';
import { createPseudonymizer, kindOf, MASKED } from '../src/pseudonymize.js';

/**
 * The masked export's value generator (#1034).
 *
 * The three properties being pinned are the ones that make a masked pull worth
 * pulling: the same real value reads the same everywhere in one export, two exports
 * with different salts disagree, and nothing in the output is anything that went in.
 */

const PII = [
  'anna@example.com',
  'Anna Ek',
  '+46 70-123 45 67',
  'Storgatan 14',
  'Goteborg',
  '114 51',
];

function dumpOf(rows: unknown[][]): ScopeDumpTable[] {
  return [
    {
      name: 'customers',
      ddl: 'CREATE TABLE customers (id TEXT, email TEXT, name TEXT, phone TEXT, street TEXT, city TEXT, postal_code TEXT, visits INTEGER, note TEXT, payload TEXT)',
      columns: ['id', 'email', 'name', 'phone', 'street', 'city', 'postal_code', 'visits', 'note', 'payload'],
      rows,
    } as ScopeDumpTable,
  ];
}

const ROW = [
  'c1',
  'anna@example.com',
  'Anna Ek',
  '+46 70-123 45 67',
  'Storgatan 14',
  'Goteborg',
  '114 51',
  7,
  'called twice about the leaking pipe',
  JSON.stringify({ customerEmail: 'anna@example.com', customerName: 'Anna Ek', total: '120.00' }),
];

const masked = async (salt: string, rows: unknown[][] = [ROW]): Promise<unknown[]> => {
  const out = await maskDump(dumpOf(rows), await createPseudonymizer(salt));
  return out[0]!.rows[0]!;
};

describe('kindOf', () => {
  it('reads the column name, snake or camel', () => {
    expect(kindOf('email')).toBe('email');
    expect(kindOf('customerEmail')).toBe('email');
    expect(kindOf('customer_email')).toBe('email');
    expect(kindOf('phone')).toBe('phone');
    expect(kindOf('postal_code')).toBe('postal');
    expect(kindOf('first_name')).toBe('given');
    expect(kindOf('last_name')).toBe('family');
    expect(kindOf('external_id')).toBe('external_id');
  });

  it('claims nothing it should not', () => {
    for (const col of ['id', 'scope_id', 'created_at', 'total', 'status', 'visits']) {
      expect(kindOf(col)).toBeUndefined();
    }
  });

  /**
   * Free text and national identifiers keep `[masked]` — a hash cannot invent a
   * sentence, and a generated checksum-valid personnummer may belong to a real person.
   */
  it('sends free text and national identifiers to redaction, not to a fake', () => {
    for (const col of ['note', 'description', 'body', 'comment', 'message', 'subject', 'personnummer', 'ssn']) {
      expect(kindOf(col)).toBe('redact');
    }
  });

  /**
   * #1369: an engine documents a party label as "a display name for the role, never
   * PII", a human types their actual name into it, and nothing enforces the documented
   * intent — so the masker reads the box, not the docstring.
   */
  it('reads a person-ish role label, on the engine tables and in a payload', () => {
    for (const col of [
      'party_label',
      'signatory_label',
      'countersignatory_label',
      'partyLabel',
      'sender_party_label',
      'recipient_label',
      'signer_label',
      'counterparty_label',
    ]) {
      expect(kindOf(col)).toBe('label');
    }
  });

  /**
   * The narrowness is the point: a bare `label` is overwhelmingly a UI string, and the
   * `_kind` siblings are enum values a consumer branches on. Masking either turns a
   * usable copy into a broken one, which is the failure mode `[masked]` already had.
   */
  it('claims no label that is not a person', () => {
    for (const col of ['label', 'labels', 'status_label', 'size_label', 'meter_label', 'rule_label']) {
      expect(kindOf(col)).toBeUndefined();
    }
    for (const col of ['party_kind', 'signatory_kind', 'party_ref', 'signature_kind']) {
      expect(kindOf(col)).toBeUndefined();
    }
  });
});

describe('a masked dump', () => {
  it('leaves ids, numbers and non-PII columns exactly as they were', async () => {
    const row = await masked('salt-a');
    expect(row[0]).toBe('c1');
    expect(row[7]).toBe(7);
  });

  it('writes a plausible value of the right kind', async () => {
    const [, email, name, phone, street, city, postal] = await masked('salt-a') as string[];
    // `.email()`-parseable, at a reserved domain — a pseudonymized address reaches nobody.
    expect(email).toMatch(/^[a-z0-9.]+@example\.(com|org|net|edu)$/);
    expect(name).toMatch(/^[A-Z]\S+ [A-Z]\S+$/);
    // The phone keeps its SHAPE and its country code: a length or prefix check on the
    // way back in still passes.
    expect(phone).toMatch(/^\+46 \d\d-\d\d\d \d\d \d\d$/);
    expect(street).toMatch(/^\S+ \d+$/);
    expect(city).not.toBe('');
    expect(postal).toMatch(/^\d\d\d \d\d$/);
  });

  it('keeps free text redacted rather than inventing a sentence', async () => {
    expect((await masked('salt-a'))[8]).toBe(MASKED);
  });

  it('contains nothing that went in', async () => {
    const row = await masked('salt-a');
    const emitted = JSON.stringify(row);
    for (const value of PII) expect(emitted).not.toContain(value);
  });

  /**
   * The headline property. Without it, a customer's name in their own row and in the
   * event payload that quoted them disagree, joins stop lining up, and the copy stops
   * reading as a tenant — which is the whole reason to pseudonymize rather than blank.
   */
  it('is deterministic within one export, across columns and into JSON payloads', async () => {
    const row = await masked('salt-a');
    const payload = JSON.parse(row[9] as string) as Record<string, string>;
    expect(payload.customerEmail).toBe(row[1]);
    expect(payload.customerName).toBe(row[2]);
    expect(payload.total).toBe('120.00');
  });

  it('is deterministic across rows: two rows naming the same person agree', async () => {
    const second = [...ROW];
    second[0] = 'c2';
    const out = await maskDump(dumpOf([ROW, second]), await createPseudonymizer('salt-a'));
    expect(out[0]!.rows[0]![1]).toBe(out[0]!.rows[1]![1]);
    expect(out[0]!.rows[0]![2]).toBe(out[0]!.rows[1]![2]);
  });

  it('is stable when the same salt is used twice', async () => {
    expect(await masked('salt-a')).toEqual(await masked('salt-a'));
  });

  it('diverges under a different salt — two exports cannot be correlated', async () => {
    const a = await masked('salt-a');
    const b = await masked('salt-b');
    expect(a[1]).not.toBe(b[1]);
    expect(a[3]).not.toBe(b[3]);
    // ...while the untouched columns still agree, so the divergence is the sweep's and
    // not the dump's.
    expect(a[0]).toBe(b[0]);
    expect(a[7]).toBe(b[7]);
  });

  /**
   * Two people who happen to share a name must not share an address, or a natural key
   * on `email` turns a masked round trip into a UNIQUE violation at `importScope`.
   *
   * The cardinality is the point. A generator built from a name pair and three digits
   * has ~4M outputs, which passes a 60-row check and collides with ~11% probability
   * across a thousand addresses — a size a real scope reaches easily. So this runs at a
   * scale where a too-small output space fails rather than gets lucky.
   */
  it('does not collapse distinct values onto one, at a real scope\'s cardinality', async () => {
    const rows = Array.from({ length: 5_000 }, (_, i) => {
      const row = [...ROW];
      row[0] = `c${i}`;
      row[1] = `person${i}@example.se`;
      return row;
    });
    const out = await maskDump(dumpOf(rows), await createPseudonymizer('salt-a'));
    const emails = out[0]!.rows.map((r) => r[1]);
    expect(new Set(emails).size).toBe(emails.length);
  });

  /**
   * `reshape` used to copy every non-digit through, so a Canadian `K1A 0B1` came back
   * still carrying its `K`, `A` and `B` — real characters of a real address, in the one
   * file that promises to hold none. Half the world's postal codes are alphanumeric.
   *
   * Asserted over a set rather than one value: every input here has `K` in position 0,
   * so if letters were being copied the outputs would all start `K` too.
   */
  it('replaces the letters of an alphanumeric postal code, keeping the layout', async () => {
    const codes = [...'ABCDEFGHIJKLMNOPQRSTUVWX'].map((c) => `K1${c} 0B1`);
    const rows = codes.map((code, i) => {
      const row = [...ROW];
      row[0] = `c${i}`;
      row[6] = code;
      return row;
    });
    const out = await maskDump(dumpOf(rows), await createPseudonymizer('salt-a'));
    const postals = out[0]!.rows.map((r) => r[6] as string);
    for (const postal of postals) expect(postal).toMatch(/^[A-Z]\d[A-Z] \d[A-Z]\d$/);
    expect(new Set(postals.map((p) => p[0])).size).toBeGreaterThan(1);
    for (const code of codes) expect(postals).not.toContain(code);
  });

  /**
   * `{ contact: { email } }`: `contact` reads as `person`, and inheriting that kind into
   * the child rendered a full name where a consumer parses an email. The child's own key
   * wins; the inherited kind is only the fallback for keys the heuristic cannot read.
   */
  it('lets a recognised nested key beat the kind it inherited', async () => {
    const row = [...ROW];
    row[9] = JSON.stringify({
      contact: { email: 'anna@example.com', phone: '+46 70-123 45 67', ref: 'Anna Ek' },
    });
    const out = (await masked('salt-a', [row]))[9] as string;
    const { contact } = JSON.parse(out) as { contact: Record<string, string> };
    expect(contact.email).toMatch(/^[a-z0-9.]+@example\.(com|org|net|edu)$/);
    expect(contact.phone).toMatch(/^\+46 \d\d-\d\d\d \d\d \d\d$/);
    // `ref` is not a kind of its own, so it still inherits `person` from `contact`.
    expect(contact.ref).toMatch(/^[A-Z]\S+ [A-Z]\S+$/);
  });

  it('leaves a JSON column that is not JSON alone', async () => {
    const row = [...ROW];
    row[9] = 'not json at all';
    expect((await masked('salt-a', [row]))[9]).toBe('not json at all');
  });

  it('never mutates the input', async () => {
    const tables = dumpOf([[...ROW]]);
    await maskDump(tables, await createPseudonymizer('salt-a'));
    expect(tables[0]!.rows[0]![1]).toBe('anna@example.com');
  });
});

/**
 * #1369: the sweep is table-agnostic and always was, but the column heuristic had no
 * pattern for the label an engine puts a human's name in — so a masked pull came back
 * with the vertical's own tables pseudonymized and `protocol_*` plus the `_substrat_*`
 * spine holding verbatim production text. These are shaped like the tables that report
 * measured, so a regression is a red build rather than a discovery on a laptop.
 */
describe('a masked dump of engine and spine tables', () => {
  const PARTY_PAYLOAD = JSON.stringify({
    instanceId: 'p1',
    templateKey: 'avtal',
    parties: [
      { requestId: 'r1', label: 'Anna Ek', kind: 'principal', ref: 'pr_01', signatureKind: 'primary' },
      { requestId: 'r2', label: 'bengt@example.se', kind: 'external', ref: null, signatureKind: 'counter' },
    ],
    signatory: { kind: 'principal', ref: 'pr_01', label: 'Anna Ek' },
  });

  const engineDump = (): ScopeDumpTable[] => [
    {
      name: 'protocol_signature_requests',
      ddl: 'CREATE TABLE protocol_signature_requests (id TEXT, party_label TEXT, party_kind TEXT, party_ref TEXT)',
      columns: ['id', 'party_label', 'party_kind', 'party_ref'],
      rows: [['r1', 'Anna Ek', 'principal', 'pr_01']],
    } as ScopeDumpTable,
    {
      name: 'protocol_signatures',
      ddl: 'CREATE TABLE protocol_signatures (id TEXT, signatory_label TEXT, signed_by TEXT)',
      columns: ['id', 'signatory_label', 'signed_by'],
      rows: [['s1', 'Anna Ek', 'pr_01']],
    } as ScopeDumpTable,
    {
      name: '_substrat_outbox',
      ddl: 'CREATE TABLE _substrat_outbox (id TEXT, type TEXT, payload TEXT)',
      columns: ['id', 'type', 'payload'],
      rows: [['e1', 'protocol.signatures-requested', PARTY_PAYLOAD]],
    } as ScopeDumpTable,
    {
      name: '_substrat_platform_requests',
      ddl: 'CREATE TABLE _substrat_platform_requests (id TEXT, kind TEXT, payload TEXT)',
      columns: ['id', 'kind', 'payload'],
      rows: [
        [
          'i1',
          'connector:scrive',
          // The intent the connector reads, which quotes the same labels one level in
          // and under a differently-spelled container.
          JSON.stringify({ senderParty: { label: 'Anna Ek' }, parties: [{ label: 'Anna Ek' }] }),
        ],
      ],
    } as ScopeDumpTable,
  ];

  const maskedEngineDump = async (salt = 'salt-a'): Promise<ScopeDumpTable[]> =>
    maskDump(engineDump(), await createPseudonymizer(salt));

  it('pseudonymizes an engine label column, and leaves its enum and ref siblings alone', async () => {
    const [requests, signatures] = await maskedEngineDump();
    const [, partyLabel, partyKind, partyRef] = requests!.rows[0]! as string[];
    expect(partyLabel).not.toBe('Anna Ek');
    expect(partyLabel).toMatch(/^[A-Z]\S+ [A-Z]\S+$/);
    // A masked copy is only worth pulling if it still joins: the ref and the enum the
    // consumer branches on are facts about the row, not about the person.
    expect(partyKind).toBe('principal');
    expect(partyRef).toBe('pr_01');
    expect(signatures!.rows[0]![1]).toBe(partyLabel);
  });

  it('pseudonymizes the same label where the spine payload quotes it', async () => {
    const [requests, , outbox] = await maskedEngineDump();
    const payload = JSON.parse(outbox!.rows[0]![2] as string) as {
      parties: { label: string; kind: string; ref: string | null; requestId: string }[];
      signatory: { label: string; kind: string; ref: string };
      instanceId: string;
    };
    const partyLabel = requests!.rows[0]![1] as string;
    // The headline property, now across the seam: the engine's row and the event that
    // quoted it agree, so a timeline still reads as one person.
    expect(payload.parties[0]!.label).toBe(partyLabel);
    expect(payload.signatory.label).toBe(partyLabel);
    // Only `label` is reclassified by its container; its siblings keep their own verdict.
    expect(payload.parties[0]!.kind).toBe('principal');
    expect(payload.parties[0]!.ref).toBe('pr_01');
    expect(payload.parties[0]!.requestId).toBe('r1');
    expect(payload.instanceId).toBe('p1');
  });

  /**
   * Whoever filled the box in reached for the address instead of the name, which is
   * exactly what the report observed. Rendering a full name there would hand a consumer
   * that parses the label as a contact something it cannot parse.
   */
  it('renders a label that holds an address back as an address', async () => {
    const [, , outbox] = await maskedEngineDump();
    const { parties } = JSON.parse(outbox!.rows[0]![2] as string) as { parties: { label: string }[] };
    expect(parties[1]!.label).toMatch(/^[a-z0-9.]+@example\.(com|org|net|edu)$/);
  });

  it('reaches a platform-intent payload the same way, container spelling and all', async () => {
    const [requests, , , intents] = await maskedEngineDump();
    const intent = JSON.parse(intents!.rows[0]![2] as string) as {
      senderParty: { label: string };
      parties: { label: string }[];
    };
    const partyLabel = requests!.rows[0]![1] as string;
    expect(intent.senderParty.label).toBe(partyLabel);
    expect(intent.parties[0]!.label).toBe(partyLabel);
    expect(intents!.rows[0]![1]).toBe('connector:scrive');
  });

  it('contains none of the real text it was given', async () => {
    const emitted = JSON.stringify(await maskedEngineDump());
    for (const value of ['Anna Ek', 'bengt@example.se']) expect(emitted).not.toContain(value);
  });

  it('is stable across two passes with the same salt, and diverges under another', async () => {
    expect(await maskedEngineDump()).toEqual(await maskedEngineDump());
    const a = (await maskedEngineDump())[0]!.rows[0]![1];
    const b = (await maskedEngineDump('salt-b'))[0]!.rows[0]![1];
    expect(a).not.toBe(b);
  });
});

describe('maskRecords', () => {
  it('applies the same generator to the directory half', async () => {
    const mask = await createPseudonymizer('salt-a');
    const [link] = await maskRecords(
      [{ provider: 'oidc:https://auth.example.com', externalId: 'anna@example.com', principal: 'p1' }],
      mask,
    );
    expect(link!.externalId).not.toBe('anna@example.com');
    expect(link!.externalId).toMatch(/^[a-z0-9.]+@example\.(com|org|net|edu)$/);
    // Not PII by the heuristic, and load-bearing for reading the file.
    expect(link!.provider).toBe('oidc:https://auth.example.com');
    expect(link!.principal).toBe('p1');
  });

  it('agrees with maskDump when they share one pseudonymizer', async () => {
    const mask = await createPseudonymizer('salt-a');
    const [link] = await maskRecords([{ externalId: 'anna@example.com' }], mask);
    const out = await maskDump(dumpOf([ROW]), mask);
    expect(out[0]!.rows[0]![1]).toBe(link!.externalId);
  });

  it('renders a non-email external id as an opaque token', async () => {
    const [link] = await maskRecords([{ externalId: 'auth0|64f0c3' }], await createPseudonymizer('s'));
    expect(link!.externalId).toMatch(/^pseudo-[0-9a-f]{16}$/);
  });
});
