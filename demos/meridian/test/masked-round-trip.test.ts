import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformActorId, scopeId as asScopeId, type Page, type ScopeDump } from '@substrat-run/contracts';
import { ulid, type ScopeStub } from '@substrat-run/kernel';
import { createPseudonymizer, maskDump, MASKED } from '@substrat-run/control-plane-api';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import type { ProtocolDetail, ProtocolInstanceRow } from '@substrat-run/engine-protocol';
import {
  buildDemoHost,
  seedDemo,
  type DemoWorld,
  type EmployeeRow,
  type LeaveRequestRow,
} from '../src/index.js';

/**
 * The masked export, driven end to end by a real vertical (#1034's round-trip
 * acceptance item).
 *
 * `packages/control-plane-api/test/mask.test.ts` already proves the generator's own
 * properties over hand-built fixtures. What it structurally CANNOT prove is the claim
 * the feature actually rests on: that a pseudonymized dump is still a *working scope*.
 * That needs three things in one process — the generator, an adapter that can
 * `importScope`, and a vertical whose operations parse what they read — and a vertical's
 * own suite is the only place all three meet.
 *
 * So this seeds Meridian for real, exports it, pseudonymizes it, imports the result into
 * a fresh scope, and reads it back through Meridian's own operations and through both
 * engines it composes. Two failures it is here to catch, neither of which a unit test
 * over fixtures can see:
 *
 *  - **The dump stops being loadable.** A fake written into a column with a UNIQUE
 *    constraint, or into one an FK points at, fails at `importScope` — which is where a
 *    real `substrat scope pull` would fail, in front of a person who wanted a working
 *    copy.
 *  - **The copy stops being readable.** A value that no longer satisfies the schema the
 *    engine publishes throws at the seam (#771) on every read of that row. A scope that
 *    throws on every screen is no better than the `[masked]` it replaced.
 *
 * And one property that only a real seed can state honestly: NOTHING a person typed
 * into the source survives anywhere in the masked bytes — not in its own row, not in a
 * fat event payload that quoted it. The seed's literals are the source of truth for
 * that, not a fixture invented to match the sweep.
 *
 * What this suite does NOT cover, stated rather than dropped: a DERIVED search index.
 * Meridian declares no `searchables`, so its dump carries no FTS shadow table for a
 * pseudonym to fall out of step with. The byte sweep below still decodes every blob
 * it meets, but the behavioural half — "the real name finds nothing, the fake one
 * finds the row" — has no search operation here to ask.
 */
