import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { addMoney, moneyOf, mulMoney, type Page } from '@substrat-run/contracts';
import type { ScopeStub } from '@substrat-run/kernel';
import type { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import type { WorkOrder, BillableLine } from '@substrat-run/engine-workorder';
import { buildBikeShopHost, seedBikeShop, type BikeShopWorld } from '../src/seed.js';

// ============================================================================
// The bike-shop scenario, replayed headlessly against a temp dir: a repair's
// full lifecycle (create → assign → start → report → priced completion) drives
// the invoicing engine BY EVENT, then every door that should be shut is proven
// shut — each denial pinned to its message and paired with a control that a
// neighbouring door is open, so a green test can never be a silently-broken one.
// ============================================================================

describe('bike-shop scenario', () => {
  let dir: string;
  let host: SqliteScopeHost;
  let w: BikeShopWorld;
  let greta: ScopeStub;
  let mans: ScopeStub;
  let repairId: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-bikeshop-'));
    host = buildBikeShopHost(dir);
    w = await seedBikeShop(host, dir);
    greta = await host.getScope(w.greta, w.t1, w.s1);
    mans = await host.getScope(w.mans, w.t1, w.s1);
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('1. provisions and applies all three module journals', () => {
    const db = new Database(join(dir, `${w.t1}__${w.s1}.sqlite`), { readonly: true });
    const rows = db
      .prepare('SELECT DISTINCT module_id FROM _substrat_migrations ORDER BY module_id')
      .all() as { module_id: string }[];
    db.close();
    expect(rows.map((r) => r.module_id)).toEqual([
      '@substrat-run/engine-invoicing',
      '@substrat-run/engine-workorder',
      'bikeshop',
    ]);
  });

  it("2. greta opens a repair for Lisbeth's Crescent", async () => {
    const repair = await greta.invoke<WorkOrder>('shop/create-repair', {
      bikeId: w.crescentId,
      kind: 'puncture',
      title: 'Rear puncture, gears skipping',
    });
    repairId = repair.id;
    expect(repair.number).toBe(1);
    expect(repair.status).toBe('planned');
    expect(repair.facility).toEqual({ entityType: 'bike', entityId: w.crescentId });
    expect(repair.customer.entityId).toBe(w.lisbethId);

    const timeline = await greta.invoke<{ type: string }[]>('shop/timeline', {
      entityType: 'workorder',
      entityId: repairId,
    });
    expect(timeline.map((e) => e.type)).toContain('workorder.created');
  });

  it('3. assign → start → report time and parts', async () => {
    await greta.invoke('workorder/assign', { orderId: repairId, technician: w.mans });
    await mans.invoke('workorder/start', { orderId: repairId });
    await mans.invoke('workorder/report-time', { orderId: repairId, hours: '0.25' });
    await mans.invoke('workorder/report-material', { orderId: repairId, article: 'tube-28', qty: '1' });
    await mans.invoke('workorder/report-material', {
      orderId: repairId,
      article: 'shop-supplies',
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

  it('4. every shut door is shut — pinned messages, each paired with an open one', async () => {
    // A mechanic cannot assign…
    await expect(
      mans.invoke('workorder/assign', { orderId: repairId, technician: w.mans }),
    ).rejects.toThrow(/permission denied/);
    // …but the neighbouring door IS open: the same mechanic can report time.
    await expect(
      mans.invoke('workorder/report-time', { orderId: repairId, hours: '0.1' }),
    ).resolves.toBeTruthy();

    // A portal customer cannot report time…
    const lisbeth = await host.getScope(w.lisbeth, w.t1, w.s1);
    await expect(
      lisbeth.invoke('workorder/report-time', { orderId: repairId, hours: '1' }),
    ).rejects.toThrow(/permission denied/);
    // …but she CAN see her own repair through the portal walk.
    const lisbethSees = await lisbeth.invoke<Page<WorkOrder>>('shop/portal-repairs');
    expect(lisbethSees.entries).toHaveLength(1);

    // The cross-tenant attacker: claiming t1's scope under his OWN tenant fails
    // the (tenant, scope) pair check…
    await expect(host.getScope(w.rutger, w.t2, w.s1)).rejects.toThrow(/unknown scope/);
    // …the control: his own (t2, s2) pair resolves.
    await expect(host.getScope(w.rutger, w.t2, w.s2)).resolves.toBeTruthy();
    // With the correct pair he can mint a stub but holds no tuples in t1 — every
    // privileged operation is denied by the owning scope's evaluation…
    const rutger = await host.getScope(w.rutger, w.t1, w.s1);
    await expect(rutger.invoke('workorder/list')).rejects.toThrow(/permission denied/);
    await expect(rutger.invoke('shop/list-customers')).rejects.toThrow(/permission denied/);
    await expect(rutger.invoke('invoicing/list')).rejects.toThrow(/permission denied/);
    // …the control: the per-entity portal walk resolves for him too, and returns
    // exactly nothing — an open door onto an empty room, not a denial.
    const rutgerSees = await rutger.invoke<Page<WorkOrder>>('shop/portal-repairs');
    expect(rutgerSees.entries).toEqual([]);
  });

  it('5. priced completion: the half-hour minimum bills, internal dropped, math exact', async () => {
    const result = await greta.invoke<{ billable: BillableLine[]; total: { amount: string } }>(
      'shop/complete-repair',
      { orderId: repairId },
    );

    // Expected totals are computed with the SAME money helpers the operation
    // uses — never hand-derived. 0.35h reported (0.25 + 0.1) < 0.5 min → the
    // minimum bills; shop-supplies is internal and dropped.
    const laborUnit = moneyOf('495', 'SEK');
    const expectedLabor = mulMoney('0.5', laborUnit); // 0.5 × 495
    const expectedTube = mulMoney('1', moneyOf('89', 'SEK'));
    const expectedTotal = addMoney(expectedLabor, expectedTube);

    expect(result.billable).toHaveLength(2);
    const labor = result.billable.find((b) => b.article === 'labor')!;
    expect(labor.qty).toBe('0.5');
    expect(labor.lineTotal.amount).toBe(expectedLabor.amount);
    const tube = result.billable.find((b) => b.article === 'tube-28')!;
    expect(tube.lineTotal.amount).toBe(expectedTube.amount);
    expect(result.total.amount).toBe(expectedTotal.amount);
    expect(expectedTotal.amount).toBe('336.5'); // and the human-checkable number

    // Completed is immutable: the engine refuses a further report.
    await expect(
      greta.invoke('workorder/report-time', { orderId: repairId, hours: '1' }),
    ).rejects.toThrow(/invalid transition/);
  });

  it('6. star topology: the invoicing engine consumed workorder.completed', async () => {
    const { entries: underlag } = await greta.invoke<
      Page<{ id: string; status: string; total: string }>
    >('invoicing/list');
    expect(underlag).toHaveLength(1);
    expect(underlag[0]!.status).toBe('open');
    expect(underlag[0]!.total).toBe('336.5');

    // Provenance is two-level: `document_*` is which delivery produced the line
    // (this work order), `source_*` is what the line itself is (time vs material).
    // Both come from the engine's own event payload — the vertical never joins
    // into invoicing's tables to find out.
    const detail = await greta.invoke<
      { lines: { document_id: string; document_type: string; source_type: string | null }[] }
    >('invoicing/get', { underlagId: underlag[0]!.id });
    expect(detail.lines).toHaveLength(2);
    expect(
      detail.lines.every((l) => l.document_type === 'workorder' && l.document_id === repairId),
    ).toBe(true);
    expect(detail.lines.map((l) => l.source_type).sort()).toEqual(['material', 'time']);
  });

  it('7. portal isolation: Lisbeth sees her repair, Otto sees nothing', async () => {
    const lisbeth = await host.getScope(w.lisbeth, w.t1, w.s1);
    const otto = await host.getScope(w.otto, w.t1, w.s1);

    const hers = await lisbeth.invoke<Page<WorkOrder>>('shop/portal-repairs');
    expect(hers.entries.map((o) => o.id)).toEqual([repairId]);
    const ottos = await otto.invoke<Page<WorkOrder>>('shop/portal-repairs');
    expect(ottos.entries).toEqual([]);

    // Lisbeth reads her repair's timeline via the same entity walk…
    await expect(
      lisbeth.invoke<{ type: string }[]>('shop/timeline', {
        entityType: 'workorder',
        entityId: repairId,
      }),
    ).resolves.toBeTruthy();
    // …but invoicing is not a portal concern: denied.
    await expect(lisbeth.invoke('invoicing/list')).rejects.toThrow(/permission denied/);
  });

  it('8. export makes the underlag immutable; the next completion opens a new one', async () => {
    const {
      entries: [underlag],
    } = await greta.invoke<Page<{ id: string }>>('invoicing/list');
    await greta.invoke('invoicing/export', { underlagId: underlag!.id });
    await expect(greta.invoke('invoicing/export', { underlagId: underlag!.id })).rejects.toThrow(
      /immutable/,
    );

    const repair2 = await greta.invoke<WorkOrder>('shop/create-repair', {
      bikeId: w.crescentId,
      kind: 'service',
      title: 'Annual service, new chain',
    });
    await greta.invoke('workorder/start', { orderId: repair2.id });
    await greta.invoke('workorder/report-time', { orderId: repair2.id, hours: '1' });
    await greta.invoke('workorder/report-material', {
      orderId: repair2.id,
      article: 'chain-9s',
      qty: '1',
    });
    await greta.invoke('shop/complete-repair', { orderId: repair2.id });

    const { entries: all } = await greta.invoke<Page<{ status: string; total: string }>>(
      'invoicing/list',
    );
    expect(all).toHaveLength(2);
    expect(all.filter((u) => u.status === 'open')).toHaveLength(1);
    expect(all.filter((u) => u.status === 'exported')).toHaveLength(1);
    // 1h ≥ 0.5 min → 1 × 495 + chain 249 = 744.
    const expectedTotal = addMoney(mulMoney('1', moneyOf('495', 'SEK')), mulMoney('1', moneyOf('249', 'SEK')));
    expect(all.find((u) => u.status === 'open')!.total).toBe(expectedTotal.amount);
    expect(expectedTotal.amount).toBe('744');
  });

  it('9. the engine state machine cannot be skipped', async () => {
    const repair = await greta.invoke<WorkOrder>('shop/create-repair', {
      bikeId: w.bianchiId,
      kind: 'service',
      title: 'Brake adjustment',
    });
    // planned → completed is not a legal step (needs in_progress)…
    await expect(greta.invoke('shop/complete-repair', { orderId: repair.id })).rejects.toThrow(
      /invalid transition/,
    );
    // …nor planned → closed (needs completed).
    await expect(greta.invoke('shop/close-repair', { orderId: repair.id })).rejects.toThrow(
      /invalid transition/,
    );

    // The control: walked one legal step at a time, the same doors open.
    await greta.invoke('workorder/start', { orderId: repair.id });
    await greta.invoke('workorder/report-time', { orderId: repair.id, hours: '0.5' });
    await greta.invoke('shop/complete-repair', { orderId: repair.id });
    const closed = await greta.invoke<WorkOrder>('shop/close-repair', { orderId: repair.id });
    expect(closed.status).toBe('closed');
    // And once closed, the machine refuses to close again.
    await expect(greta.invoke('shop/close-repair', { orderId: repair.id })).rejects.toThrow(
      /invalid transition/,
    );
  });

  // #953: the module hands the host `operationInputs`, so a malformed call is
  // refused at the scope door — none of these handlers parses anything itself.
  //
  // A principal with NO permission is what makes the assertion mean something:
  // the host parses BEFORE the permission check, so the refusal is about the
  // shape. Drop `operationInputs` and the same call comes back "permission
  // denied" — the handler was reached, and a permitted caller would have been
  // handed the unparsed value.
  it('10. the HOST parses an invocation, before the permission check', async () => {
    const rutger = await host.getScope(w.rutger, w.t1, w.s1);
    await expect(rutger.invoke('shop/create-customer', { number: 42, name: 'x' })).rejects.toThrow(
      /invalid|expected/i,
    );
    await expect(rutger.invoke('shop/create-customer', { name: 'x' })).rejects.toThrow(
      /invalid|required|expected/i,
    );
    // The control: a WELL-FORMED call from the same principal is refused for the
    // reason it should be, so the two refusals are telling us different things.
    await expect(
      rutger.invoke('shop/create-customer', { number: '9001', name: 'x' }),
    ).rejects.toThrow(/permission denied/);
  });
});
