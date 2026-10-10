import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Page } from '@substrat-run/contracts';
import type { ScopeStub } from '@substrat-run/kernel';
import type { WorkOrder, BillableLine } from '@substrat-run/engine-workorder';
import { workorderManifest } from '@substrat-run/engine-workorder';
import {
  bikeShopManifest,
  buildBikeShopHost,
  protocolContentHash,
  seedBikeShop,
  type BikeShopWorld,
  type ProtocolDetail,
  type ProtocolInstanceRow,
  type ProtocolSignatureRow,
} from '../src/index.js';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';

/**
 * The Handlebar scenario (spec/concept.md §7) — the same engines as
 * Callout, replayed with bike-shop vocabulary: provision → modules →
 * repair lifecycle → priced completion (the MINIMUM-billing branch) →
 * event → invoicing → portal isolation → attack fails → state machine holds.
 * Then the milestone-B beat (steps 10–11, engine-protocol.md §2): the
 * tillståndsrapport — filled at intake/during the repair, signed by the
 * workshop, COUNTER-SIGNED by the customer on the frozen content at pickup —
 * running on the extracted protocol engine.
 */
describe('Handlebar demo scenario (spec §7)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: BikeShopWorld;
  let greta: ScopeStub;
  let mans: ScopeStub;
  let repairId: string;
  let serviceRepairId: string;
  let reportId: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-bike-shop-'));
    host = buildBikeShopHost(dir);
    w = await seedBikeShop(host, dir);
    greta = await host.getScope(w.greta, w.t1, w.s1);
    mans = await host.getScope(w.mans, w.t1, w.s1);
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
    db.close();
    expect(rows.map((r) => r.module_id)).toEqual([
      '@substrat-run/demo-handlebar',
      '@substrat-run/engine-invoicing',
      '@substrat-run/engine-protocol',
      '@substrat-run/engine-workorder',
    ]);
  });

  it("2. greta registers a repair for Lisbeth's Crescent", async () => {
    const repair = await greta.invoke<WorkOrder>('bike-shop/create-repair', {
      bikeId: w.crescentId,
      kind: 'punktering',
      title: 'Punktering bakhjul, växlar hoppar',
    });
    repairId = repair.id;
    expect(repair.number).toBe(1);
    expect(repair.status).toBe('planned');
    expect(repair.facility).toEqual({ entityType: 'bike', entityId: w.crescentId });
    expect(repair.customer.entityId).toBe(w.lisbethId);

    const { entries: timeline } = await greta.invoke<Page<{ type: string }>>('bike-shop/timeline', {
      entityType: 'workorder',
      entityId: repairId,
    });
    expect(timeline.map((e) => e.type)).toContain('workorder.created');
  });

  it('3. assign → start → report time and parts', async () => {
    await greta.invoke('workorder/assign', { orderId: repairId, technician: w.mans });
    await mans.invoke('workorder/start', { orderId: repairId });
    await mans.invoke('workorder/report-time', { orderId: repairId, hours: '0.25' });
    await mans.invoke('workorder/report-material', {
      orderId: repairId,
      article: 'sb:innerslang-28',
      qty: '1',
    });
    await mans.invoke('workorder/report-material', {
      orderId: repairId,
      article: 'verkstadsmtrl',
      qty: '1',
    });
    const detail = await mans.invoke<{ order: WorkOrder; time: unknown[]; material: unknown[] }>(
      'workorder/get',
      { orderId: repairId },
    );
    expect(detail.order.status).toBe('in_progress');
    expect(detail.time).toHaveLength(1);
    expect(detail.material).toHaveLength(2);
  });

  it('4. the denials hold: mechanic, portal user, and the cross-tenant attacker', async () => {
    await expect(
      mans.invoke('workorder/assign', { orderId: repairId, technician: w.mans }),
    ).rejects.toThrow(/permission denied/);

    // rutger (t2 workshop-admin) attacks t1's scope. Claiming it under his own
    // tenant fails closed on the pair check (K-3)…
    await expect(host.getScope(w.rutger, w.t2, w.s1)).rejects.toThrow(/unknown scope/);
    // …and with the correct pair he can mint a stub but holds no tuples in
    // t1 — every operation is denied by the owning scope's evaluation.
    const rutger = await host.getScope(w.rutger, w.t1, w.s1);
    await expect(rutger.invoke('workorder/list')).rejects.toThrow(/permission denied/);
    await expect(rutger.invoke('bike-shop/list-customers')).rejects.toThrow(/permission denied/);
    await expect(rutger.invoke('invoicing/list')).rejects.toThrow(/permission denied/);
    await expect(rutger.invoke<Page<unknown>>('bike-shop/portal-repairs')).resolves.toEqual({
      entries: [],
      nextCursor: null,
    });

    const lisbeth = await host.getScope(w.lisbeth, w.t1, w.s1);
    await expect(
      lisbeth.invoke('workorder/report-time', { orderId: repairId, hours: '1' }),
    ).rejects.toThrow(/permission denied/);
  });

  it('5. priced completion: the half-hour minimum bills, internal dropped, math exact', async () => {
    const result = await greta.invoke<{ billable: BillableLine[]; total: { amount: string } }>(
      'bike-shop/complete-repair',
      { orderId: repairId },
    );
    // 0.25h reported < 0.5 min → bill the minimum: 0.5 × 495 = 247.5.
    // Parts: 1 × 89 (innerslang); verkstadsmtrl is internal and dropped.
    expect(result.billable).toHaveLength(2);
    const labor = result.billable.find((b) => b.article === 'labor')!;
    expect(labor.qty).toBe('0.5');
    expect(labor.lineTotal.amount).toBe('247.5');
    const slang = result.billable.find((b) => b.article === 'sb:innerslang-28')!;
    expect(slang.lineTotal.amount).toBe('89');
    expect(result.total.amount).toBe('336.5');

    // Immutable after completion.
    await expect(
      greta.invoke('workorder/report-time', { orderId: repairId, hours: '1' }),
    ).rejects.toThrow(/invalid transition/);
  });

  it('6. star topology observed: the invoicing engine consumed the event', async () => {
    const { entries: underlag } = await greta.invoke<
      Page<{ id: string; status: string; total: string }>
    >('invoicing/list');
    expect(underlag).toHaveLength(1);
    expect(underlag[0]!.status).toBe('open');
    expect(underlag[0]!.total).toBe('336.5');

    const detail = await greta.invoke<
      { lines: { document_type: string; document_id: string; source_type: string | null }[] }
    >('invoicing/get', { underlagId: underlag[0]!.id });
    expect(detail.lines).toHaveLength(2);
    // Document-level provenance: the repair work order these lines came from (#328).
    expect(
      detail.lines.every((l) => l.document_type === 'workorder' && l.document_id === repairId),
    ).toBe(true);
    // The workorder path DOES carry per-line provenance — it is populated, not NULL.
    expect(detail.lines.every((l) => l.source_type !== null)).toBe(true);
  });

  it('7. portal isolation: lisbeth sees her repair, otto sees nothing, invoicing denied', async () => {
    const lisbeth = await host.getScope(w.lisbeth, w.t1, w.s1);
    const otto = await host.getScope(w.otto, w.t1, w.s1);

    const { entries: hers } = await lisbeth.invoke<Page<WorkOrder>>('bike-shop/portal-repairs');
    expect(hers.map((o) => o.id)).toEqual([repairId]);

    await expect(otto.invoke<Page<WorkOrder>>('bike-shop/portal-repairs')).resolves.toEqual({
      entries: [],
      nextCursor: null,
    });
    await expect(lisbeth.invoke('invoicing/list')).rejects.toThrow(/permission denied/);

    // lisbeth can read her repair's timeline through the same entity walk
    // (workorder → bike → customer).
    const { entries: timeline } = await lisbeth.invoke<Page<{ type: string }>>(
      'bike-shop/timeline',
      { entityType: 'workorder', entityId: repairId },
    );
    expect(timeline.length).toBeGreaterThan(3);
  });

  it('8. export makes the underlag immutable; the next completion opens a new one', async () => {
    const [underlag] = (await greta.invoke<Page<{ id: string }>>('invoicing/list')).entries;
    await greta.invoke('invoicing/export', { underlagId: underlag!.id });
    await expect(greta.invoke('invoicing/export', { underlagId: underlag!.id })).rejects.toThrow(
      /immutable/,
    );

    const repair2 = await greta.invoke<WorkOrder>('bike-shop/create-repair', {
      bikeId: w.crescentId,
      kind: 'service',
      title: 'Årsservice, byta kedja',
    });
    await greta.invoke('workorder/start', { orderId: repair2.id });
    await greta.invoke('workorder/report-time', { orderId: repair2.id, hours: '1' });
    await greta.invoke('workorder/report-material', {
      orderId: repair2.id,
      article: 'sb:kedja-9v',
      qty: '1',
    });
    await greta.invoke('bike-shop/complete-repair', { orderId: repair2.id });

    const { entries: all } = await greta.invoke<Page<{ status: string; total: string }>>('invoicing/list');
    expect(all).toHaveLength(2);
    expect(all.filter((u) => u.status === 'open')).toHaveLength(1);
    expect(all.filter((u) => u.status === 'exported')).toHaveLength(1);
    // 1h ≥ 0.5 min → 1 × 495 + kedja 249 = 744.
    expect(all.find((u) => u.status === 'open')!.total).toBe('744');
  });

  it('9. the bypass is CLOSED: workorder/close is withdrawn, and the state machine still holds behind the guard', async () => {
    // The engine's default binding is withdrawn in the bike-shop manifest: the
    // name does not resolve at all — indistinguishable from never registered.
    // Greta holds workorder:close; there is simply no ungated door to `closed`.
    await expect(greta.invoke('workorder/close', { orderId: repairId })).rejects.toThrow(
      /unknown operation/,
    );
    // The only door is the guarded one — and this repair carries no
    // tillståndsrapport, so the kernel refuses it.
    await expect(greta.invoke('bike-shop/close-repair', { orderId: repairId })).rejects.toThrow(
      /'tillstandsrapport' must be signed/,
    );

    // The engine invariant is untouched by the guard: a repair whose report IS
    // counter-signed still cannot skip planned → closed. Guard first (passes),
    // then the state machine (refuses).
    const repair3 = await greta.invoke<WorkOrder>('bike-shop/create-repair', {
      bikeId: w.crescentId,
      kind: 'service',
      title: 'Justera bromsar',
    });
    const report3 = await greta.invoke<ProtocolInstanceRow>('bike-shop/start-condition-report', {
      orderId: repair3.id,
    });
    await greta.invoke('protocol/fill', {
      instanceId: report3.id,
      itemKey: 'bromsar-ok',
      value: true,
    });
    await greta.invoke('protocol/sign', { instanceId: report3.id });
    const lisbeth = await host.getScope(w.lisbeth, w.t1, w.s1);
    await lisbeth.invoke('protocol/countersign', { instanceId: report3.id });
    await expect(greta.invoke('bike-shop/close-repair', { orderId: repair3.id })).rejects.toThrow(
      /invalid transition/,
    );
  });

  it('10. the condition report: opened at intake, filled append-only, fill/sign split holds', async () => {
    const repair = await greta.invoke<WorkOrder>('bike-shop/create-repair', {
      bikeId: w.crescentId,
      kind: 'service',
      title: 'Vårservice — full genomgång',
    });
    serviceRepairId = repair.id;

    // Intake: the condition report opens on the repair (vertical policy:
    // only while the repair is open; the engine pins the template version).
    const report = await greta.invoke<ProtocolInstanceRow>('bike-shop/start-condition-report', {
      orderId: serviceRepairId,
    });
    reportId = report.id;
    expect(report.status).toBe('open');
    expect(report.template_key).toBe('tillstandsrapport');
    expect(report.template_version).toBe(1);
    await expect(
      greta.invoke('bike-shop/start-condition-report', { orderId: serviceRepairId }),
    ).rejects.toThrow(/already open/);

    await greta.invoke('workorder/assign', { orderId: serviceRepairId, technician: w.mans });
    await mans.invoke('workorder/start', { orderId: serviceRepairId });

    // The mechanic fills; a correction is a NEW row (append-only history).
    await mans.invoke('protocol/fill', {
      instanceId: reportId,
      itemKey: 'ramskador',
      value: 'Lackskada vänster kedjestag (befintlig)',
    });
    await mans.invoke('protocol/fill', {
      instanceId: reportId,
      itemKey: 'ramskador',
      value: 'Lackskada vänster kedjestag (befintlig), repa på styret',
      note: 'såg repan vid tvätt',
    });
    await mans.invoke('protocol/fill', { instanceId: reportId, itemKey: 'belysning-fungerar', value: true });
    await mans.invoke('protocol/fill', { instanceId: reportId, itemKey: 'bromsar-ok', value: true });
    await mans.invoke('protocol/fill', { instanceId: reportId, itemKey: 'vaxlar-ok', value: true });
    await mans.invoke('protocol/fill', { instanceId: reportId, itemKey: 'provkord', value: true });

    const detail = await mans.invoke<ProtocolDetail>('protocol/get', { instanceId: reportId });
    expect(detail.responses).toHaveLength(6); // full history kept
    expect(detail.responses.filter((r) => r.item_key === 'ramskador')).toHaveLength(2);
    expect(JSON.parse(detail.latest['ramskador']!.value_json)).toMatch(/repa på styret/);

    // Counter-signing needs FROZEN content: before the workshop signs, even
    // the entitled customer is refused by the engine invariant.
    const lisbeth = await host.getScope(w.lisbeth, w.t1, w.s1);
    await expect(lisbeth.invoke('protocol/countersign', { instanceId: reportId })).rejects.toThrow(
      /only a signed \(frozen\) protocol/,
    );
    // The mechanic fills; only the verkstadschef signs (permission split).
    await expect(mans.invoke('protocol/sign', { instanceId: reportId })).rejects.toThrow(
      /permission denied/,
    );
  });

  it('11. sign freezes; the customer counter-signs the SAME frozen content at pickup', async () => {
    const signed = await greta.invoke<{
      instance: ProtocolInstanceRow;
      signature: ProtocolSignatureRow;
    }>('protocol/sign', { instanceId: reportId });
    expect(signed.instance.status).toBe('signed');
    expect(signed.signature.kind).toBe('primary');
    expect(signed.signature.content_hash).toMatch(/^[0-9a-f]{64}$/);

    // Frozen means frozen — for everyone, including the workshop.
    await expect(
      mans.invoke('protocol/fill', { instanceId: reportId, itemKey: 'anmarkningar', value: 'glömde' }),
    ).rejects.toThrow(/frozen/);

    // Priced completion happens before pickup; the report stays frozen through it.
    await mans.invoke('workorder/report-time', { orderId: serviceRepairId, hours: '1' });
    await greta.invoke('bike-shop/complete-repair', { orderId: serviceRepairId });

    // Pickup. The counter-signature is the CUSTOMER's act: no role carries
    // protocol:countersign — not even the verkstadschef…
    await expect(greta.invoke('protocol/countersign', { instanceId: reportId })).rejects.toThrow(
      /permission denied/,
    );
    // …and the WRONG customer's walk (protocol → workorder → bike → customer)
    // ends at Lisbeth's customer node, not Otto's.
    const otto = await host.getScope(w.otto, w.t1, w.s1);
    await expect(otto.invoke('protocol/countersign', { instanceId: reportId })).rejects.toThrow(
      /permission denied/,
    );

    // Lisbeth counter-signs: a SECOND signature row on the same frozen
    // content — the engine replays the hash recipe and must land on the
    // primary signature's hash before the row is written.
    const lisbeth = await host.getScope(w.lisbeth, w.t1, w.s1);
    const counter = await lisbeth.invoke<{
      instance: ProtocolInstanceRow;
      signature: ProtocolSignatureRow;
    }>('protocol/countersign', { instanceId: reportId });
    expect(counter.instance.status).toBe('signed'); // counter-sign is not a state change
    expect(counter.signature.kind).toBe('counter');
    expect(counter.signature.signed_by).toBe(w.lisbeth);
    expect(counter.signature.content_hash).toBe(signed.signature.content_hash);

    // Once is enough. The rule is stated over SIGNATORIES rather than
    // principals since milestone D, so it covers an external BankID signatory
    // the same way it covers Lisbeth.
    await expect(lisbeth.invoke('protocol/countersign', { instanceId: reportId })).rejects.toThrow(
      /has not already signed/,
    );

    // The customer can read the document she counter-signed (per-entity walk)
    // and anyone can replay the hash against stored state.
    const detail = await lisbeth.invoke<ProtocolDetail>('protocol/get', { instanceId: reportId });
    expect(detail.signatures.map((s) => s.kind)).toEqual(['primary', 'counter']);
    const replayed = await protocolContentHash(
      {
        key: detail.template.key,
        version: detail.template.version,
        content_json: JSON.stringify(detail.template.content),
      },
      detail.latest,
    );
    expect(replayed).toBe(signed.signature.content_hash);

    // Every mutation hit the spine, counter-signature included.
    const { entries: timeline } = await greta.invoke<Page<{ type: string }>>('bike-shop/timeline', {
      entityType: 'protocol',
      entityId: reportId,
    });
    expect(timeline.map((e) => e.type)).toEqual([
      'protocol.instantiated',
      'protocol.response-recorded',
      'protocol.response-recorded',
      'protocol.response-recorded',
      'protocol.response-recorded',
      'protocol.response-recorded',
      'protocol.response-recorded',
      'protocol.signed',
      'protocol.countersigned',
    ]);

    // The bike goes home — through the GUARDED pickup operation (step 12),
    // which the counter-signature has just satisfied.
    const closed = await greta.invoke<WorkOrder>('bike-shop/close-repair', {
      orderId: serviceRepairId,
    });
    expect(closed.status).toBe('closed');
  });

  it('12. the manifest guard gates pickup: blocked unsigned, blocked signed-only, allowed after the customer counter-signs', async () => {
    // Otto's Bianchi this time — the whole pickup ceremony, gate first.
    const repair = await greta.invoke<WorkOrder>('bike-shop/create-repair', {
      bikeId: w.bianchiId,
      kind: 'service',
      title: 'Service inför säsongen',
    });
    const report = await greta.invoke<ProtocolInstanceRow>('bike-shop/start-condition-report', {
      orderId: repair.id,
    });
    await greta.invoke('workorder/start', { orderId: repair.id });
    await greta.invoke('workorder/report-time', { orderId: repair.id, hours: '1' });
    await greta.invoke('protocol/fill', { instanceId: report.id, itemKey: 'bromsar-ok', value: true });
    await greta.invoke('protocol/fill', { instanceId: report.id, itemKey: 'provkord', value: true });
    await greta.invoke('bike-shop/complete-repair', { orderId: repair.id });

    // (a) The report exists but is unsigned: the KERNEL blocks the operation
    // before the handler ever runs — the verkstadschef holds workorder:close.
    await expect(greta.invoke('bike-shop/close-repair', { orderId: repair.id })).rejects.toThrow(
      /'tillstandsrapport' must be signed/,
    );

    // (b) Signed by the workshop is not enough — the gate is the CUSTOMER's
    // acceptance of the frozen content.
    await greta.invoke('protocol/sign', { instanceId: report.id });
    await expect(greta.invoke('bike-shop/close-repair', { orderId: repair.id })).rejects.toThrow(
      /'tillstandsrapport' must be counter-signed/,
    );

    // A blocked guard rolls back exactly like a handler throw: no state change,
    // no event on the spine. The repair is still `completed`, not `closed`.
    const stillOpen = (
      await greta.invoke<Page<WorkOrder>>('workorder/list', { status: 'completed' })
    ).entries.map((o) => o.id);
    expect(stillOpen).toContain(repair.id);
    const { entries: timeline } = await greta.invoke<Page<{ type: string }>>('bike-shop/timeline', {
      entityType: 'workorder',
      entityId: repair.id,
    });
    expect(timeline.map((e) => e.type)).not.toContain('workorder.closed');

    // (c) Otto counter-signs at pickup → the same operation now passes the gate.
    const otto = await host.getScope(w.otto, w.t1, w.s1);
    await otto.invoke('protocol/countersign', { instanceId: report.id });
    const closed = await greta.invoke<WorkOrder>('bike-shop/close-repair', { orderId: repair.id });
    expect(closed.status).toBe('closed');
  });

  it('13. the gate is visible in the manifest — dropping it is a reviewable diff', () => {
    // The property vertical-composed glue lacks (engine-protocol.md §6): the
    // compliance gate is DECLARED, not buried in an operation body. The engine
    // contributes the predicate; the vertical manifest wires it.
    expect(bikeShopManifest.guards).toEqual([
      {
        before: 'bike-shop/close-repair',
        predicate: 'protocol/all-signed',
        config: {
          templateKey: 'tillstandsrapport',
          entityType: 'workorder',
          entityIdFrom: 'orderId',
          countersigned: true,
        },
      },
    ]);
    // And the complement that makes the gate ENFORCEABLE, not merely visible.
    expect(bikeShopManifest.withdraws).toEqual(['workorder/close']);

    // The workorder engine stays ignorant of protocols, declares no guard, and
    // withdraws nothing — every one of these is the OTHER layer's business.
    expect(workorderManifest.guards).toBeUndefined();
    expect(workorderManifest.withdraws).toBeUndefined();
  });
});
