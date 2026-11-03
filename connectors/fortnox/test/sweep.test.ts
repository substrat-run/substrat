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
  type ConnectionId,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  webCryptoSecretBox,
  type ModuleRegistration,
  type OperationHandler,
  undeclaredOperations
} from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import {
  FortnoxMock,
  bindFortnoxScope,
  fortnoxConnectionActivity,
  listFortnoxBindings,
  pollFortnoxScope,
  sweepFortnoxLedger,
  syncFortnoxScope,
  syncFortnoxSupplierInvoices,
  unbindFortnoxScope,
  type FortnoxInvoiceFirstPass,
  type FortnoxInvoiceWriteback,
  type FortnoxInvoiceWritebackReceipt,
  type FortnoxLedgerPage,
  type FortnoxLedgerYears,
  type FortnoxSieFile,
  type FortnoxSupplierInvoicePage,
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
  const INVOICE_OPERATION = 'invoices/record';
  const FILED_OPERATION = 'invoices/record-filed';
  const WRITEBACK_READ = 'invoices/writeback';
  const WRITEBACK_RECORD = 'invoices/writeback-record';

  let dir: string;
  let host: SqliteScopeHost;
  let fortnox: FortnoxMock;
  let staff = platformActorId.parse(ulid());
  let t = tenantId.parse(ulid());
  let s = scopeId.parse(ulid());
  let connId = connectionId.parse(ulid());
  /** Every page the landing operation received, in order — the assertion surface. */
  let landed: FortnoxLedgerPage[] = [];
  let invoicesLanded: FortnoxSupplierInvoicePage[] = [];
  let filesLanded: FortnoxSieFile[] = [];
  /** The financial year the file landing refuses. */
  let refuseYear: number | null = null;
  /** The entity type the filed landing names; a test points it at one nothing declares. */
  let fileEntityType = 'invoice';
  /** What the write-back read answers, what asked it, and what came back. */
  let waiting: FortnoxInvoiceWriteback = { hold: [], decisions: [] };
  let writebackAsked: unknown[] = [];
  let receipts: FortnoxInvoiceWritebackReceipt[] = [];
  /** Receipts to refuse, counting down: a pass cut off after Fortnox was written. */
  let refuseReceipts = 0;

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
      attachmentTargets: [{ entityType: 'invoice', readPermission: 'ledger:record', writePermission: 'ledger:record' }],
      entitlementKey: 'ledger',
    }),
    ...undeclaredOperations('a test fixture, built to drive the host rather than declared', {
      [OPERATION]: (async (ctx, input: FortnoxLedgerPage) => {
        assertAllowed(await ctx.check(LEDGER_RECORD));
        landed.push(input);
        return { ok: true };
      }) as OperationHandler<never, unknown>,
      'ledger/record-file': (async (ctx, input: FortnoxSieFile) => {
        assertAllowed(await ctx.check(LEDGER_RECORD));
        if (input.financialYear.id === refuseYear) throw new Error(`year ${refuseYear} is closed`);
        filesLanded.push(input);
        return { ok: true };
      }) as OperationHandler<never, unknown>,
      [INVOICE_OPERATION]: (async (ctx, input: FortnoxSupplierInvoicePage) => {
        assertAllowed(await ctx.check(LEDGER_RECORD));
        invoicesLanded.push(input);
        return { ok: true };
      }) as OperationHandler<never, unknown>,
      [WRITEBACK_READ]: (async (ctx, input: unknown) => {
        assertAllowed(await ctx.check(LEDGER_RECORD));
        writebackAsked.push(input);
        return waiting;
      }) as OperationHandler<never, unknown>,
      [WRITEBACK_RECORD]: (async (ctx, input: FortnoxInvoiceWritebackReceipt) => {
        assertAllowed(await ctx.check(LEDGER_RECORD));
        if (refuseReceipts > 0) {
          refuseReceipts -= 1;
          throw new Error('the receipt did not land');
        }
        receipts.push(input);
        return { ok: true };
      }) as OperationHandler<never, unknown>,
      // A landing that wants every invoice's file, each on an entity named after the invoice.
      [FILED_OPERATION]: (async (ctx, input: FortnoxSupplierInvoicePage) => {
        assertAllowed(await ctx.check(LEDGER_RECORD));
        invoicesLanded.push(input);
        return {
          files: input.invoices.map((i) => ({
            givenNumber: i.givenNumber,
            entity: { entityType: fileEntityType, entityId: `inv-${i.givenNumber}` },
          })),
        };
      }) as OperationHandler<never, unknown>,
      // A landing operation that refuses — a consumer whose own invariant rejects the
      // page. Gated on the same permission, so what fails is the landing, not the
      // authority: the connector must treat both the same way.
      [REFUSING_OPERATION]: (async (ctx) => {
        assertAllowed(await ctx.check(LEDGER_RECORD));
        throw new Error('ledger closed for the period');
      }) as OperationHandler<never, unknown>,
    }),
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
    invoicesLanded = [];
    filesLanded = [];
    refuseYear = null;
    fileEntityType = 'invoice';
    waiting = { hold: [], decisions: [] };
    writebackAsked = [];
    receipts = [];
    refuseReceipts = 0;

    host = new SqliteScopeHost({
      dir,
      secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(7)),
      fetch: fortnox.fetch,
    });
    host.registerModule(ledgerModule);

    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.admin.grantEntitlement(staff, t, 'ledger');
    await host.provisionScope(staff, {
      tenantId: t,
      scopeId: s,
      jurisdiction: 'eu',
      vertical: 'forecast',
    });
    await host.admin.activateScope(staff, t, s);
    await host.provisionBlobStore(staff, { tenantId: t, vertical: 'forecast', binding: 'ATTACHMENTS' });

    await host.admin.createConnection(staff, {
      id: connId,
      tenantId: t,
      vertical: 'forecast',
      provider: 'fortnox',
      label: 'Acme Fortnox',
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

  const bindInvoices = (operation: string = INVOICE_OPERATION, scope: string = s, firstPass?: FortnoxInvoiceFirstPass) =>
    bindFortnoxScope(host, {
      connectionId: connId,
      tenantId: t,
      scopeId: scope,
      vertical: 'forecast',
      operation,
      permission: LEDGER_RECORD,
      kind: 'supplier-invoice',
      ...(firstPass === undefined ? {} : { firstPass }),
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
      amount: '95',
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

  it("polls only the named scope's binding on request, and answers what it did (#2672)", async () => {
    const other = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: other, jurisdiction: 'eu', vertical: 'forecast' });
    await host.admin.activateScope(staff, t, other);
    await host.admin.grantToConnection(staff, { connectionId: connId, permission: LEDGER_RECORD, node: { tenantId: t, scopeId: other }, grantedBy: staff });
    await bind();
    await bindInvoices(INVOICE_OPERATION, other);

    const first = await pollFortnoxScope(host, connId, s, options());
    const again = await pollFortnoxScope(host, connId, s, options());

    expect([first, again]).toEqual([{ outcome: 'landed', pending: false, errors: [] }, { outcome: 'unchanged', pending: false, errors: [] }]);
    expect([landed.length, invoicesLanded.length]).toEqual([1, 0]);
    expect(fortnox.calls.some((c) => c.includes('supplierinvoices'))).toBe(false);
  });

  it('refuses to turn an invoice binding into a ledger one', async () => {
    await bindInvoices();
    await expect(bind()).rejects.toThrow('one Fortnox landing kind per scope; use a separate scope for the other kind');
    expect((await listFortnoxBindings(host, connId))[0]).toMatchObject({ kind: 'supplier-invoice', operation: INVOICE_OPERATION });
  });

  describe('the whole SIE file', () => {
    const FILE_OPERATION = 'ledger/record-file';
    const NOW = Date.parse('2026-06-15T12:00:00.000Z');
    const sie = (year: number, text = 'Hyra') =>
      `#FORMAT PC8\r\n#FNAMN "Testbolaget AB"\r\n#ORGNR 556677-8899\r\n#RAR 0 ${year}0101 ${year}1231\r\n#KONTO 3010 "${text} Ö"\r\n`;
    const YEARS = [
      { Id: 4, FromDate: '2023-01-01', ToDate: '2023-12-31' },
      { Id: 5, FromDate: '2024-01-01', ToDate: '2024-12-31' },
      { Id: 6, FromDate: '2025-01-01', ToDate: '2025-12-31' },
      { Id: 7, FromDate: '2026-01-01', ToDate: '2026-12-31' },
    ];
    const company = () => {
      fortnox = new FortnoxMock({ financialYears: YEARS });
      for (const y of YEARS) fortnox.setSie(y.Id, sie(Number(y.FromDate.slice(0, 4))));
    };
    const bindFile = (years?: FortnoxLedgerYears) =>
      bindFortnoxScope(host, {
        connectionId: connId, tenantId: t, scopeId: s, vertical: 'forecast', operation: FILE_OPERATION, permission: LEDGER_RECORD,
        form: 'sie', ...(years === undefined ? {} : { years }),
      });
    const at = (ms: number) => ({ ...options(), fetch: fortnox.fetch, period: undefined, now: () => ms });
    const fileYears = () => filesLanded.map((f) => f.financialYear.id);
    const DAY = 24 * 3_600_000;
    const PASS = 15 * 60_000;

    beforeEach(company);

    it('lands the current year\'s file, decoded, in one call, and refuses nothing a summary would', async () => {
      await bindFile();

      const result = await sweepFortnoxLedger(host, connId, at(NOW));

      expect(result.synced).toEqual([expect.objectContaining({ scopeId: s, changed: true, financialYearId: 7, pages: 1 })]);
      expect(filesLanded).toEqual([{
        syncId: expect.stringMatching(/^[0-9a-f]{64}$/),
        connectionId: connId,
        company: { name: 'Testbolaget AB', organizationNumber: '556677-8899' },
        financialYear: { id: 7, from: '2026-01-01', to: '2026-12-31' },
        sie: sie(2026),
      }]);
      expect(landed).toEqual([]);
      expect(fortnox.calls).toEqual(['/3/financialyears', '/3/sie/4?financialyear=7']);
    });

    it('lands nothing when the file has not changed, and again when it has', async () => {
      await bindFile();
      await sweepFortnoxLedger(host, connId, at(NOW));

      const idle = await sweepFortnoxLedger(host, connId, at(NOW + PASS));
      expect(idle.unchanged).toBe(1);
      expect(filesLanded).toHaveLength(1);

      fortnox.setSie(7, sie(2026, 'Hyror'));
      await sweepFortnoxLedger(host, connId, at(NOW + 2 * PASS));
      expect(filesLanded).toHaveLength(2);
      expect(filesLanded[1]!.syncId).not.toBe(filesLanded[0]!.syncId);
    });

    it('brings older years in newest first, one a pass, and goes no further back than it keeps', async () => {
      await bindFile(2);

      await sweepFortnoxLedger(host, connId, at(NOW));
      expect(fileYears()).toEqual([7, 6]);

      for (let n = 1; n < 4; n += 1) await sweepFortnoxLedger(host, connId, at(NOW + n * PASS));
      expect(fileYears()).toEqual([7, 6, 5]);
    });

    it('keeps every year with `all`', async () => {
      await bindFile('all');

      for (let n = 0; n < 4; n += 1) await sweepFortnoxLedger(host, connId, at(NOW + n * PASS));

      expect(fileYears()).toEqual([7, 6, 5, 4]);
    });

    it('reads an older year again after a day, longest ago first, and lands it only if it moved', async () => {
      await bindFile(2);
      for (let n = 0; n < 3; n += 1) await sweepFortnoxLedger(host, connId, at(NOW + n * PASS));
      fortnox.calls.length = 0;
      fortnox.setSie(5, sie(2024, 'Omföring'));

      await sweepFortnoxLedger(host, connId, at(NOW + 3 * PASS));
      expect(fortnox.calls.filter((c) => c.includes('/sie/'))).toEqual(['/3/sie/4?financialyear=7']);

      await sweepFortnoxLedger(host, connId, at(NOW + DAY + PASS));
      await sweepFortnoxLedger(host, connId, at(NOW + DAY + 2 * PASS));
      expect(fortnox.calls.filter((c) => c.includes('financialyear=6') || c.includes('financialyear=5'))).toEqual([
        '/3/sie/4?financialyear=6',
        '/3/sie/4?financialyear=5',
      ]);
      expect(fileYears()).toEqual([7, 6, 5, 5]);
    });

    it('offers a refused year again, and lets the other year land', async () => {
      await bindFile(1);
      refuseYear = 7;

      const first = await sweepFortnoxLedger(host, connId, at(NOW));

      expect(first.failed).toEqual([{ scopeId: s, error: expect.stringMatching(/^financial year 7: .*year 7 is closed/) }]);
      expect(first.synced).toEqual([expect.objectContaining({ financialYearId: 6, changed: true })]);
      expect(fileYears()).toEqual([6]);
      expect(Object.keys((await listFortnoxBindings(host, connId))[0]!.yearSync!)).toEqual(['6']);

      refuseYear = null;
      const second = await sweepFortnoxLedger(host, connId, at(NOW + PASS));

      expect(second.failed).toEqual([]);
      expect(fileYears()).toEqual([6, 7]);
    });

    it('puts a refused older year back in the queue, so the years behind it still land', async () => {
      await bindFile(2);
      refuseYear = 6;

      await sweepFortnoxLedger(host, connId, at(NOW));
      await sweepFortnoxLedger(host, connId, at(NOW + PASS));
      expect(fileYears()).toEqual([7, 5]);

      refuseYear = null;
      await sweepFortnoxLedger(host, connId, at(NOW + DAY));

      expect(fileYears()).toEqual([7, 5, 6]);
      expect((await listFortnoxBindings(host, connId))[0]!.yearFailedAt).toBeUndefined();
    });

    it('leaves a binding unbound during a pass unbound', async () => {
      await bindFile(1);
      // Staff unbinds while the pass downloads the older year, after the current one was written.
      const fetch: typeof fortnox.fetch = async (input, init) => {
        if (String(input).includes('financialyear=6')) await unbindFortnoxScope(host, connId, s);
        return fortnox.fetch(input, init);
      };

      await sweepFortnoxLedger(host, connId, { ...at(NOW), fetch });

      expect(await listFortnoxBindings(host, connId)).toEqual([]);
    });

    it('refuses `years` on a summary, and `form` on an invoice binding', async () => {
      const bindWith = (over: Partial<Parameters<typeof bindFortnoxScope>[1]>) => bindFortnoxScope(host, {
        connectionId: connId, tenantId: t, scopeId: s, vertical: 'forecast', operation: OPERATION, permission: LEDGER_RECORD, ...over,
      });

      await expect(bindWith({ years: 2 })).rejects.toThrow("years applies to a binding with form 'sie'");
      await expect(bindWith({ form: 'summary', years: 2 })).rejects.toThrow("years applies to a binding with form 'sie'");
      await expect(bindWith({ kind: 'supplier-invoice', form: 'sie' })).rejects.toThrow("form applies to a ledger binding, not to 'supplier-invoice'");
      await expect(bindWith({ form: 'sie', years: -1 })).rejects.toThrow("years is 'all' or a whole number of years");
      expect(await listFortnoxBindings(host, connId)).toEqual([]);
    });

    it('keeps what landed through a re-bind that changes nothing, and starts over when one does', async () => {
      await bindFile();
      await sweepFortnoxLedger(host, connId, at(NOW));

      await bindFile();
      expect(Object.keys((await listFortnoxBindings(host, connId))[0]!.yearSync!)).toEqual(['7']);

      await bindFile('all');

      expect((await listFortnoxBindings(host, connId))[0]).toMatchObject({ form: 'sie', years: 'all' });
      expect((await listFortnoxBindings(host, connId))[0]!.yearSync).toBeUndefined();
    });
  });

  describe('supplier invoices (#2422)', () => {
    const NOW = Date.parse('2026-06-15T12:00:00.000Z');
    const invoice = (givenNumber: string, modified: string, extra: Record<string, unknown> = {}) =>
      fortnox.setSupplierInvoice({
        modified,
        invoice: {
          GivenNumber: givenNumber, SupplierNumber: '7', SupplierName: 'Hiss & Lås AB', InvoiceNumber: `F-${givenNumber}`,
          InvoiceDate: '2026-06-01', DueDate: '2026-07-01', Currency: 'SEK', Total: 1250, Balance: '250.00', VAT: 250,
          OCR: '7001', Booked: true, Cancelled: false, Credit: false, PaymentPending: true,
          Comments: 'Hiss', CommentLog: [{ Comment: 'Granskad', CreatedAt: '2026-06-02 08:15', UserName: 'Ekonom', Id: '9' }],
          VoucherSeries: 'D', VoucherNumber: 44, VoucherYear: 3, Project: 'P1', CostCenter: '2001',
          SupplierInvoiceRows: [
            { Account: 4160, AccountDescription: 'Reparationer', CostCenter: '2001', Project: 'P1', TransactionInformation: 'Hiss', Debit: 1000, Credit: 0 },
            { Account: 2641, CostCenter: null, Debit: 250, Credit: 0 },
            { Account: 2440, CostCenter: '', Debit: 0, Credit: 1250.5 },
          ],
          ...extra,
        },
      });
    const filed = (givenNumber: string, ...names: string[]) =>
      fortnox.setSupplierInvoice({
        modified: '2026-06-10 09:00',
        invoice: { GivenNumber: givenNumber, Total: 100, Booked: false, Cancelled: false },
        files: names.map((Name) => ({ FileId: `${givenNumber}-${Name}`, Name, bytes: new TextEncoder().encode(`bytes of ${Name}`) })),
      });
    const onInvoice = async (givenNumber: string) =>
      (await host.getConnectorAttachments(connId, s)).list({ entityType: 'invoice', entityId: `inv-${givenNumber}` });
    const at = (ms: number) => ({ ...options(), now: () => ms });
    const binding = async () => (await listFortnoxBindings(host, connId)).find((b) => b.kind === 'supplier-invoice')!;

    it('lands changed invoices with their rows, then reads nothing new on an idle pass', async () => {
      await bindInvoices();
      invoice('12', '2026-06-10 09:00');

      const first = await sweepFortnoxLedger(host, connId, at(NOW));

      expect(first.invoices).toEqual([{ scopeId: s, landed: 1, files: 0, held: 0, written: 0, pending: false }]);
      // A landing that names no file is read no file, and a binding that declares no write-back writes nothing.
      expect(fortnox.calls.filter((c) => c.includes('fileconnections') || c.includes('/archive/'))).toEqual([]);
      expect(fortnox.writes).toEqual([]);
      // 90 days back, less the overlap, in Swedish local time: winter time (UTC+1) in March.
      expect(fortnox.calls[0]).toBe('/3/supplierinvoices?lastmodified=2026-03-17%2012%3A55&limit=500&page=1');
      expect(invoicesLanded).toHaveLength(1);
      expect(invoicesLanded[0]).toEqual({
        connectionId: connId,
        company: { name: 'Testbolaget AB', organizationNumber: '556677-8899' },
        invoices: [{
          givenNumber: '12', supplierNumber: '7', supplierName: 'Hiss & Lås AB', invoiceNumber: 'F-12',
          invoiceDate: '2026-06-01', dueDate: '2026-07-01', total: { amount: '1250', currency: 'SEK' },
          balance: { amount: '250.00', currency: 'SEK' }, vat: { amount: '250', currency: 'SEK' }, ocr: '7001',
          booked: true, cancelled: false, credit: false, paymentPending: true,
          comments: 'Hiss', commentLog: [{ comment: 'Granskad', createdAt: '2026-06-02 08:15', userName: 'Ekonom' }],
          voucher: { series: 'D', number: 44, year: 3 }, project: 'P1', costCentre: '2001',
          rows: [
            { account: '4160', accountDescription: 'Reparationer', costCentre: '2001', project: 'P1', transactionInformation: 'Hiss', amount: { amount: '1000', currency: 'SEK' } },
            { account: '2641', accountDescription: null, costCentre: null, project: null, transactionInformation: null, amount: { amount: '250', currency: 'SEK' } },
            { account: '2440', accountDescription: null, costCentre: null, project: null, transactionInformation: null, amount: { amount: '-1250.5', currency: 'SEK' } },
          ],
        }],
      });
      expect((await binding()).invoiceSync).toEqual({ since: new Date(NOW).toISOString(), syncedAt: new Date(NOW).toISOString(), landed: 1 });

      fortnox.calls.length = 0;
      const idle = await sweepFortnoxLedger(host, connId, at(NOW + 15 * 60_000));
      expect(idle.unchanged).toBe(1);
      // Summer time (UTC+2): the cursor, less the overlap.
      expect(fortnox.calls).toEqual(['/3/supplierinvoices?lastmodified=2026-06-15%2013%3A55&limit=500&page=1']);
      expect(invoicesLanded).toHaveLength(1);
    });

    it('says nothing about what Fortnox leaves unset, rather than guessing a zero', async () => {
      await bindInvoices();
      invoice('12', '2026-06-10 09:00', {
        Balance: null, VAT: null, OCR: null, Comments: null, CommentLog: null, Credit: null, PaymentPending: null,
        VoucherSeries: null, VoucherNumber: 0, VoucherYear: null, Project: '', CostCenter: '',
      });

      await sweepFortnoxLedger(host, connId, at(NOW));

      const landedInvoice = invoicesLanded[0]!.invoices[0]!;
      expect(landedInvoice).not.toHaveProperty('balance');
      expect(landedInvoice).not.toHaveProperty('vat');
      expect(landedInvoice).toMatchObject({
        ocr: null, comments: null, commentLog: [], credit: false, paymentPending: false, voucher: null, project: null, costCentre: null,
      });
    });

    it('reads every invoice on a first pass that asks for it, with no filter until the run drains', async () => {
      await bindInvoices(INVOICE_OPERATION, s, 'all');
      invoice('1', '2019-02-01 09:00');
      invoice('2', '2021-03-01 09:00');
      const run = async (ms: number) => syncFortnoxSupplierInvoices(host, connId, await binding(), { ...at(ms), budget: { details: 1 } });

      await run(NOW);
      await run(NOW + 15 * 60_000);
      await run(NOW + 30 * 60_000);

      expect(invoicesLanded.map((p) => p.invoices.map((i) => i.givenNumber))).toEqual([['1'], ['2']]);
      const lists = fortnox.calls.filter((c) => c.startsWith('/3/supplierinvoices?'));
      expect(lists).toEqual([
        '/3/supplierinvoices?limit=500&page=1',
        '/3/supplierinvoices?limit=500&page=1',
        // Drained: from when the run began, less the overlap, in summer time.
        '/3/supplierinvoices?lastmodified=2026-06-15%2013%3A55&limit=500&page=1',
      ]);
    });

    it('reads a declared number of days on the first pass', async () => {
      await bindInvoices(INVOICE_OPERATION, s, 30);
      invoice('1', '2026-06-10 09:00');

      await sweepFortnoxLedger(host, connId, at(NOW));

      expect(fortnox.calls[0]).toBe('/3/supplierinvoices?lastmodified=2026-05-16%2013%3A55&limit=500&page=1');
    });

    it('starts over when a re-bind names another first pass', async () => {
      await bindInvoices();
      invoice('1', '2026-06-10 09:00');
      await sweepFortnoxLedger(host, connId, at(NOW));
      expect((await binding()).invoiceSync).toBeDefined();

      await bindInvoices(INVOICE_OPERATION, s, 'all');

      expect(await binding()).toMatchObject({ firstPass: 'all' });
      expect((await binding()).invoiceSync).toBeUndefined();
    });

    it('keeps the cursor when a re-bind only turns writeback on', async () => {
      await bindInvoices();
      invoice('1', '2026-06-10 09:00');
      await sweepFortnoxLedger(host, connId, at(NOW));
      const cursor = (await binding()).invoiceSync;

      await bindFortnoxScope(host, {
        connectionId: connId, tenantId: t, scopeId: s, vertical: 'forecast', operation: INVOICE_OPERATION, permission: LEDGER_RECORD,
        kind: 'supplier-invoice', writeback: { read: WRITEBACK_READ, record: WRITEBACK_RECORD },
      });

      expect((await binding()).invoiceSync).toEqual(cursor);
    });

    it('refuses a first pass on a ledger binding', async () => {
      await expect(bindFortnoxScope(host, {
        connectionId: connId, tenantId: t, scopeId: s, vertical: 'forecast', operation: OPERATION, permission: LEDGER_RECORD, firstPass: 'all',
      })).rejects.toThrow("firstPass and writeback apply to a supplier-invoice binding, not to 'ledger'");
      await expect(bindFortnoxScope(host, {
        connectionId: connId, tenantId: t, scopeId: s, vertical: 'forecast', operation: OPERATION, permission: LEDGER_RECORD,
        writeback: { read: WRITEBACK_READ, record: WRITEBACK_RECORD },
      })).rejects.toThrow("firstPass and writeback apply to a supplier-invoice binding, not to 'ledger'");
      expect(await listFortnoxBindings(host, connId)).toEqual([]);
    });

    it('lands every file the landing asks for on the entity it names, once', async () => {
      await bindInvoices(FILED_OPERATION);
      filed('12', 'faktura.pdf', 'bilaga.png');

      const first = await sweepFortnoxLedger(host, connId, at(NOW));

      expect(first.failed).toEqual([]);
      expect(first.invoices).toEqual([{ scopeId: s, landed: 1, files: 2, held: 0, written: 0, pending: false }]);
      expect((await onInvoice('12')).map((f) => [f.filename, f.contentType]).sort()).toEqual([
        ['bilaga.png', 'image/png'],
        ['faktura.pdf', 'application/pdf'],
      ]);
      expect((await binding()).files).toBeUndefined();

      fortnox.calls.length = 0;
      await sweepFortnoxLedger(host, connId, at(NOW + 15 * 60_000));
      expect(fortnox.calls.filter((c) => c.includes('fileconnections') || c.includes('/archive/'))).toEqual([]);
    });

    it('takes the type Fortnox states over the one the name suggests', async () => {
      await bindInvoices(FILED_OPERATION);
      fortnox.setSupplierInvoice({
        modified: '2026-06-10 09:00',
        invoice: { GivenNumber: '12', Total: 100, Booked: false, Cancelled: false },
        files: [{ FileId: 'a', Name: 'skanning', contentType: 'image/tiff', bytes: new Uint8Array([1]) }],
      });

      await sweepFortnoxLedger(host, connId, at(NOW));

      expect((await onInvoice('12')).map((f) => f.contentType)).toEqual(['image/tiff']);
    });

    it('takes the type the name suggests when Fortnox states only bytes', async () => {
      await bindInvoices(FILED_OPERATION);
      fortnox.setSupplierInvoice({
        modified: '2026-06-10 09:00',
        invoice: { GivenNumber: '12', Total: 100, Booked: false, Cancelled: false },
        files: [{ FileId: 'a', Name: 'faktura.PDF', contentType: 'application/octet-stream', bytes: new Uint8Array([1]) }],
      });

      await sweepFortnoxLedger(host, connId, at(NOW));

      expect((await onInvoice('12')).map((f) => f.contentType)).toEqual(['application/pdf']);
    });

    it('keeps a file it could not read and lands it later, without landing the invoice again', async () => {
      await bindInvoices(FILED_OPERATION);
      filed('12', 'faktura.pdf');
      fortnox.rateLimitOn = '/archive/';
      fortnox.rateLimitNext = 4;

      const first = await sweepFortnoxLedger(host, connId, { ...at(NOW), sleep: async () => undefined });

      expect(first.failed).toEqual([{ scopeId: s, error: expect.stringContaining('file of supplier invoice 12:') }]);
      expect(invoicesLanded).toHaveLength(1);
      expect((await binding()).files).toEqual([{ givenNumber: '12', entity: { entityType: 'invoice', entityId: 'inv-12' }, attempts: 1 }]);

      const second = await sweepFortnoxLedger(host, connId, at(NOW + 15 * 60_000));

      expect(second.failed).toEqual([]);
      expect(second.invoices).toEqual([{ scopeId: s, landed: 0, files: 1, held: 0, written: 0, pending: false }]);
      expect(invoicesLanded).toHaveLength(1);
      expect(await onInvoice('12')).toHaveLength(1);
      expect((await binding()).files).toBeUndefined();
    });

    it('does not land a file twice when the one after it failed', async () => {
      await bindInvoices(FILED_OPERATION);
      filed('12', 'a.pdf', 'b.pdf');
      fortnox.rateLimitOn = 'b.pdf';
      fortnox.rateLimitNext = 4;

      await sweepFortnoxLedger(host, connId, { ...at(NOW), sleep: async () => undefined });
      expect(await host.admin.getConnectorState(connId, `fortnox:files-landed:${s}:12`)).toEqual({ entity: { entityType: 'invoice', entityId: 'inv-12' }, fileIds: ['12-a.pdf'] });

      await sweepFortnoxLedger(host, connId, at(NOW + 15 * 60_000));
      expect((await onInvoice('12')).map((f) => f.filename).sort()).toEqual(['a.pdf', 'b.pdf']);
    });

    it('lands a file once, however often its invoice is asked about again', async () => {
      await bindInvoices(FILED_OPERATION);
      filed('12', 'a.pdf');
      await sweepFortnoxLedger(host, connId, at(NOW));

      // The invoice is paid: it changes, lands again, and the landing asks for its file again.
      fortnox.setSupplierInvoice({
        modified: '2026-06-15 14:10',
        invoice: { GivenNumber: '12', Total: 100, Booked: false, Cancelled: false },
        files: [{ FileId: '12-a.pdf', Name: 'a.pdf', bytes: new TextEncoder().encode('bytes of a.pdf') }],
      });
      fortnox.calls.length = 0;
      const second = await sweepFortnoxLedger(host, connId, at(NOW + 15 * 60_000));

      expect(second.invoices).toEqual([{ scopeId: s, landed: 1, files: 0, held: 0, written: 0, pending: false }]);
      expect(fortnox.calls.filter((c) => c.includes('/archive/'))).toEqual([]);
      expect(await onInvoice('12')).toHaveLength(1);
    });

    it('lands a file again when the landing names another entity for its invoice', async () => {
      await bindInvoices(FILED_OPERATION);
      filed('12', 'a.pdf');
      await host.admin.putConnectorState(connId, `fortnox:files-landed:${s}:12`, { entity: { entityType: 'invoice', entityId: 'inv-old' }, fileIds: ['12-a.pdf'] });

      await sweepFortnoxLedger(host, connId, at(NOW));

      expect(await onInvoice('12')).toHaveLength(1);
    });

    it('keeps the files asked for across a re-bind', async () => {
      await bindInvoices(FILED_OPERATION);
      filed('12', 'a.pdf');
      fortnox.rateLimitOn = '/archive/';
      fortnox.rateLimitNext = 4;
      await sweepFortnoxLedger(host, connId, { ...at(NOW), sleep: async () => undefined });

      await bindInvoices(FILED_OPERATION, s, 30);

      expect((await binding()).invoiceSync).toBeUndefined();
      expect((await binding()).files).toEqual([{ givenNumber: '12', entity: { entityType: 'invoice', entityId: 'inv-12' }, attempts: 1 }]);
    });

    it('stops between an invoice\'s files when the budget runs out, and reads the rest next pass', async () => {
      await bindInvoices(FILED_OPERATION);
      filed('1', 'a.pdf', 'b.pdf', 'c.pdf');
      const run = async (ms: number, budget: { details: number }) =>
        syncFortnoxSupplierInvoices(host, connId, await binding(), { ...at(ms), budget });
      await run(NOW, { details: 1 });

      const budget = { details: 3 };
      expect(await run(NOW + 15 * 60_000, budget)).toEqual({ scopeId: s, landed: 0, files: 2, held: 0, written: 0, pending: true });
      expect(budget.details).toBe(0);
      expect((await binding()).files?.map((f) => f.givenNumber)).toEqual(['1']);

      expect(await run(NOW + 30 * 60_000, { details: 3 })).toEqual({ scopeId: s, landed: 0, files: 1, held: 0, written: 0, pending: false });
      expect((await onInvoice('1')).map((f) => f.filename).sort()).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    });

    it('reports a pass whose only effect was a file it stepped over', async () => {
      await bindInvoices(FILED_OPERATION);
      await host.admin.putConnectorState(connId, `fortnox:binding:${s}`, {
        ...(await binding()),
        invoiceSync: { since: new Date(NOW).toISOString(), syncedAt: new Date(NOW).toISOString(), landed: 1 },
        files: [{ givenNumber: '12', entity: { entityType: 'invoice', entityId: 'inv-12' } }],
      });
      filed('12', 'a.pdf');
      const fetch: typeof fortnox.fetch = (input, init) => fortnox.fetch(String(input).replace('/archive/12-a.pdf', '/archive/gone'), init);

      const result = await sweepFortnoxLedger(host, connId, { ...at(NOW + 15 * 60_000), fetch });

      expect(result.unchanged).toBe(0);
      expect(result.invoices).toEqual([{
        scopeId: s, landed: 0, files: 0, held: 0, written: 0, pending: false,
        skipped: [{ givenNumber: '12', reason: 'a.pdf is gone from the archive' }],
      }]);
    });

    it('fails by the invoice when the file cannot land, and tries the next one', async () => {
      await bindInvoices(FILED_OPERATION);
      fileEntityType = 'not-a-target';
      filed('1', 'a.pdf');
      filed('2', 'b.pdf');

      const result = await sweepFortnoxLedger(host, connId, at(NOW));

      expect(result.failed).toEqual([{ scopeId: s, error: expect.stringContaining('file of supplier invoice 1:') }]);
      expect(fortnox.calls.filter((c) => c.includes('/archive/'))).toEqual(['/3/archive/1-a.pdf', '/3/archive/2-b.pdf']);
      expect((await binding()).files?.map((f) => f.givenNumber)).toEqual(['1', '2']);
    });

    it.each([
      ['does not read a failed file again when the landing asks for it again', 'inv-1', 1],
      ['reads a failed file again when the landing names another entity for it', 'inv-old', 2],
    ])('%s', async (_, heldEntityId, reads) => {
      await bindInvoices(FILED_OPERATION);
      fileEntityType = 'not-a-target';
      await host.admin.putConnectorState(connId, `fortnox:binding:${s}`, {
        ...(await binding()),
        files: [{ givenNumber: '1', entity: { entityType: 'not-a-target', entityId: heldEntityId } }],
      });
      filed('1', 'a.pdf');

      const result = await sweepFortnoxLedger(host, connId, at(NOW));

      expect(result.failed).toEqual([{ scopeId: s, error: expect.stringContaining('file of supplier invoice 1:') }]);
      expect(fortnox.calls.filter((c) => c.includes('/archive/'))).toHaveLength(reads);
    });

    it('says the consent is short when Fortnox refuses a file, reads no more of them, and keeps landing invoices', async () => {
      await bindInvoices(FILED_OPERATION);
      filed('1', 'a.pdf');
      filed('2', 'b.pdf');
      fortnox.deniedScopes = ['archive'];

      const first = await sweepFortnoxLedger(host, connId, at(NOW));

      expect(first.failed).toEqual([{ scopeId: s, error: expect.stringMatching(/consent must cover the connectfile and archive scopes/) }]);
      expect(fortnox.calls.filter((c) => c.includes('/archive/'))).toHaveLength(1);
      expect(invoicesLanded.map((p) => p.invoices.map((i) => i.givenNumber))).toEqual([['1', '2']]);
      expect((await binding()).files?.map((f) => f.givenNumber)).toEqual(['1', '2']);

      // A pass that also lands asks once, not once for the queue and again after the landing.
      fortnox.setSupplierInvoice({ modified: '2026-06-15 14:05', invoice: { GivenNumber: '3', Total: 100, Booked: false, Cancelled: false } });
      fortnox.calls.length = 0;
      await sweepFortnoxLedger(host, connId, at(NOW + 15 * 60_000));
      expect(invoicesLanded.at(-1)!.invoices.map((i) => i.givenNumber)).toEqual(['3']);
      expect(fortnox.calls.filter((c) => c.includes('/archive/'))).toHaveLength(1);

      fortnox.deniedScopes = [];
      const third = await sweepFortnoxLedger(host, connId, at(NOW + 30 * 60_000));
      expect(third.failed).toEqual([]);
      expect(third.invoices).toEqual([{ scopeId: s, landed: 0, files: 2, held: 0, written: 0, pending: false }]);
    });

    it('keeps what it read from the queue when the landing after it refuses', async () => {
      await bindInvoices(REFUSING_OPERATION);
      filed('1', 'a.pdf');
      await host.admin.putConnectorState(connId, `fortnox:binding:${s}`, {
        ...(await binding()),
        invoiceSync: { since: new Date(NOW).toISOString(), syncedAt: new Date(NOW).toISOString(), landed: 1 },
        files: [{ givenNumber: '1', entity: { entityType: 'invoice', entityId: 'inv-1' } }],
      });
      fortnox.setSupplierInvoice({ modified: '2026-06-15 14:20', invoice: { GivenNumber: '2', Total: 100, Booked: false, Cancelled: false } });

      const result = await sweepFortnoxLedger(host, connId, at(NOW + 15 * 60_000));

      expect(result.failed).toEqual([{ scopeId: s, error: expect.stringMatching(/ledger closed for the period/) }]);
      expect(await onInvoice('1')).toHaveLength(1);
      expect((await binding()).files).toBeUndefined();
    });

    it('reads queued files before more invoices, so the queue stays within one pass', async () => {
      await bindInvoices(FILED_OPERATION);
      for (const n of ['1', '2', '3']) filed(n, 'a.pdf');
      const run = async (ms: number, details: number) => syncFortnoxSupplierInvoices(host, connId, await binding(), { ...at(ms), budget: { details } });

      await run(NOW, 3);
      expect((await binding()).files).toHaveLength(3);

      fortnox.calls.length = 0;
      expect(await run(NOW + 15 * 60_000, 4)).toEqual({ scopeId: s, landed: 0, files: 2, held: 0, written: 0, pending: true });
      expect(fortnox.calls.filter((c) => c.startsWith('/3/supplierinvoices?'))).toEqual([]);
      expect((await binding()).files?.map((f) => f.givenNumber)).toEqual(['3']);
    });

    it('steps over a file that fails eight passes, so it cannot hold the budget', async () => {
      await bindInvoices(FILED_OPERATION);
      filed('12', 'faktura.pdf');
      const fetch: typeof fortnox.fetch = (input, init) => (String(input).includes('/archive/')
        ? Promise.resolve({ ok: false, status: 500, text: async () => 'broken', headers: { get: () => null } } as unknown as Awaited<ReturnType<typeof fortnox.fetch>>)
        : fortnox.fetch(input, init));
      const pass = (n: number) => sweepFortnoxLedger(host, connId, { ...at(NOW + n * 15 * 60_000), fetch });

      for (let n = 0; n < 7; n += 1) await pass(n);
      expect((await binding()).files).toHaveLength(1);

      const last = await pass(7);
      expect(last.invoices).toEqual([expect.objectContaining({ skipped: [{ givenNumber: '12', reason: expect.stringContaining('failed 8 passes') }] })]);
      expect((await binding()).files).toBeUndefined();
    });

    it('steps over a file gone from the archive or too large to hold, saying which', async () => {
      await bindInvoices(FILED_OPERATION);
      fortnox.setSupplierInvoice({
        modified: '2026-06-10 09:00',
        invoice: { GivenNumber: '12', Total: 100, Booked: false, Cancelled: false },
        files: [
          { FileId: 'big', Name: 'stor.pdf', bytes: new Uint8Array(16 * 1024 * 1024 + 1) },
          { FileId: 'ok', Name: 'liten.pdf', bytes: new Uint8Array([1]) },
        ],
      });
      const fetch: typeof fortnox.fetch = (input, init) => (String(input).endsWith('/archive/ok')
        ? fortnox.fetch(String(input).replace('/archive/ok', '/archive/gone'), init)
        : fortnox.fetch(input, init));

      const result = await sweepFortnoxLedger(host, connId, { ...at(NOW), fetch });

      expect(result.failed).toEqual([]);
      expect(result.invoices).toEqual([{
        scopeId: s, landed: 1, files: 0, held: 0, written: 0, pending: false,
        skipped: [
          { givenNumber: '12', reason: 'stor.pdf is 16777217 bytes, over 16777216' },
          { givenNumber: '12', reason: 'liten.pdf is gone from the archive' },
        ],
      }]);
    });

    it('leaves the cursor when the landing refuses, so the next pass reads the invoice again', async () => {
      await bindInvoices(REFUSING_OPERATION);
      invoice('12', '2026-06-10 09:00');

      const result = await sweepFortnoxLedger(host, connId, at(NOW));

      expect(result.failed).toEqual([{ scopeId: s, error: expect.stringMatching(/ledger closed for the period/) }]);
      expect((await binding()).invoiceSync).toBeUndefined();
    });

    it('resumes a change set larger than the budget, and re-reads an invoice that changed mid-run', async () => {
      await bindInvoices();
      for (const n of ['3', '1', '2']) invoice(n, '2026-06-10 09:00');
      const run = async (ms: number) => syncFortnoxSupplierInvoices(host, connId, await binding(), { ...at(ms), budget: { details: 2 } });

      expect(await run(NOW)).toEqual({ scopeId: s, landed: 2, files: 0, held: 0, written: 0, pending: true });
      expect((await binding()).invoiceSync?.pending).toEqual({ startedAt: new Date(NOW).toISOString(), through: '2' });
      invoice('1', '2026-06-15 14:10'); // changed again after the run began

      expect(await run(NOW + 15 * 60_000)).toEqual({ scopeId: s, landed: 1, files: 0, held: 0, written: 0, pending: false });
      expect(invoicesLanded.map((p) => p.invoices.map((i) => i.givenNumber))).toEqual([['1', '2'], ['3']]);
      // Drained: the cursor moves to when the run began, not to now, so the mid-run change is read.
      expect((await binding()).invoiceSync).toMatchObject({ since: new Date(NOW).toISOString() });
      expect((await binding()).invoiceSync?.pending).toBeUndefined();

      expect(await run(NOW + 30 * 60_000)).toEqual({ scopeId: s, landed: 1, files: 0, held: 0, written: 0, pending: false });
      expect(invoicesLanded.at(-1)!.invoices.map((i) => i.givenNumber)).toEqual(['1']);
    });

    it('waits out a 429 for as long as Fortnox says, then lands', async () => {
      await bindInvoices();
      invoice('12', '2026-06-10 09:00');
      fortnox.rateLimitNext = 1;
      const sleeps: number[] = [];

      const result = await sweepFortnoxLedger(host, connId, { ...at(NOW), sleep: async (ms) => void sleeps.push(ms) });

      expect(result.failed).toEqual([]);
      expect(sleeps).toEqual([2000]);
      expect(invoicesLanded.map((p) => p.invoices.map((i) => i.givenNumber))).toEqual([['12']]);
    });

    it('gives up on a read after three 429s and fails naming the invoice', async () => {
      await bindInvoices();
      invoice('12', '2026-06-10 09:00');
      fortnox.rateLimitOn = '/supplierinvoices/';
      fortnox.rateLimitNext = 4;
      const sleeps: number[] = [];

      const result = await sweepFortnoxLedger(host, connId, { ...at(NOW), sleep: async (ms) => void sleeps.push(ms) });

      expect(sleeps).toEqual([2000, 2000, 2000]);
      expect(result.failed).toEqual([{ scopeId: s, error: expect.stringContaining('supplier invoice 12:') }]);
      expect(invoicesLanded).toEqual([]);
    });

    it('stops starting reads after 90 seconds, lands them, and resumes next pass', async () => {
      await bindInvoices();
      for (let n = 1; n <= 20; n += 1) invoice(String(n), '2026-06-10 09:00');
      let clock = NOW;
      // A slow Fortnox: every REST request takes ten seconds.
      const fetch: typeof fortnox.fetch = (input, init) => {
        if (!String(input).includes('/oauth-v1/')) clock += 10_000;
        return fortnox.fetch(input, init);
      };
      const slow = () => ({ ...options(), fetch, now: () => clock });

      const first = await sweepFortnoxLedger(host, connId, slow());

      // The list at 10 s, then reads until 90 s had passed: eight of them.
      expect(first.failed).toEqual([]);
      expect(first.invoices).toEqual([{ scopeId: s, landed: 8, files: 0, held: 0, written: 0, pending: true }]);
      expect(invoicesLanded[0]!.invoices.map((i) => i.givenNumber)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);

      // A poll on request (#2672) is held to the same deadline, and says work is left.
      expect(await pollFortnoxScope(host, connId, s, slow())).toEqual({ outcome: 'landed', pending: true, errors: [] });
      expect(invoicesLanded[1]!.invoices[0]!.givenNumber).toBe('9');
    });

    it('paces a burst of reads to 25 requests in any 5 seconds', async () => {
      await bindInvoices();
      for (let n = 1; n <= 40; n += 1) invoice(String(n), '2026-06-10 09:00');
      let clock = NOW;
      const sent: number[] = [];
      const fetch: typeof fortnox.fetch = (input, init) => {
        if (!String(input).includes('/oauth-v1/')) sent.push(clock);
        return fortnox.fetch(input, init);
      };

      await sweepFortnoxLedger(host, connId, { ...options(), fetch, now: () => clock, sleep: async (ms) => void (clock += ms) });

      expect(invoicesLanded[0]!.invoices).toHaveLength(40);
      expect(sent).toHaveLength(42); // the list, 40 details, the company
      expect(Math.max(...sent.map((t) => sent.filter((u) => u >= t && u < t + 5_000).length))).toBe(25);
    });

    it('steps over an invoice deleted between the list and its read', async () => {
      await bindInvoices();
      for (const n of ['1', '2', '3']) invoice(n, '2026-06-10 09:00');
      fortnox.setSupplierInvoice({ invoice: { GivenNumber: '2' }, modified: '2026-06-10 09:00', gone: true });

      const result = await sweepFortnoxLedger(host, connId, at(NOW));

      expect(result.failed).toEqual([]);
      expect(invoicesLanded.map((p) => p.invoices.map((i) => i.givenNumber))).toEqual([['1', '3']]);
      expect((await binding()).invoiceSync?.pending).toBeUndefined();
    });

    it('lands what it read before an unreadable invoice, then fails by its number without re-landing', async () => {
      await bindInvoices();
      for (const n of ['1', '2', '3']) invoice(n, '2026-06-10 09:00', n === '2' ? { Booked: 'yes' } : {});

      const first = await sweepFortnoxLedger(host, connId, at(NOW));

      expect(first.failed).toEqual([{ scopeId: s, error: expect.stringContaining('supplier invoice 2:') }]);
      expect(invoicesLanded.map((p) => p.invoices.map((i) => i.givenNumber))).toEqual([['1']]);
      expect((await binding()).invoiceSync?.pending?.through).toBe('1');

      const second = await sweepFortnoxLedger(host, connId, at(NOW + 15 * 60_000));
      expect(second.failed).toEqual([{ scopeId: s, error: expect.stringContaining('supplier invoice 2:') }]);
      expect(invoicesLanded).toHaveLength(1);
    });

    it('reads a repeated autumn hour from its start, so a change in its second pass is not hidden', async () => {
      await bindInvoices();
      // 00:45Z on 2026-10-25 is the FIRST 02:45 in Stockholm; less the overlap, the first 02:40.
      const b = await binding();
      await host.admin.putConnectorState(connId, `fortnox:binding:${s}`, {
        ...b, invoiceSync: { since: '2026-10-25T00:45:00.000Z', syncedAt: '2026-10-25T00:45:00.000Z', landed: 1 },
      });

      await sweepFortnoxLedger(host, connId, at(Date.parse('2026-10-25T01:30:00.000Z')));

      expect(fortnox.calls[0]).toBe('/3/supplierinvoices?lastmodified=2026-10-25%2002%3A00&limit=500&page=1');
    });

    describe('writing back', () => {
      const bindWriteback = (operation: string = INVOICE_OPERATION) =>
        bindFortnoxScope(host, {
          connectionId: connId, tenantId: t, scopeId: s, vertical: 'forecast', operation, permission: LEDGER_RECORD,
          kind: 'supplier-invoice', writeback: { read: WRITEBACK_READ, record: WRITEBACK_RECORD },
        });
      const unbooked = (givenNumber: string, extra: Record<string, unknown> = {}) =>
        invoice(givenNumber, '2026-06-10 09:00', { Booked: false, ...extra });
      const decided = (givenNumber: string, over: Partial<FortnoxInvoiceWriteback['decisions'][number]> = {}) => ({
        key: `decision-${givenNumber}`, givenNumber, book: true, release: true, comment: 'Godkänd', ...over,
      });
      const HOLD = { request: 'PUT /3/supplierinvoices/12', body: { SupplierInvoice: { DisablePaymentFile: true } } };
      const RELEASE = { request: 'PUT /3/supplierinvoices/12', body: { SupplierInvoice: { DisablePaymentFile: false } } };
      const BOOK = { request: 'PUT /3/supplierinvoices/12/bookkeep' };
      const COMMENT = { request: 'POST /3/supplierinvoices/12/commentlog', body: { SupplierInvoiceCommentLog: { Comment: 'Godkänd' } } };
      /** A Fortnox that answers `status` to the requests `matches` picks, `times` times. */
      const failing = (matches: (url: string, method: string) => boolean, status: number, times: number) => {
        let left = times;
        const fetch: typeof fortnox.fetch = (input, init) => {
          if (left > 0 && matches(String(input), init?.method ?? 'GET')) {
            left -= 1;
            return Promise.resolve({ ok: false, status, text: async () => 'unavailable', headers: { get: () => null } } as unknown as Awaited<ReturnType<typeof fortnox.fetch>>);
          }
          return fortnox.fetch(input, init);
        };
        return fetch;
      };

      it('asks for this company on every pass, also an idle one', async () => {
        await bindWriteback();

        await sweepFortnoxLedger(host, connId, at(NOW));

        expect(writebackAsked).toEqual([{ connectionId: connId, company: { name: 'Testbolaget AB', organizationNumber: '556677-8899' } }]);
        expect(fortnox.writes).toEqual([]);
      });

      it('holds an undecided invoice once, and remembers the hold as its own', async () => {
        await bindWriteback();
        unbooked('12');
        waiting = { hold: [{ givenNumber: '12' }], decisions: [] };

        const first = await sweepFortnoxLedger(host, connId, at(NOW));
        await sweepFortnoxLedger(host, connId, at(NOW + 15 * 60_000));

        expect(first.invoices).toEqual([{ scopeId: s, landed: 1, files: 0, held: 1, written: 0, pending: false }]);
        expect(fortnox.writes).toEqual([HOLD]);
      });

      it('books an approved invoice, then clears its hold, then comments, then says so', async () => {
        await bindWriteback();
        unbooked('12');
        waiting = { hold: [{ givenNumber: '12' }], decisions: [] };
        await sweepFortnoxLedger(host, connId, at(NOW));
        fortnox.writes.length = 0;

        waiting = { hold: [], decisions: [decided('12')] };
        const result = await sweepFortnoxLedger(host, connId, at(NOW + 15 * 60_000));

        expect(fortnox.writes).toEqual([BOOK, RELEASE, COMMENT]);
        expect(receipts).toEqual([{ key: 'decision-12', status: 'done', error: null }]);
        expect(result.invoices).toEqual([{ scopeId: s, landed: 0, files: 0, held: 0, written: 1, pending: false }]);
      });

      it('leaves a denied invoice held and unbooked, with only the comment', async () => {
        await bindWriteback();
        unbooked('12');
        waiting = { hold: [{ givenNumber: '12' }], decisions: [] };
        await sweepFortnoxLedger(host, connId, at(NOW));
        fortnox.writes.length = 0;

        waiting = { hold: [], decisions: [decided('12', { book: false, release: false })] };
        await sweepFortnoxLedger(host, connId, at(NOW + 15 * 60_000));

        expect(fortnox.writes).toEqual([COMMENT]);
      });

      it('never clears a block it did not set', async () => {
        await bindWriteback();
        unbooked('12', { DisablePaymentFile: true }); // a supplier paid by direct debit, say
        waiting = { hold: [{ givenNumber: '12' }], decisions: [decided('12')] };

        await sweepFortnoxLedger(host, connId, at(NOW));

        expect(fortnox.writes).toEqual([BOOK, COMMENT]);
      });

      it('holds an invoice again when it comes back to the queue after a release', async () => {
        await bindWriteback();
        unbooked('12');
        waiting = { hold: [{ givenNumber: '12' }], decisions: [decided('12')] };
        await sweepFortnoxLedger(host, connId, at(NOW));
        fortnox.writes.length = 0;

        waiting = { hold: [{ givenNumber: '12' }], decisions: [] };
        await sweepFortnoxLedger(host, connId, at(NOW + 15 * 60_000));

        expect(fortnox.writes).toEqual([HOLD]);
      });

      it('repeats nothing in Fortnox when the receipt is what failed', async () => {
        await bindWriteback();
        unbooked('12');
        waiting = { hold: [], decisions: [decided('12')] };
        refuseReceipts = 1;

        const first = await sweepFortnoxLedger(host, connId, at(NOW));
        const second = await sweepFortnoxLedger(host, connId, at(NOW + 15 * 60_000));

        expect(first.failed).toEqual([{ scopeId: s, error: expect.stringContaining('write-back of supplier invoice 12:') }]);
        expect(second.failed).toEqual([]);
        expect(fortnox.writes).toEqual([BOOK, COMMENT]);
        expect(receipts).toHaveLength(1);
      });

      it('hands a booking Fortnox refuses to the vertical at once, in its words, with the hold in place', async () => {
        await bindWriteback();
        unbooked('12');
        fortnox.setSupplierInvoice({
          modified: '2026-06-10 09:00',
          invoice: { GivenNumber: '12', Total: 100, Booked: false, Cancelled: false },
          cannotBook: 'Perioden är låst',
        });
        waiting = { hold: [{ givenNumber: '12' }], decisions: [decided('12')] };

        const result = await sweepFortnoxLedger(host, connId, at(NOW));

        expect(fortnox.writes).toEqual([HOLD, BOOK]);
        expect(receipts).toEqual([{ key: 'decision-12', status: 'failed', error: expect.stringContaining('Perioden är låst') }]);
        expect(result.failed).toEqual([{ scopeId: s, error: expect.stringContaining('write-back of supplier invoice 12:') }]);
      });

      it('retries an outage for eight passes, then tells the vertical, and a retry starts over', async () => {
        await bindWriteback();
        unbooked('12');
        waiting = { hold: [], decisions: [decided('12')] };
        const down = failing((url, method) => url.endsWith('/bookkeep') && method === 'PUT', 503, 100);
        const pass = (n: number) => sweepFortnoxLedger(host, connId, { ...at(NOW + n * 15 * 60_000), fetch: down });

        for (let n = 0; n < 7; n += 1) await pass(n);
        expect(receipts).toEqual([]);

        await pass(7);
        expect(receipts).toEqual([{ key: 'decision-12', status: 'failed', error: expect.any(String) }]);

        await pass(8);
        expect(receipts).toHaveLength(1);
      });

      it('writes when the landing refused, because a decision does not depend on it', async () => {
        await bindWriteback(REFUSING_OPERATION);
        unbooked('12');
        waiting = { hold: [], decisions: [decided('12')] };

        const result = await sweepFortnoxLedger(host, connId, at(NOW));

        expect(result.failed).toEqual([{ scopeId: s, error: expect.stringMatching(/ledger closed for the period/) }]);
        expect(receipts).toHaveLength(1);
      });

      it('stops at the budget and carries on next pass', async () => {
        await bindWriteback();
        for (const n of ['1', '2']) unbooked(n);
        await sweepFortnoxLedger(host, connId, at(NOW));
        waiting = { hold: [], decisions: [decided('1'), decided('2')] };
        const run = async (ms: number) => syncFortnoxSupplierInvoices(host, connId, await binding(), { ...at(ms), budget: { details: 7 } });

        expect(await run(NOW + 15 * 60_000)).toMatchObject({ written: 1, pending: true });
        expect(receipts.map((r) => r.key)).toEqual(['decision-1']);
      });

      it('claims a block whose write went unanswered once it finds it set, and later releases it', async () => {
        await bindWriteback();
        unbooked('12');
        waiting = { hold: [{ givenNumber: '12' }], decisions: [] };
        // Fortnox takes the write, then the answer is lost.
        const lost: typeof fortnox.fetch = async (input, init) => {
          const res = await fortnox.fetch(input, init);
          return init?.method === 'PUT'
            ? ({ ok: false, status: 503, text: async () => 'unavailable', headers: { get: () => null } } as unknown as typeof res)
            : res;
        };

        const first = await sweepFortnoxLedger(host, connId, { ...at(NOW), fetch: lost });
        expect(first.failed).toEqual([{ scopeId: s, error: expect.stringContaining('hold of supplier invoice 12:') }]);
        await sweepFortnoxLedger(host, connId, at(NOW + 15 * 60_000));
        expect(fortnox.writes).toEqual([HOLD]);

        waiting = { hold: [], decisions: [decided('12')] };
        await sweepFortnoxLedger(host, connId, at(NOW + 30 * 60_000));
        expect(fortnox.writes).toEqual([HOLD, BOOK, RELEASE, COMMENT]);
      });

      it('holds an invoice once someone lifts the block it found', async () => {
        await bindWriteback();
        unbooked('12', { DisablePaymentFile: true });
        waiting = { hold: [{ givenNumber: '12' }], decisions: [] };
        await sweepFortnoxLedger(host, connId, at(NOW));
        expect(fortnox.writes).toEqual([]);

        unbooked('12', { DisablePaymentFile: false });
        const lifted = await sweepFortnoxLedger(host, connId, at(NOW + 15 * 60_000));

        expect(fortnox.writes).toEqual([HOLD]);
        expect(lifted.invoices).toEqual([expect.objectContaining({ held: 1 })]);
      });

      it('asks to hold again after a hold that failed', async () => {
        await bindWriteback();
        unbooked('12');
        waiting = { hold: [{ givenNumber: '12' }], decisions: [] };
        const down = failing((_url, method) => method === 'PUT', 503, 1);

        const first = await sweepFortnoxLedger(host, connId, { ...at(NOW), fetch: down });
        const second = await sweepFortnoxLedger(host, connId, at(NOW + 15 * 60_000));

        expect(first.failed).toEqual([{ scopeId: s, error: expect.stringContaining('hold of supplier invoice 12:') }]);
        expect(second.invoices).toEqual([{ scopeId: s, landed: 0, files: 0, held: 1, written: 0, pending: false }]);
      });
    });

    it('keeps ledger and invoice bindings of one connection apart', async () => {
      await bind();
      const invoiceScope = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: invoiceScope, jurisdiction: 'eu', vertical: 'forecast' });
      await host.admin.activateScope(staff, t, invoiceScope);
      await host.admin.grantToConnection(staff, { connectionId: connId, permission: LEDGER_RECORD, node: { tenantId: t, scopeId: invoiceScope }, grantedBy: staff });
      await bindInvoices(INVOICE_OPERATION, invoiceScope);
      invoice('12', '2026-06-10 09:00');

      const result = await sweepFortnoxLedger(host, connId, at(NOW));

      expect(result.failed).toEqual([]);
      expect(result.synced.map((r) => r.scopeId)).toEqual([s]);
      expect(result.invoices.map((r) => r.scopeId)).toEqual([invoiceScope]);
      expect(landed).toHaveLength(1);
      expect(invoicesLanded).toHaveLength(1);
    });
  });

  it('fails closed for a stored kind from a newer platform', async () => {
    await host.admin.putConnectorState(connId, `fortnox:binding:${s}`, {
      scopeId: s, tenantId: t, vertical: 'forecast', operation: OPERATION,
      permission: LEDGER_RECORD, kind: 'future-kind', boundAt: new Date().toISOString(),
    });
    const result = await sweepFortnoxLedger(host, connId, options());
    expect(result.failed).toEqual([{ scopeId: s, error: expect.stringContaining("unknown Fortnox binding kind 'future-kind'") }]);
    expect(fortnox.calls).toEqual([]);
    expect(landed).toEqual([]);
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
    // The sweep skipping a tombstone is not the same claim as the EXPORTED list
    // skipping one: `unbindFortnoxScope` writes `null` under the same key, and a
    // caller reading `b.scopeId` off that gets a TypeError from a value the types
    // swore was a `FortnoxBinding`.
    expect(await listFortnoxBindings(host, connId)).toEqual([]);
    const result = await sweepFortnoxLedger(host, connId, options());
    expect(result.found).toBe(0);
    expect(landed).toHaveLength(0);
  });

  it('re-syncs when the window moves, even though the payload is byte-identical', async () => {
    // A financial year that straddles calendar years — ordinary in Sweden, and the case
    // that made hashing the payload alone lose data. A December sweep lands only the
    // 2026 months; the January sweep selects the SAME year by overlap and downloads the
    // SAME bytes, so a payload-only hash returned `changed: false` and the 2027 months
    // never landed until the books happened to change.
    fortnox = new FortnoxMock({
      financialYears: [{ Id: 7, FromDate: '2026-07-01', ToDate: '2027-06-30' }],
    });
    fortnox.setSie(
      7,
      [
        '#FNAMN "Brutet AB"',
        '#VALUTA SEK',
        '#RAR 0 20260701 20270630',
        '#KONTO 4160 "Reparationer"',
        '#VER A 1 20261115 "Hösten"',
        '{',
        '#TRANS 4160 {} 100.00',
        '}',
        '#VER A 2 20270215 "Våren"',
        '{',
        '#TRANS 4160 {} 200.00',
        '}',
        '',
      ].join('\r\n'),
    );
    await bind();

    const december = await sweepFortnoxLedger(host, connId, {
      ...options(),
      period: { from: '2026-01-01', to: '2026-12-31' },
    });
    expect(december.synced).toHaveLength(1);
    expect(landed).toHaveLength(1);
    expect(landed[0]!.balances.map((b) => b.month)).toEqual(['2026-11']);

    const january = await sweepFortnoxLedger(host, connId, {
      ...options(),
      period: { from: '2027-01-01', to: '2027-12-31' },
    });
    expect(january.unchanged).toBe(0);
    expect(january.synced).toHaveLength(1);
    expect(landed).toHaveLength(2);
    expect(landed[1]!.balances.map((b) => b.month)).toEqual(['2027-02']);
    // Different rows must never present the same idempotency key to a consumer's upsert.
    expect(landed[1]!.syncId).not.toBe(landed[0]!.syncId);
  });

  it('still skips when both the payload and the window are unchanged', async () => {
    // The guard above must not cost the cheap no-op the sweep depends on.
    await bind();
    await sweepFortnoxLedger(host, connId, options());
    const again = await sweepFortnoxLedger(host, connId, options());
    expect(again.unchanged).toBe(1);
    expect(landed).toHaveLength(1);
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

  it('sweeps each company of a bureau with its own credential (#2316)', async () => {
    // One connection per client company in the same (tenant, vertical), told apart by
    // `externalAccountRef` (#1267). Opening by (tenant, vertical) alone threw for both once the
    // second existed, so neither company's books ever landed.
    await host.admin.revokeConnection(staff, connId);
    const companies = ['111111', '222222'];
    const ids: ConnectionId[] = [];
    for (const ref of companies) {
      const id = connectionId.parse(ulid());
      await host.admin.createConnection(staff, {
        id,
        tenantId: t,
        vertical: 'forecast',
        provider: 'fortnox',
        label: `Company ${ref}`,
        externalAccountRef: ref,
        secret: { clientId: 'client-id', clientSecret: 'client-secret', tenantId: '123456' },
      });
      await host.admin.grantToConnection(staff, { connectionId: id, permission: LEDGER_RECORD, node: { tenantId: t, scopeId: s }, grantedBy: staff });
      await bindFortnoxScope(host, { connectionId: id, tenantId: t, scopeId: s, vertical: 'forecast', operation: OPERATION, permission: LEDGER_RECORD, externalAccountRef: ref });
      ids.push(id);
    }

    for (const id of ids) {
      const result = await sweepFortnoxLedger(host, id, options());
      expect(result.failed).toEqual([]);
      expect(result.synced).toHaveLength(1);
    }
    expect(landed.map((p) => p.connectionId).sort()).toEqual([...ids].sort());
  });

  it('refuses to read one company with another\'s credential (#2316)', async () => {
    // A binding written before it recorded the company opens whichever connection the pair
    // finds. With a second company that is ambiguous, and the refusal names the re-bind.
    await bind();
    const other = connectionId.parse(ulid());
    await host.admin.createConnection(staff, {
      id: other,
      tenantId: t,
      vertical: 'forecast',
      provider: 'fortnox',
      label: 'Second company',
      externalAccountRef: '222222',
      secret: { clientId: 'client-id', clientSecret: 'client-secret', tenantId: '123456' },
    });

    const result = await sweepFortnoxLedger(host, connId, options());

    expect(landed).toEqual([]);
    expect(result.failed).toEqual([{ scopeId: s, error: expect.stringMatching(/multiple live 'fortnox' connections/) }]);
  });
});