describe('a pseudonymized export of a real scope (#1034)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: DemoWorld;
  let dump: ScopeDump;
  let masked: ScopeDump;
  let onboardingId: string;
  let leaveRequestId: string;
  let copyId: string;
  let copy: ScopeStub;

  /**
   * Every PII literal the Meridian seed (and the two writes below) put into the Swedish
   * scope, as a person typed it. If a value here survives into the masked dump, the
   * export handed out real personal data.
   *
   * `LEAVE_NOTE` is deliberately in this list even though its column classifies as
   * free text and keeps `[masked]`: "redacted" and "leaked" are different outcomes, and
   * this asserts which one it got.
   *
   * NOT in this list: Elin's `national_id`. It does survive masking today — see the
   * `it.fails` case at the bottom, which says why and turns red the day it stops.
   */
  const LEAVE_NOTE = 'Tandläkare på Odenplan kl 9, sedan hämtar jag Signe på förskolan';
  const SEEDED_PII = [
    'Elin Ek',
    'Karin Berg',
    'Mats Lund',
    'Hedda Ohlsson',
    'elin@nordljus.se',
    'karin@nordljus.se',
    'mats@nordljus.se',
    'hedda@nordljus.se',
    LEAVE_NOTE,
  ];
  const NATIONAL_ID = '19900101-0000';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-masked-'));
    host = buildDemoHost(dir);
    w = await seedDemo(host, dir);
    const hedda = await host.getScope(w.hedda, w.t1, w.sSe);
    const elin = await host.getScope(w.elin, w.t1, w.sSe);

    // A signature request on Elin's onboarding checklist, with the parties labelled the
    // way a person fills the box in: by name (#1369). That puts a human's name into an
    // ENGINE-owned row (`protocol_signature_requests.party_label`, read back through
    // `returns(protocolDetail, …)`) AND into a fat event payload
    // (`protocol.signatures-requested` → `parties[].label`) — the two places a
    // pseudonym has to agree with the employee row it came from. Meridian's own events
    // carry ids rather than names, so this is where the spine quotes a person.
    const [onboarding] = (
      await hedda.invoke<Page<{ instance: ProtocolInstanceRow }>>('protocol/list-for-entity', {
        entityType: 'employee',
        entityId: w.elinEmpId,
      })
    ).entries;
    onboardingId = onboarding!.instance.id;
    await hedda.invoke('protocol/request-signatures', {
      instanceId: onboardingId,
      method: 'scrive',
      parties: [
        {
          label: 'Hedda Ohlsson',
          kind: 'principal',
          ref: w.hedda,
          signatureKind: 'primary',
          contact: { email: 'hedda@nordljus.se' },
        },
        { label: 'Elin Ek', kind: 'external', ref: w.elinEmpId, contact: { email: 'elin@nordljus.se' } },
      ],
    });

    // A leave request with a note: free text a person typed, landing in the absence
    // engine's own table and read back through its seam.
    const req = await elin.invoke<LeaveRequestRow>('hr/request-leave', {
      employeeId: w.elinEmpId,
      leaveTypeKey: 'vacation',
      startDate: '2026-07-06',
      endDate: '2026-07-10',
      days: '5',
      note: LEAVE_NOTE,
    });
    leaveRequestId = req.id;

    const staff = platformActorId.parse(ulid());
    dump = await host.admin.exportScope(staff, w.t1, w.sSe);
    const mask = await createPseudonymizer('a-test-salt');
    masked = { ...dump, tables: await maskDump(dump.tables, mask) };

    // Land the copy in the SAME tenant, so hedda's tenant-level HR admin role covers it
    // and the read-back is the vertical's own permission path rather than a test-only
    // grant. The dump's own ids are provenance; `input` says where it lands.
    const dest = asScopeId.parse(ulid());
    copyId = dest;
    await host.importScope(staff, { tenantId: w.t1, scopeId: dest, jurisdiction: 'eu' }, masked);
    copy = await host.getScope(w.hedda, w.t1, dest);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Every string in the masked dump, blobs decoded. */
  function maskedStrings(): string[] {
    // Decoded rather than `JSON.stringify`d, because a dump keeps blobs as bytes: an FTS
    // shadow table's `block` column serialises to `{"type":"Buffer","data":[…]}`, and a
    // secret sitting inside one would not appear as a substring of that.
    const decoder = new TextDecoder();
    const seen: string[] = [];
    for (const table of masked.tables) {
      for (const row of table.rows) {
        for (const cell of row) {
          if (typeof cell === 'string') seen.push(cell);
          else if (cell instanceof Uint8Array) seen.push(decoder.decode(cell));
        }
      }
    }
    return seen;
  }

  it('hands back nothing anyone typed into the source', () => {
    const seen = maskedStrings();
    const bytes = seen.join(' ');
    for (const secret of SEEDED_PII) expect(bytes).not.toContain(secret);
    // …and the scan is not vacuous: the dump really does carry the tables it swept,
    // and the source really did hold every literal it is checked for.
    expect(seen.length).toBeGreaterThan(50);
    const source = JSON.stringify(dump.tables);
    for (const secret of SEEDED_PII) expect(source).toContain(secret);
    expect(source).toContain(NATIONAL_ID); // the precondition the `it.fails` case leans on
  });

  it('still carries every row and every table the source had', () => {
    expect(masked.tables.map((t) => t.name)).toEqual(dump.tables.map((t) => t.name));
    for (const [i, table] of masked.tables.entries()) {
      expect(table.rows.length).toBe(dump.tables[i]!.rows.length);
    }
  });

  it('reads back through the vertical with plausible values, not `[masked]`', async () => {
    // That `importScope` did not throw is itself half the assertion — a fake written into
    // a column with a UNIQUE constraint fails there, before any of this runs.
    const { entries } = await copy.invoke<Page<EmployeeRow>>('hr/list-employees');
    expect(entries.map((e) => e.number)).toEqual(['SE-001', 'SE-002', 'SE-003', 'SE-004']);
    const elin = entries.find((e) => e.id === w.elinEmpId)!;

    // A person's name, not a token: the fake is drawn from the name lists, so a screen
    // shows two capitalised words rather than a hash or a redaction bar.
    for (const e of entries) {
      expect(e.name).not.toBe(MASKED);
      expect(e.name).toMatch(/^[A-Z][a-zA-Z]+ [A-Z][a-zA-Z]+$/);
      // An email still reads as one — at a reserved domain, so it reaches nobody.
      expect(e.email).toMatch(/^[a-z]+\.[a-z]+\.[0-9a-f]+@example\.(com|org|net|edu)$/);
    }
    // Ids are not PII and must survive verbatim, or the copy stops joining to itself.
    expect(elin.principal_ref).toBe(w.elin);
  });

  it('parses at the engine seams — the copy is readable, not just loadable', async () => {
    // `protocol/get` goes out through `returns(protocolDetail, …)` (#771), and the
    // absence engine's `listRequests` through `returns(absenceRequest, …)`. A pseudonym
    // that no longer satisfies a published schema throws here rather than reaching a
    // screen.
    const detail = await copy.invoke<ProtocolDetail>('protocol/get', { instanceId: onboardingId });
    expect(detail.instance.id).toBe(onboardingId); // ids are not PII and must survive verbatim
    expect(detail.instance.status).toBe('pending_signature');
    expect(detail.requests.map((r) => r.party_kind).sort()).toEqual(['external', 'principal']);
    for (const r of detail.requests) {
      expect(r.party_label).toMatch(/^[A-Z][a-zA-Z]+ [A-Z][a-zA-Z]+$/);
    }

    const { entries } = await copy.invoke<Page<LeaveRequestRow>>('hr/list-requests', {});
    expect(entries.map((r) => r.id)).toEqual([leaveRequestId]);
    expect(entries[0]!.status).toBe('requested');
    // NOT asserted here: `employee_id`, which reads `[masked]` — see the `it.fails` case
    // on the absence engine's subject columns below. Its precondition is held here: the
    // SOURCE answers the balance that case expects the copy to answer.
    const source = await host.getScope(w.hedda, w.t1, w.sSe);
    const bal = await source.invoke<{ balances: { leaveTypeKey: string; balance: string }[] }>(
      'hr/balance',
      { employeeId: w.elinEmpId },
    );
    expect(bal.balances).toEqual([{ leaveTypeKey: 'vacation', balance: '25' }]);
  });

  it('agrees with itself across the copy: the row, the engine row and the event name one person', async () => {
    const { entries } = await copy.invoke<Page<EmployeeRow>>('hr/list-employees');
    const elin = entries.find((e) => e.id === w.elinEmpId)!;
    const hedda = entries.find((e) => e.principal_ref === w.hedda)!;

    // Three places name Elin: her employee row, the engine's signature-request row,
    // and the fat `protocol.signatures-requested` event a connector or timeline reads.
    // Determinism is the whole reason they agree — without it the same person has
    // three names depending on which screen you are looking at, which is exactly the
    // copy nobody can demo from.
    const detail = await copy.invoke<ProtocolDetail>('protocol/get', { instanceId: onboardingId });
    const label = (kind: string) => detail.requests.find((r) => r.party_kind === kind)!.party_label;
    expect(label('external')).toBe(elin.name);
    expect(label('principal')).toBe(hedda.name);

    const db = new Database(join(dir, `${w.t1}__${copyId}.sqlite`), { readonly: true });
    const event = db
      .prepare(`SELECT payload FROM _substrat_outbox WHERE type = 'protocol.signatures-requested' AND entity_id = ?`)
      .get(onboardingId) as { payload: string } | undefined;
    db.close();

    expect(event).toBeDefined();
    const payload = JSON.parse(event!.payload) as { parties: { label: string; kind: string }[] };
    const party = payload.parties.find((p) => p.kind === 'external')!;
    expect(party.label).not.toBe('Elin Ek');
    expect(party.label).toBe(elin.name);
  });

  it('keeps free text redacted rather than inventing a sentence', async () => {
    const { entries } = await copy.invoke<Page<LeaveRequestRow>>('hr/list-requests', {});
    // Not a fake sentence and not the original: `note` classifies as free text, so
    // `[masked]` is the stated outcome rather than an omission (`pseudonymize.ts` header).
    expect(entries[0]!.note).toBe(MASKED);
  });

  // A KNOWN LEAK, pinned so it cannot go quiet. Meridian declares `national_id` a
  // crypto-shred target (`src/entities.ts`, `erasable`), and `pseudonymize.ts` promises
  // national identifiers stay `[masked]` — but its column heuristic names only `ssn` and
  // `personnummer`, so `national_id` passes through verbatim. `it.fails` passes while
  // the leak is there and turns red the day the heuristic covers it: move NATIONAL_ID
  // into SEEDED_PII then, and delete this case.
  // A KNOWN BREAK, pinned for the same reason. The absence engine keys its rows on an
  // `EntityRef` stored as `subject_type` / `subject_id` (plus `data_subject_id`), and the
  // free-text pattern in `pseudonymize.ts` matches `subject` — meant for an email's
  // subject line — so all three become `[masked]`. Ids are not PII and must survive
  // verbatim: as it is, the copy's ledger and leave requests point at no employee, and
  // Elin's 25-day balance reads as no balance at all. Turns red when that is fixed;
  // then assert `employee_id` in the seam case above and delete this one.
  it.fails('keeps the absence engine joined to its employee (`subject_*` heuristic gap)', async () => {
    const bal = await copy.invoke<{ balances: { leaveTypeKey: string; balance: string }[] }>(
      'hr/balance',
      { employeeId: w.elinEmpId },
    );
    expect(bal.balances).toEqual([{ leaveTypeKey: 'vacation', balance: '25' }]);
  });

  it.fails('masks a national id stored as `national_id` (heuristic gap)', () => {
    expect(maskedStrings().join(' ')).not.toContain(NATIONAL_ID);
  });
});
