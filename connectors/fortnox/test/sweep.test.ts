import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectionId,
  moduleManifest,
  permissionKey,
  platformActorId,
  scopeId,
  tenantId,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  webCryptoSecretBox,
  type ModuleRegistration,
  type OperationHandler,
} from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import {
  FortnoxMock,
  bindFortnoxScope,
  fortnoxConnectionActivity,
  listFortnoxBindings,
  sweepFortnoxLedger,
  syncFortnoxScope,
  unbindFortnoxScope,
  type FortnoxLedgerPage,
} from '../src/index.js';
import { SIE_FIXTURE } from './fixture.js';

/**
 * The whole inbound path, end to end: a connection is bound to a scope, a sweep mints a
 * token, downloads a year of SIE4 as latin1 bytes, parses and sums it, and lands the
 * result through the CONSUMER's own operation as the connection itself (#97).
 *
 * Runs against `FortnoxMock`. What is proven here is that the seam is wired correctly —
 * the client-credentials mint, the grant that admits the write, the paging, the
 * unchanged-hash skip, and the refusal to bind without authority. What a mock cannot
 * prove is that our reading of Fortnox's API is right; the mock IS our reading. That is
 * `test/live.test.ts`'s job, against a real company.
 */
describe('fortnox connector — inbound sync', () => {
  const LEDGER_RECORD = permissionKey.parse('ledger:record');
  const OPERATION = 'ledger/record-period';
  const REFUSING_OPERATION = 'ledger/refuse-period';

  let dir: string;
  let host: SqliteScopeHost;
  let fortnox: FortnoxMock;
  let staff = platformActorId.parse(ulid());
  let t = tenantId.parse(ulid());
  let s = scopeId.parse(ulid());
  let connId = connectionId.parse(ulid());
  /** Every page the landing operation received, in order — the assertion surface. */
  let landed: FortnoxLedgerPage[] = [];

  /**
   * A stand-in for the consuming vertical: it owns the landing operation and the
   * permission that gates it. Deliberately trivial — what is under test is the seam,
   * not what a real consumer would do with the rows (map to its own vocabulary, which
   * is exactly the work this connector refuses to do for it).
   */
  const ledgerModule: ModuleRegistration = {
    manifest: moduleManifest.parse({
      id: '@test/ledger',
      version: '1.0.0',
      kernelContract: '^0.0.1',
      permissions: [{ key: 'ledger:record', description: 'land external bookkeeping' }],
      events: { emits: [], consumes: [] },
      migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
      attachmentTargets: [],
      entitlementKey: 'ledger',
    }),
    operations: {
      [OPERATION]: (async (ctx, input: FortnoxLedgerPage) => {
        assertAllowed(await ctx.check(LEDGER_RECORD));
        landed.push(input);
        return { ok: true };
      }) as OperationHandler<never, unknown>,
      // A landing operation that refuses — a consumer whose own invariant rejects the
      // page. Gated on the same permission, so what fails is the landing, not the
      // authority: the connector must treat both the same way.
      [REFUSING_OPERATION]: (async (ctx) => {
        assertAllowed(await ctx.check(LEDGER_RECORD));
        throw new Error('ledger closed for the period');
      }) as OperationHandler<never, unknown>,
    },
  };

  const world = async (opts: { grant?: boolean } = {}) => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-fortnox-'));
    fortnox = new FortnoxMock();
    fortnox.setSie(2, SIE_FIXTURE);
    staff = platformActorId.parse(ulid());
    t = tenantId.parse(ulid());
    s = scopeId.parse(ulid());
    connId = connectionId.parse(ulid());
    landed = [];

    host = new SqliteScopeHost({
      dir,
      secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(7)),
      fetch: fortnox.fetch,
    });
    host.registerModule(ledgerModule);

    await host.admin.createTenant(staff, { id: t, slug: 'egeryds', name: 'Egeryds' });
    await host.admin.grantEntitlement(staff, t, 'ledger');
    await host.provisionScope(staff, {
      tenantId: t,
      scopeId: s,
      jurisdiction: 'eu',
      vertical: 'forecast',
    });
    await host.admin.activateScope(staff, t, s);

    await host.admin.createConnection(staff, {
      id: connId,
      tenantId: t,
      vertical: 'forecast',
      provider: 'fortnox',
      label: 'Egeryds Fortnox',
      secret: { clientId: 'client-id', clientSecret: 'client-secret', tenantId: '123456' },
    });
    if (opts.grant !== false) {
      await host.admin.grantToConnection(staff, {
        connectionId: connId,
        permission: LEDGER_RECORD,
        node: { tenantId: t, scopeId: s },
        grantedBy: staff,
      });
    }
  };

  const bind = (operation: string = OPERATION) =>
    bindFortnoxScope(host, {
      connectionId: connId,
      tenantId: t,
      scopeId: s,
      vertical: 'forecast',
      operation,
      permission: LEDGER_RECORD,
    });

  const options = () => ({
    fetch: fortnox.fetch,
    apiBase: fortnox.apiBase,
    oauthBase: fortnox.oauthBase,
    period: { from: '2026-01-01', to: '2026-12-31' },
  });

  beforeEach(async () => {
    await world();
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a binding whose grant is missing, naming the permission', async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
    await world({ grant: false });

    // The whole point of bind-time verification: without it this binding is written,
    // and the failure surfaces later in a background timer with a year of bookkeeping
    // already fetched.
    await expect(bind()).rejects.toThrow(/does not hold 'ledger:record'/);
    expect(await listFortnoxBindings(host, connId)).toEqual([]);
  });

  it('syncs a bound scope end to end, landing balances through the consumer operation', async () => {
    await bind();
    const result = await syncFortnoxScope(
      host,
      connId,
      (await listFortnoxBindings(host, connId))[0]!,
      options(),
    );

    expect(result.changed).toBe(true);
    expect(result.financialYearId).toBe(2);
    expect(result.pages).toBe(1);
    expect(landed).toHaveLength(1);

    const page = landed[0]!;
    expect(page.final).toBe(true);
    expect(page.financialYear).toEqual({ id: 2, from: '2026-01-01', to: '2026-12-31' });
    // The latin1 canary: decoded as UTF-8 this reads "Fastighets AB Ã„lvsjÃ¶", which is
    // not an error anywhere — just a permanently corrupted company name.
    expect(page.company.name).toBe('Fastighets AB Älvsjö');
    expect(page.costCentres).toContainEqual({ code: '2002', name: 'Kvarteret Önskan' });
    expect(page.balances.find((b) => b.account === '6570')?.amount).toEqual({
      amount: '95.00',
      currency: 'SEK',
    });
  });

  it('mints one token for a whole pass rather than one per request', async () => {
    await bind();
    await sweepFortnoxLedger(host, connId, options());
    // financialyears + sie = two authenticated reads on one token.
    expect(fortnox.mints).toHaveLength(1);
    expect(fortnox.calls).toEqual(['/3/financialyears', '/3/sie/4?financialyear=2']);
  });

  it('skips a second sweep when the books have not changed', async () => {
    await bind();
    const first = await sweepFortnoxLedger(host, connId, options());
    expect(first.synced).toHaveLength(1);
    expect(landed).toHaveLength(1);

    const second = await sweepFortnoxLedger(host, connId, options());
    expect(second.unchanged).toBe(1);
    expect(second.synced).toHaveLength(0);
    // Nothing landed the second time — a consumer's upsert is never even asked to be
    // idempotent for the common case.
    expect(landed).toHaveLength(1);
  });

  it('lands again once the books actually change', async () => {
    await bind();
    await sweepFortnoxLedger(host, connId, options());
    fortnox.setSie(2, `${SIE_FIXTURE}#VER D 1 20260801 "Ny"\r\n{\r\n#TRANS 6570 {} 10.00\r\n}\r\n`);

    const again = await sweepFortnoxLedger(host, connId, options());
    expect(again.synced).toHaveLength(1);
    expect(landed).toHaveLength(2);
    // The syncId is the content hash, so two different ledgers cannot collide and two
    // identical ones cannot double-count.
    expect(landed[1]!.syncId).not.toBe(landed[0]!.syncId);
  });

  it('pages a large ledger and marks only the last page final', async () => {
    // 1,200 single-row vouchers across two accounts → over two pages of 500.
    const rows: string[] = ['#FNAMN "Stort AB"', '#VALUTA SEK', '#RAR 0 20260101 20261231'];
    for (let i = 0; i < 1200; i += 1) {
      const account = 4000 + i;
      rows.push(`#KONTO ${account} "Konto ${account}"`);
      rows.push(`#VER A ${i} 20260315 "Rad ${i}"`, '{', `#TRANS ${account} {} 10.00`, '}');
    }
    fortnox.setSie(2, rows.join('\r\n'));

    await bind();
    const result = await sweepFortnoxLedger(host, connId, options());
    expect(result.synced[0]!.balances).toBe(1200);
    expect(landed).toHaveLength(3);
    expect(landed.map((p) => p.balances.length)).toEqual([500, 500, 200]);
    expect(landed.map((p) => p.final)).toEqual([false, false, true]);
    // The chart of accounts rides page 0 only — repeating it on every page is bytes
    // through a clone pipe for nothing.
    expect(landed[0]!.accounts).toHaveLength(1200);
    expect(landed[1]!.accounts).toEqual([]);
    // Every page carries the same syncId, so a consumer can swap a whole run atomically.
    expect(new Set(landed.map((p) => p.syncId)).size).toBe(1);
  });

  it('leaves the cursor untouched when a page fails to land, so the next sweep retries', async () => {
    // The fetch succeeds; the consumer's own operation refuses the page.
    await bind(REFUSING_OPERATION);

    const failed = await sweepFortnoxLedger(host, connId, options());
    expect(failed.failed).toHaveLength(1);
    expect(failed.failed[0]!.error).toMatch(/ledger closed for the period/);
    expect(landed).toHaveLength(0);

    // No cursor was written, so the retry after the fix syncs the whole year rather
    // than resuming into a half-written ledger — and crucially the NEXT sweep does not
    // mistake the unchanged content hash for "already done".
    const [binding] = await listFortnoxBindings(host, connId);
    expect(binding!.lastSync).toBeUndefined();

    const retry = await sweepFortnoxLedger(host, connId, options());
    expect(retry.unchanged).toBe(0);
    expect(retry.failed).toHaveLength(1);
  });

  it('steps past a failing scope rather than sinking the pass', async () => {
    await bind();
    // A second binding to a scope that does not exist — its sync throws.
    await host.admin.putConnectorState(connId, 'fortnox:binding:missing', {
      scopeId: scopeId.parse(ulid()),
      tenantId: t,
      vertical: 'forecast',
      operation: OPERATION,
      permission: LEDGER_RECORD,
      boundAt: new Date().toISOString(),
    });

    const result = await sweepFortnoxLedger(host, connId, options());
    expect(result.found).toBe(2);
    expect(result.failed).toHaveLength(1);
    // The healthy scope still synced — one vertical's problem must not stop another's.
    expect(result.synced).toHaveLength(1);
  });

  it('stops syncing an unbound scope', async () => {
    await bind();
    await unbindFortnoxScope(host, connId, s);
    const result = await sweepFortnoxLedger(host, connId, options());
    expect(result.found).toBe(0);
    expect(landed).toHaveLength(0);
  });

  it('reports nothing to sync when no financial year overlaps the period', async () => {
    await bind();
    const result = await sweepFortnoxLedger(host, connId, {
      ...options(),
      period: { from: '2019-01-01', to: '2019-12-31' },
    });
    expect(result.unchanged).toBe(1);
    expect(landed).toHaveLength(0);
  });

  it('projects the binding ledger as connection activity, never claiming to be live', async () => {
    await bind();
    await sweepFortnoxLedger(host, connId, options());

    const activity = await fortnoxConnectionActivity(host, connId);
    expect(activity.source).toBe('ledger');
    // The ledger knows what the platform synced, not what Fortnox has since booked.
    expect(activity.live).toBe(false);
    expect(activity.entries).toHaveLength(1);
    expect(activity.entries[0]!.status).toBe('synced');
    expect(activity.entries[0]!.facts).toContainEqual({
      label: 'Lands through',
      value: OPERATION,
    });
  });
});
