import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ScopeStub } from '@substrat-run/kernel';
import type { WorkOrder, BillableLine } from '@substrat-run/engine-workorder';
import {
  buildDemoHost,
  seedDemo,
  protocolContentHash,
  type DemoWorld,
  type ProtocolDetail,
  type ProtocolInstanceRow,
  type ProtocolSignatureRow,
  type ProtocolTemplateRow,
} from '../src/index.js';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';

/**
 * The scenario from spec/testrun.md §8 — the headless end-to-end run:
 * provision → modules → lifecycle → priced completion → event → invoicing →
 * portal isolation → attack fails → plain .sqlite files, then the
 * self-inspection beat (steps 10–13, engine-protocol.md milestone A): the guard
 * blocks completion → append-only fill → sign freezes → templates version
 * immutably.
 */
describe('FSM demo scenario (spec §8)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: DemoWorld;
  let anna: ScopeStub;
  let harald: ScopeStub;
  let orderId: string;
  let montageOrderId: string;
  let protocolId: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-fsm-'));
    host = buildDemoHost(dir);
    w = await seedDemo(host, dir);
    anna = await host.getScope(w.anna, w.t1, w.s1);
    harald = await host.getScope(w.harald, w.t1, w.s1);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('1. provisions and applies all four module journals', () => {
    const db = new Database(join(dir, `${w.t1}__${w.s1}.sqlite`), { readonly: true });
    const rows = db
      .prepare('SELECT DISTINCT module_id FROM _substrat_migrations ORDER BY module_id')
      .all() as { module_id: string }[];
    // Milestone B: the extraction's migration consequence — the vertical's
    // journal replays its shipped 0002 (legacy tables) and the 0003 move; the
    // protocol engine journals its own 0001. Append-only means fresh scopes
    // replay history: the legacy callout_protocol_* tables are created,
    // copied (empty here) and dropped.
    expect(rows.map((r) => r.module_id)).toEqual([
      '@substrat-run/demo-callout',
      '@substrat-run/engine-invoicing',
      '@substrat-run/engine-protocol',
      '@substrat-run/engine-workorder',
    ]);
    const fsmVersions = db
      .prepare("SELECT version FROM _substrat_migrations WHERE module_id = '@substrat-run/demo-callout' ORDER BY version")
      .all() as { version: string }[];
    db.close();
    // The last two are DERIVED, not authored (#827): the kernel turns each
    // `searchables` entry into an index migration and journals it like any other,
    // so a changed declaration shows up in the migration diff a human reads —
    // rather than an index quietly changing shape under a running scope. The
    // version IS the declaration, which is what makes that diff legible.
    expect(fsmVersions.map((v) => v.version)).toEqual([
      '0001-init',
      '0002-protocols',
      '0003-protocols-to-engine',
      'search/customer:prefix:name+number',
      'search/facility:prefix:name+address',
    ]);
  });

  it('2–3. anna creates a work order at Förskolan Grunden', async () => {
    const order = await anna.invoke<WorkOrder>('callout/create-workorder', {
      facilityId: w.forskolanId,
      kind: 'akut',
      title: 'Droppar vatten från frysen',
    });
    orderId = order.id;
    expect(order.number).toBe(1);
    expect(order.status).toBe('planned');
    expect(order.customer.entityId).toBe(w.grundenId);

    const timeline = await anna.invoke<{ type: string }[]>('callout/timeline', {
      entityType: 'workorder',
      entityId: orderId,
    });
    expect(timeline.map((e) => e.type)).toContain('workorder.created');
  });

  it('3. assign → start → report time and material', async () => {
    await anna.invoke('workorder/assign', { orderId, technician: w.harald });
    await harald.invoke('workorder/start', { orderId });
    await harald.invoke('workorder/report-time', { orderId, hours: '1' });
    await harald.invoke('workorder/report-time', { orderId, hours: '0.75' });
    await harald.invoke('workorder/report-material', {
      orderId,
      article: 'mat:fan-motor-15w',
      qty: '1',
    });
    const detail = await harald.invoke<{ order: WorkOrder; time: unknown[]; material: unknown[] }>(
      'workorder/get',
      { orderId },
    );
    expect(detail.order.status).toBe('in_progress');
    expect(detail.time).toHaveLength(2);
    expect(detail.material).toHaveLength(1);
  });

  it('4. the denials hold: technician, portal user, and the cross-tenant attacker', async () => {
    await expect(
      harald.invoke('workorder/assign', { orderId, technician: w.harald }),
    ).rejects.toThrow(/permission denied/);

    // mallory (t2 office-admin) attacks t1's scope. Claiming it under her own
    // tenant fails closed on the pair check (K-3)…
    await expect(host.getScope(w.mallory, w.t2, w.s1)).rejects.toThrow(/unknown scope/);
    // …and with the correct pair she can mint a stub but holds no tuples in
    // t1 — every operation is denied by the owning scope's evaluation.
    const mallory = await host.getScope(w.mallory, w.t1, w.s1);
    await expect(mallory.invoke('workorder/list')).rejects.toThrow(/permission denied/);
    await expect(mallory.invoke('invoicing/list')).rejects.toThrow(/permission denied/);
    await expect(mallory.invoke<unknown[]>('callout/portal-orders')).resolves.toEqual([]);

    const berit = await host.getScope(w.berit, w.t1, w.s1);
    await expect(berit.invoke('workorder/report-time', { orderId, hours: '1' })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('5. priced completion: min-qty applied, internal dropped, snapshot math exact', async () => {
    const result = await anna.invoke<{ billable: BillableLine[]; total: { amount: string } }>(
      'callout/complete-workorder',
      { orderId },
    );
    // 1.75h reported > 1.5 min → 1.75 × 515 = 901.25; material 1 × 1150.
    expect(result.billable).toHaveLength(2);
    const labor = result.billable.find((b) => b.article === 'labor')!;
    expect(labor.qty).toBe('1.75');
    expect(labor.lineTotal.amount).toBe('901.25');
    expect(result.total.amount).toBe('2051.25');

    // Immutable after completion.
    await expect(
      anna.invoke('workorder/report-time', { orderId, hours: '1' }),
    ).rejects.toThrow(/invalid transition/);
  });

  it('6. star topology observed: the invoicing engine consumed the event', async () => {
    const underlag = await anna.invoke<{ id: string; status: string; total: string }[]>(
      'invoicing/list',
    );
    expect(underlag).toHaveLength(1);
    expect(underlag[0]!.status).toBe('open');
    expect(underlag[0]!.total).toBe('2051.25');

    const detail = await anna.invoke<
      { lines: { document_type: string; document_id: string; source_type: string | null }[] }
    >('invoicing/get', { underlagId: underlag[0]!.id });
    expect(detail.lines).toHaveLength(2);
    // Document-level provenance: the work order these lines came from (#328).
    expect(
      detail.lines.every((l) => l.document_type === 'workorder' && l.document_id === orderId),
    ).toBe(true);
    // The workorder path DOES carry per-line provenance — it is populated, not NULL.
    expect(detail.lines.every((l) => l.source_type !== null)).toBe(true);
  });

  it('7. portal isolation: berit sees her order, styrbjörn sees nothing, invoicing denied', async () => {
    const berit = await host.getScope(w.berit, w.t1, w.s1);
    const styrbjorn = await host.getScope(w.styrbjorn, w.t1, w.s1);

    const berits = await berit.invoke<WorkOrder[]>('callout/portal-orders');
    expect(berits.map((o) => o.id)).toEqual([orderId]);

    await expect(styrbjorn.invoke<WorkOrder[]>('callout/portal-orders')).resolves.toEqual([]);
    await expect(berit.invoke('invoicing/list')).rejects.toThrow(/permission denied/);

    // berit can read her order's timeline through the same entity walk.
    const timeline = await berit.invoke<{ type: string }[]>('callout/timeline', {
      entityType: 'workorder',
      entityId: orderId,
    });
    expect(timeline.length).toBeGreaterThan(3);
  });

  it('8. export makes the underlag immutable; the next completion opens a new one', async () => {
    const [underlag] = await anna.invoke<{ id: string }[]>('invoicing/list');
    await anna.invoke('invoicing/export', { underlagId: underlag!.id });
    await expect(anna.invoke('invoicing/export', { underlagId: underlag!.id })).rejects.toThrow(
      /immutable/,
    );

    const order2 = await anna.invoke<WorkOrder>('callout/create-workorder', {
      facilityId: w.forskolanId,
      kind: 'service',
      title: 'Filterbyte',
    });
    await anna.invoke('workorder/start', { orderId: order2.id });
    await anna.invoke('workorder/report-time', { orderId: order2.id, hours: '1' });
    await anna.invoke('callout/complete-workorder', { orderId: order2.id });

    const all = await anna.invoke<{ status: string }[]>('invoicing/list');
    expect(all).toHaveLength(2);
    expect(all.filter((u) => u.status === 'open')).toHaveLength(1);
    expect(all.filter((u) => u.status === 'exported')).toHaveLength(1);
  });

  it('9. close completes the state machine', async () => {
    const closed = await anna.invoke<WorkOrder>('workorder/close', { orderId });
    expect(closed.status).toBe('closed');
    // planned → closed skip is impossible: close on the OPEN second order fails.
    const open = (await anna.invoke<WorkOrder[]>('workorder/list', { status: 'completed' }))[0]!;
    await anna.invoke('workorder/close', { orderId: open.id });
    const order3 = await anna.invoke<WorkOrder>('callout/create-workorder', {
      facilityId: w.kontorId,
      kind: 'service',
      title: 'Ny belysning',
    });
    await expect(anna.invoke('workorder/close', { orderId: order3.id })).rejects.toThrow(
      /invalid transition/,
    );
  });

  it('10. the guard: a montage order cannot complete without a signed self-inspection', async () => {
    const order = await anna.invoke<WorkOrder>('callout/create-workorder', {
      facilityId: w.forskolanId,
      kind: 'montage',
      title: 'Ny gruppcentral i undercentralen',
    });
    montageOrderId = order.id;
    await anna.invoke('workorder/start', { orderId: montageOrderId });
    await anna.invoke('workorder/report-time', { orderId: montageOrderId, hours: '2' });

    // Vertical-composed guard (engine-protocol.md §6, milestone-A pole):
    // no protocol at all → blocked…
    await expect(
      anna.invoke('callout/complete-workorder', { orderId: montageOrderId }),
    ).rejects.toThrow(/protocol required: 'self-inspection-electrical'/);

    // …and an instantiated-but-unsigned protocol still blocks.
    const inst = await anna.invoke<ProtocolInstanceRow>('callout/instantiate-protocol', {
      templateKey: 'self-inspection-electrical',
      entityType: 'workorder',
      entityId: montageOrderId,
    });
    protocolId = inst.id;
    expect(inst.status).toBe('open');
    expect(inst.template_version).toBe(1);
    await expect(
      anna.invoke('callout/complete-workorder', { orderId: montageOrderId }),
    ).rejects.toThrow(/protocol required/);

    // One open instance per (template, entity): starting it twice fails.
    await expect(
      anna.invoke('callout/instantiate-protocol', {
        templateKey: 'self-inspection-electrical',
        entityType: 'workorder',
        entityId: montageOrderId,
      }),
    ).rejects.toThrow(/already open/);
  });

  it('11. fill is append-only (a correction is a new row); fill and sign are separate permissions', async () => {
    await harald.invoke('protocol/fill', {
      instanceId: protocolId,
      itemKey: 'spanningslost',
      value: true,
    });
    await harald.invoke('protocol/fill', {
      instanceId: protocolId,
      itemKey: 'isolationsmatning',
      value: '4.2',
    });
    // The correction before signing: a NEW row, never an update.
    await harald.invoke('protocol/fill', {
      instanceId: protocolId,
      itemKey: 'isolationsmatning',
      value: '5.1',
      note: 'ommätt efter åtdragning',
    });
    await harald.invoke('protocol/fill', {
      instanceId: protocolId,
      itemKey: 'jordfelsbrytare',
      value: true,
    });

    const detail = await harald.invoke<ProtocolDetail>('protocol/get', {
      instanceId: protocolId,
    });
    expect(detail.responses).toHaveLength(4); // full history kept
    expect(
      detail.responses
        .filter((r) => r.item_key === 'isolationsmatning')
        .map((r) => JSON.parse(r.value_json)),
    ).toEqual(['4.2', '5.1']); // the audit trail: 4.2 → 5.1 before signing
    expect(JSON.parse(detail.latest['isolationsmatning']!.value_json)).toBe('5.1'); // latest wins

    // Responses validate against the pinned template.
    await expect(
      harald.invoke('protocol/fill', {
        instanceId: protocolId,
        itemKey: 'finns-inte',
        value: true,
      }),
    ).rejects.toThrow(/unknown item/);
    await expect(
      harald.invoke('protocol/fill', {
        instanceId: protocolId,
        itemKey: 'spanningslost',
        value: 'ja',
      }),
    ).rejects.toThrow(/must be boolean/);

    // The technician fills; only the arbetsledare signs (permission split).
    await expect(harald.invoke('protocol/sign', { instanceId: protocolId })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('12. sign freezes the protocol, records a verifiable hash, and opens the guard', async () => {
    const signed = await anna.invoke<{
      instance: ProtocolInstanceRow;
      signature: ProtocolSignatureRow;
    }>('protocol/sign', { instanceId: protocolId });
    expect(signed.instance.status).toBe('signed');
    expect(signed.signature.method).toBe('in-app');
    expect(signed.signature.signed_by).toBe(w.anna);
    expect(signed.signature.content_hash).toMatch(/^[0-9a-f]{64}$/);

    // The invariant: any write to a signed instance's responses fails.
    await expect(
      harald.invoke('protocol/fill', {
        instanceId: protocolId,
        itemKey: 'kontinuitet',
        value: '0.3',
      }),
    ).rejects.toThrow(/frozen/);
    // One signature per instance: signing again fails on the status invariant.
    await expect(anna.invoke('protocol/sign', { instanceId: protocolId })).rejects.toThrow(
      /only an open protocol/,
    );

    // The hash is verifiable against replayed state (engine-protocol.md §4.2).
    const detail = await anna.invoke<ProtocolDetail>('protocol/get', {
      instanceId: protocolId,
    });
    const replayed = await protocolContentHash(
      {
        key: detail.template.key,
        version: detail.template.version,
        content_json: JSON.stringify(detail.template.content),
      },
      detail.latest,
    );
    expect(replayed).toBe(signed.signature.content_hash);

    // Every mutation hit the spine.
    const timeline = await anna.invoke<{ type: string }[]>('callout/timeline', {
      entityType: 'protocol',
      entityId: protocolId,
    });
    expect(timeline.map((e) => e.type)).toEqual([
      'protocol.instantiated',
      'protocol.response-recorded',
      'protocol.response-recorded',
      'protocol.response-recorded',
      'protocol.response-recorded',
      'protocol.signed',
    ]);

    // The guard opens: completion now goes through, pricing intact.
    const result = await anna.invoke<{ order: WorkOrder; total: { amount: string } }>(
      'callout/complete-workorder',
      { orderId: montageOrderId },
    );
    expect(result.order.status).toBe('completed');
    expect(result.total.amount).toBe('1030'); // 2h × 515
  });

  it('13. templates version immutably: new content = v2, the signed instance stays pinned to v1', async () => {
    const v2 = await anna.invoke<ProtocolTemplateRow>('protocol/define-template', {
      key: 'self-inspection-electrical',
      title: 'Self-inspection — Elinstallation (utökad)',
      content: {
        sections: [
          {
            title: 'Kontroll före idrifttagning',
            items: [
              { key: 'isolationsmatning', label: 'Isolationsmätning', type: 'value', unit: 'MΩ' },
              { key: 'markning', label: 'Märkning av central uppdaterad', type: 'check' },
            ],
          },
        ],
      },
    });
    expect(v2.version).toBe(2);

    // The signed document still refers to exactly what was signed.
    const detail = await anna.invoke<ProtocolDetail>('protocol/get', {
      instanceId: protocolId,
    });
    expect(detail.instance.template_version).toBe(1);
    expect(detail.template.version).toBe(1);
    expect(detail.template.title).toBe('Self-inspection — Elinstallation');

    // A voided protocol is superseded, never deleted: rows survive.
    const order = await anna.invoke<WorkOrder>('callout/create-workorder', {
      facilityId: w.kontorId,
      kind: 'montage',
      title: 'Belysningsstyrning',
    });
    const inst = await anna.invoke<ProtocolInstanceRow>('callout/instantiate-protocol', {
      templateKey: 'self-inspection-electrical',
      entityType: 'workorder',
      entityId: order.id,
    });
    expect(inst.template_version).toBe(2); // new instances pin the new version
    const voided = await anna.invoke<ProtocolInstanceRow>('protocol/void', {
      instanceId: inst.id,
      reason: 'startad på fel order',
    });
    expect(voided.status).toBe('voided');
    expect(voided.voided_reason).toBe('startad på fel order');
    await expect(
      anna.invoke('protocol/fill', { instanceId: inst.id, itemKey: 'markning', value: true }),
    ).rejects.toThrow(/frozen/);
  });

  /**
   * 14 (#827). The picker. `list-customers` returns every customer in number
   * order, which is the read a dispatcher uses at three customers and cannot use
   * at three thousand — and once #811 wraps that list in a `Page<T>`, filtering
   * it client-side searches the first page only.
   *
   * The seeded world is small, so this seeds a crowd first: the assertion that
   * matters is that the answer is found by an INDEX rather than by the caller
   * reading everything and filtering.
   */
  describe('14. finding a customer among many (#827)', () => {
    interface SearchResult {
      results: { id: string; name: string; number: string }[];
      limit: number;
      capped: boolean;
    }

    beforeAll(async () => {
      for (let i = 0; i < 60; i++) {
        await anna.invoke('callout/create-customer', {
          number: `9${String(i).padStart(3, '0')}`,
          name: `Bostadsrättsföreningen Nummer ${i}`,
        });
      }
      await anna.invoke('callout/create-customer', { number: '8100', name: 'Andersson Fastigheter AB' });
    });

    it('finds one customer among many by a prefix of the name', async () => {
      const found = await anna.invoke<SearchResult>('callout/search-customers', { q: 'anders' });
      expect(found.results.map((r) => r.name)).toEqual(['Andersson Fastigheter AB']);
      expect(found.capped).toBe(false);
    });

    it('finds by customer number, the key a human actually quotes', async () => {
      const found = await anna.invoke<SearchResult>('callout/search-customers', { q: '8100' });
      expect(found.results.map((r) => r.number)).toEqual(['8100']);
    });

    it('says when it capped, so a picker can ask for a narrower term', async () => {
      const found = await anna.invoke<SearchResult>('callout/search-customers', {
        q: 'bostadsrättsföreningen',
        limit: 5,
      });
      expect(found.results).toHaveLength(5);
      expect(found.capped).toBe(true);
    });

    it('sees a customer created moments earlier — no indexing lag to wait out', async () => {
      await anna.invoke('callout/create-customer', { number: '8200', name: 'Zetterlund Kyla' });
      const found = await anna.invoke<SearchResult>('callout/search-customers', { q: 'zetterlund' });
      expect(found.results.map((r) => r.number)).toEqual(['8200']);
    });

    it('is gated by the same permission as the list it replaces', async () => {
      await expect(
        harald.invoke('callout/search-customers', { q: 'anders' }),
      ).rejects.toThrow(/permission|denied/i);
    });
  });
});
