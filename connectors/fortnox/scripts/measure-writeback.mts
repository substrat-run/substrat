/**
 * Measure the supplier-invoice write-back (#2827) against a Fortnox SANDBOX, and print what
 * Fortnox actually answered.
 *
 * ## Why this exists
 *
 * The write-back has only ever run against `FortnoxMock`, and the mock is our reading of
 * Fortnox's docs. Five questions about it can only be answered by a real Fortnox: whether
 * `DisablePaymentFile` can be set and cleared over the API before and after booking, what
 * `bookkeep` answers when it cannot book, how the comment log behaves, which scopes the writes
 * need, and what `GET /3/supplierinvoices` lists. This script asks each of them and records every
 * call: method, path, request body, HTTP status and the raw response body. The transcript is the
 * deliverable; `connectors/fortnox/MEASUREMENTS-writeback.md` is written from it.
 *
 * ## Why it is a script and not a test
 *
 * It writes: it creates a supplier and supplier invoices, books, cancels, blocks and comments.
 * `test/live.test.ts` is read-only so it can be pointed at a production company, and writing from
 * inside it would end that. So the writing lives here, and refuses any company whose organisation
 * number is not Fortnox's sandbox marker (`sandbox-guard.mts`, the check `pnpm fortnox:seed` makes).
 * There is no `--force`.
 *
 * ## What it calls
 *
 * The writes and reads the write-back makes go through the real `FortnoxApi` methods
 * (`setSupplierInvoicePaymentBlock`, `bookSupplierInvoice`, `addSupplierInvoiceComment`,
 * `supplierInvoiceComments`, `supplierInvoice`, `supplierInvoicesModifiedSince`), so what is
 * measured is the code that will run. Seeding (a supplier, invoices, a cancel) and the list
 * filters have no `FortnoxApi` method, and are called directly; the transcript says which is
 * which. Both go through one recording `fetch`, which is how the raw bodies are kept.
 *
 * The end-to-end run drives `syncFortnoxSupplierInvoices` on a throwaway `SqliteScopeHost`, the
 * way `test/sweep.test.ts` drives it with the mock, with a hand-written `{ hold, decisions }`
 * answer and nothing bound in any real install.
 *
 * Usage, from the repo root:
 *
 *   pnpm fortnox:measure-writeback                     # transcript to stdout
 *   pnpm fortnox:measure-writeback --out=calls.json    # and every call as JSON
 *
 * Credentials come from `secrets/connectors.env`, the same file the live suite reads. The access
 * token is redacted from the transcript. Harness code: `node:*` is fine here.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  undeclaredOperations,
  webCryptoSecretBox,
  type ConnectorConnection,
  type FetchLike,
  type ModuleRegistration,
  type OperationHandler,
} from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { FortnoxApi, FORTNOX_API_BASE, type FortnoxSecret } from '../src/api.js';
import {
  bindFortnoxScope,
  listFortnoxBindings,
  syncFortnoxSupplierInvoices,
  type FortnoxInvoiceWriteback,
  type FortnoxInvoiceWritebackReceipt,
} from '../src/index.js';
import { loadDevSecrets, providerEnv } from './dev-secrets.mjs';
import { requireSandbox } from './sandbox-guard.mjs';

const PKG = dirname(fileURLToPath(import.meta.url));
const flag = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);

const env = {
  ...loadDevSecrets(join(PKG, '..', '..', '..', 'secrets', 'connectors.env'), join(PKG, '..', '.dev.vars')),
  ...providerEnv('FORTNOX_'),
};
const { FORTNOX_CLIENT_ID, FORTNOX_CLIENT_SECRET, FORTNOX_TENANT_ID } = env;
if (!FORTNOX_CLIENT_ID || !FORTNOX_CLIENT_SECRET || !FORTNOX_TENANT_ID) {
  console.error(
    'fortnox:measure-writeback: need FORTNOX_CLIENT_ID / FORTNOX_CLIENT_SECRET / FORTNOX_TENANT_ID\n' +
      '  in secrets/connectors.env (run `pnpm fortnox:connect` for the tenant id).',
  );
  process.exit(2);
}
const secret: FortnoxSecret = { clientId: FORTNOX_CLIENT_ID, clientSecret: FORTNOX_CLIENT_SECRET, tenantId: FORTNOX_TENANT_ID };

// ---------------------------------------------------------------------------
// The recording fetch: every call, raw, in order.
// ---------------------------------------------------------------------------

interface Call {
  step: string;
  /** `FortnoxApi.<method>` for the connector's own code, `direct` for a call it has no method for. */
  via: string;
  method: string;
  path: string;
  request: unknown;
  status: number;
  response: string;
}
const calls: Call[] = [];
let step = 'setup';
let via = 'direct';

/** Fortnox allows 25 requests per 5 s; one every 220 ms stays under it whoever is calling. */
let lastSent = 0;
const pace = async (): Promise<void> => {
  const wait = lastSent + 220 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastSent = Date.now();
};

const redactToken = (text: string): string => {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed['access_token'] === 'string') parsed['access_token'] = '<redacted>';
    return JSON.stringify(parsed);
  } catch {
    return text;
  }
};

/**
 * A `fetch` that records. With `scope`, a client-credentials mint asks for that scope only, which
 * Fortnox honours (it answers `invalid_scope` for one the consent does not hold), so the same
 * `FortnoxApi` methods can be measured with a narrower token.
 */
const recording = (scope?: string): FetchLike =>
  (async (input, init) => {
    const url = new URL(String(input));
    const isMint = url.pathname.endsWith('/oauth-v1/token');
    let body = init?.body;
    if (isMint && scope !== undefined) body = `${String(body)}&scope=${encodeURIComponent(scope)}`;
    await pace();
    const res = await fetch(String(input), { ...(init as RequestInit), ...(body === undefined ? {} : { body: body as string }) });
    const text = await res.clone().text();
    let request: unknown = body;
    if (!isMint && typeof body === 'string') {
      try {
        request = JSON.parse(body);
      } catch {
        // Not JSON: kept as sent.
      }
    }
    calls.push({
      step,
      via,
      method: init?.method ?? 'GET',
      path: isMint ? '/oauth-v1/token' : url.pathname.replace(/^\/3/, '') + url.search,
      request: request ?? null,
      status: res.status,
      response: isMint ? redactToken(text) : text,
    });
    return res;
  }) as FetchLike;

const connectionFor = (fetchLike: FetchLike): ConnectorConnection => ({
  id: connectionId.parse('00000000000000000000000000'),
  tenantId: '',
  vertical: '',
  provider: 'fortnox',
  secret,
  expiresAt: null,
  fetch: fetchLike,
});

const api = new FortnoxApi(connectionFor(recording()));

type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

/** One `FortnoxApi` call, recorded under its own name. A refusal is an answer here, not a crash. */
async function viaApi<T>(name: string, fn: () => Promise<T>): Promise<Outcome<T>> {
  via = `FortnoxApi.${name}`;
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    via = 'direct';
  }
}

/** A call `FortnoxApi` has no method for, with the token of `using` (the full consent's, by default). */
async function direct(method: string, path: string, body?: unknown, using: FortnoxApi = api): Promise<{ status: number; json: any }> {
  via = 'direct';
  const token = await using.accessToken();
  const res = await recording()(`${FORTNOX_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/** The raw detail of an invoice, read through `FortnoxApi.supplierInvoice` and taken off the transcript. */
async function snapshot(givenNumber: string): Promise<Record<string, unknown>> {
  const read = await viaApi('supplierInvoice', () => api.supplierInvoice(givenNumber));
  const last = calls[calls.length - 1]!;
  if (!read.ok && last.status >= 400) return {};
  return ((JSON.parse(last.response) as { SupplierInvoice?: Record<string, unknown> }).SupplierInvoice ?? {}) as Record<string, unknown>;
}

/**
 * Attest an invoice for bookkeeping. This sandbox refuses `bookkeep` on an invoice nobody has
 * attested (`2001109 Fakturan måste vara attesterad.`), and #2827 has no attest call, so the
 * measurements that need a booked invoice attest it first, directly, as the company's attest
 * routine would.
 */
const attest = (givenNumber: string, using: FortnoxApi = api) =>
  direct('PUT', `/supplierinvoices/${givenNumber}/approvalbookkeep`, undefined, using);

const flatten = (value: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> => {
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix === '' ? k : `${prefix}.${k}`, out);
  } else {
    out[prefix] = JSON.stringify(value);
  }
  return out;
};

/** Every field that differs between two raw details: `path: before → after`. */
function diff(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const a = flatten(before);
  const b = flatten(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => a[k] !== b[k])
    .map((k) => `${k}: ${a[k] ?? '(absent)'} → ${b[k] ?? '(absent)'}`);
}

/** What a step found, besides its calls. */
const findings: { step: string; note: string }[] = [];
const note = (text: string): void => {
  findings.push({ step, note: text });
};

/** What the transcript's header says: the run, the company, the invoices. Filled as they are known. */
const meta: Record<string, unknown> = {};

/**
 * The transcript, printed however the run ends: a run that throws half-way has still written to
 * Fortnox, and what it wrote is evidence.
 */
process.on('exit', () => {
  console.log(`\n# Write-back measurement ${meta.run ?? ''}, ${new Date().toISOString()}\n`);
  console.log(`${JSON.stringify(meta)}\n`);
  for (const name of [...new Set(calls.map((c) => c.step))]) {
    console.log(`## ${name}\n`);
    for (const f of findings.filter((x) => x.step === name)) console.log(`- ${f.note}`);
    console.log('');
    for (const c of calls.filter((x) => x.step === name)) {
      console.log(`${c.method} ${c.path}  [${c.via}]`);
      if (c.request !== null) console.log(`  request:  ${typeof c.request === 'string' ? c.request : JSON.stringify(c.request)}`);
      console.log(`  response: ${c.status} ${c.response.length > 3000 ? `${c.response.slice(0, 3000)}… (${c.response.length} chars)` : c.response}`);
    }
    console.log('');
  }
  const out = flag('out');
  if (out !== undefined) {
    writeFileSync(out, JSON.stringify({ ...meta, findings, calls }, null, 2));
    console.log(`every call as JSON: ${out}`);
  }
});

// ---------------------------------------------------------------------------
// The harness the end-to-end run lands into, built before anything is written.
// ---------------------------------------------------------------------------
const RECORD = permissionKey.parse('ledger:record');
let waiting: FortnoxInvoiceWriteback = { hold: [], decisions: [] };
const receipts: FortnoxInvoiceWritebackReceipt[] = [];
const measuring: ModuleRegistration = {
  manifest: moduleManifest.parse({
    id: '@measure/writeback',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [{ key: 'ledger:record', description: 'land supplier invoices and answer write-backs' }],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'ledger',
  }),
  ...undeclaredOperations('a measurement harness, built to drive the host rather than declared', {
    'invoices/record': (async (ctx) => {
      assertAllowed(await ctx.check(RECORD));
      return { ok: true };
    }) as OperationHandler<never, unknown>,
    'invoices/writeback': (async (ctx) => {
      assertAllowed(await ctx.check(RECORD));
      return waiting;
    }) as OperationHandler<never, unknown>,
    'invoices/writeback-record': (async (ctx, input: FortnoxInvoiceWritebackReceipt) => {
      assertAllowed(await ctx.check(RECORD));
      receipts.push(input);
      return { ok: true };
    }) as OperationHandler<never, unknown>,
  }),
};

// ---------------------------------------------------------------------------
// 0. The guard. Nothing below runs against a company that is not a sandbox.
// ---------------------------------------------------------------------------
step = '0 guard';
const company = await requireSandbox(api, { script: 'fortnox:measure-writeback', writes: 'supplier invoices' });
const run = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
const today = new Date().toISOString().slice(0, 10);
const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
console.log(`run     : WB-${run}\n`);
Object.assign(meta, { run: `WB-${run}`, company: { name: company.CompanyName, organizationNumber: company.OrganizationNumber } });

// ---------------------------------------------------------------------------
// 1. Seed: one supplier, and the invoices the measurements need.
// ---------------------------------------------------------------------------
step = '1 seed';
const SUPPLIER_NAME = 'Substrat write-back measurement';
const suppliers = await direct('GET', '/suppliers?limit=500');
let supplierNumber: string | undefined = (suppliers.json?.Suppliers ?? []).find(
  (s: { Name?: string }) => s.Name === SUPPLIER_NAME,
)?.SupplierNumber;
if (supplierNumber === undefined) {
  const created = await direct('POST', '/suppliers', { Supplier: { Name: SUPPLIER_NAME } });
  supplierNumber = created.json?.Supplier?.SupplierNumber;
}
if (supplierNumber === undefined) throw new Error('could not find or create the measurement supplier');

/** Register an unbooked supplier invoice. Answers its `GivenNumber`, or null when Fortnox refused it. */
async function register(label: string, rows: unknown[]): Promise<string | null> {
  const created = await direct('POST', '/supplierinvoices', {
    SupplierInvoice: {
      SupplierNumber: supplierNumber,
      InvoiceNumber: `WB-${run}-${label}`,
      InvoiceDate: today,
      DueDate: inDays(30),
      Total: 125,
      VAT: 25,
      SupplierInvoiceRows: rows,
    },
  });
  return created.status < 300 ? String(created.json?.SupplierInvoice?.GivenNumber) : null;
}
const COST_ROW = { Account: 4010, Debit: 100 };

const A = await register('A-normal', [COST_ROW]);
if (A === null) throw new Error('Fortnox refused the plain invoice; see the transcript');
// B: no cost account at all, and failing that, a cost row that does not balance.
const B = (await register('B-no-cost-row', [])) ?? (await register('B-short-row', [{ Account: 4010, Debit: 40 }]));
const C = await register('C-booked-before', [COST_ROW]);
const D = await register('D-cancelled', [COST_ROW]);
const E = await register('E-narrow-scope', [COST_ROW]);
const F = await register('F-end-to-end-unattested', [COST_ROW]);
const G = await register('G-end-to-end-attested', [COST_ROW]);
const H = await register('H-paid-unbooked', [COST_ROW]);
const I = await register('I-paid-unbooked-blocked', [COST_ROW]);
if (C === null || D === null || E === null || F === null || G === null || H === null || I === null) {
  throw new Error('Fortnox refused a plain invoice; see the transcript');
}

await attest(C);
const booked = await viaApi('bookSupplierInvoice', () => api.bookSupplierInvoice(C));
if (!booked.ok) note(`C could not be booked during seeding: ${booked.error}`);
await direct('PUT', `/supplierinvoices/${D}/cancel`);
const invoices = { A, B, C, D, E, F, G, H, I };
console.log(`invoices: ${JSON.stringify(invoices)}`);
meta['invoices'] = invoices;

// ---------------------------------------------------------------------------
// 2. Question 1: the payment block (DisablePaymentFile).
// ---------------------------------------------------------------------------
step = '2 payment block';
const a0 = await snapshot(A);
await viaApi('setSupplierInvoicePaymentBlock', () => api.setSupplierInvoicePaymentBlock(A, true));
const a1 = await snapshot(A);
note(`A unbooked, block set: DisablePaymentFile=${JSON.stringify(a1['DisablePaymentFile'])}; fields changed: ${JSON.stringify(diff(a0, a1))}`);

const unattested = await viaApi('bookSupplierInvoice', () => api.bookSupplierInvoice(A));
note(`A bookkeep before attest: ${unattested.ok ? 'booked' : `refused (${unattested.error})`}`);
await attest(A);
await viaApi('bookSupplierInvoice', () => api.bookSupplierInvoice(A));
const a2 = await snapshot(A);
note(`A booked while blocked: Booked=${JSON.stringify(a2['Booked'])} DisablePaymentFile=${JSON.stringify(a2['DisablePaymentFile'])}; fields changed: ${JSON.stringify(diff(a1, a2))}`);

await viaApi('setSupplierInvoicePaymentBlock', () => api.setSupplierInvoicePaymentBlock(A, false));
const a3 = await snapshot(A);
note(`A booked, block cleared: DisablePaymentFile=${JSON.stringify(a3['DisablePaymentFile'])}; fields changed: ${JSON.stringify(diff(a2, a3))}`);

await viaApi('setSupplierInvoicePaymentBlock', () => api.setSupplierInvoicePaymentBlock(A, true));
const a4 = await snapshot(A);
note(`A booked, block set again: DisablePaymentFile=${JSON.stringify(a4['DisablePaymentFile'])}; fields changed: ${JSON.stringify(diff(a3, a4))}`);
await viaApi('setSupplierInvoicePaymentBlock', () => api.setSupplierInvoicePaymentBlock(A, false));

const c0 = await snapshot(C);
await viaApi('setSupplierInvoicePaymentBlock', () => api.setSupplierInvoicePaymentBlock(C, true));
const c1 = await snapshot(C);
note(`C booked before any block, block set: DisablePaymentFile=${JSON.stringify(c1['DisablePaymentFile'])}; fields changed: ${JSON.stringify(diff(c0, c1))}`);

// ---------------------------------------------------------------------------
// 3. Question 2: bookkeep, where it cannot or need not book. Sent with no body, as #2827 does.
// ---------------------------------------------------------------------------
step = '3 bookkeep';
if (B !== null) {
  const b0 = await snapshot(B);
  await viaApi('bookSupplierInvoice', () => api.bookSupplierInvoice(B));
  const attestedB = await attest(B);
  note(`B (no cost account) attest: ${attestedB.status}`);
  await viaApi('bookSupplierInvoice', () => api.bookSupplierInvoice(B));
  const b1 = await snapshot(B);
  note(`B (no cost account) after bookkeep: Booked=${JSON.stringify(b1['Booked'])}; fields changed: ${JSON.stringify(diff(b0, b1))}`);
}
const c2 = await snapshot(C);
await viaApi('bookSupplierInvoice', () => api.bookSupplierInvoice(C));
const c3 = await snapshot(C);
note(`C (already booked) after bookkeep: fields changed: ${JSON.stringify(diff(c2, c3))}`);
const d0 = await snapshot(D);
await viaApi('bookSupplierInvoice', () => api.bookSupplierInvoice(D));
note(`D (cancelled) attest: ${(await attest(D)).status}`);
await viaApi('bookSupplierInvoice', () => api.bookSupplierInvoice(D));
const d1 = await snapshot(D);
note(`D (cancelled) after bookkeep: Booked=${JSON.stringify(d1['Booked'])} Cancelled=${JSON.stringify(d1['Cancelled'])}; fields changed: ${JSON.stringify(diff(d0, d1))}`);

// ---------------------------------------------------------------------------
// 4. Question 3: the comment log.
// ---------------------------------------------------------------------------
step = '4 comment log';
const FIRST = 'Mätning 1: godkänd – åäö';
const SECOND = 'Mätning 2: andra kommentaren';
await viaApi('addSupplierInvoiceComment', () => api.addSupplierInvoiceComment(A, FIRST));
await viaApi('addSupplierInvoiceComment', () => api.addSupplierInvoiceComment(A, SECOND));
const log = await viaApi('supplierInvoiceComments', () => api.supplierInvoiceComments(A));
note(`A comment log through FortnoxApi.supplierInvoiceComments: ${JSON.stringify(log)}`);
const aComments = await snapshot(A);
note(`A detail's CommentLog: ${JSON.stringify(aComments['CommentLog'])}`);

// 1000 and 1001 first; past that, doubling until Fortnox refuses, so the transcript bounds the limit.
for (const length of [1000, 1001, 2000, 4000, 8000, 16000, 65536]) {
  const text = `L${length}:`.padEnd(length, 'x');
  const added = await viaApi('addSupplierInvoiceComment', () => api.addSupplierInvoiceComment(A, text));
  const back = await viaApi('supplierInvoiceComments', () => api.supplierInvoiceComments(A));
  const stored = back.ok ? back.value.find((c) => c.startsWith(`L${length}:`)) : undefined;
  note(`${length}-char comment: ${added.ok ? 'accepted' : `refused (${added.error})`}; stored ${stored === undefined ? 'nothing' : `${stored.length} chars${stored === text ? ', unchanged' : ', CHANGED'}`}`);
  if (!added.ok) break;
}
await viaApi('addSupplierInvoiceComment', () => api.addSupplierInvoiceComment(D, 'Mätning: kommentar på makulerad faktura'));
if (B !== null) await viaApi('addSupplierInvoiceComment', () => api.addSupplierInvoiceComment(B, 'Mätning: kommentar på obokad faktura'));

// ---------------------------------------------------------------------------
// 5. Question 4: the writes with a token minted for `supplierinvoice` alone.
// ---------------------------------------------------------------------------
step = '5 scopes';
const narrow = new FortnoxApi(connectionFor(recording('supplierinvoice')));
via = 'FortnoxApi.accessToken';
await narrow.accessToken().catch((err: unknown) => note(`narrow mint failed: ${String(err)}`));
via = 'direct';
note(`full consent token scope: ${calls.find((c) => c.path === '/oauth-v1/token' && c.step === '0 guard')?.response ?? '(not recorded)'}`);
note(`narrow token scope: ${calls.filter((c) => c.path === '/oauth-v1/token').at(-1)?.response ?? '(not recorded)'}`);
const narrowOutcomes = {
  supplierInvoice: await viaApi('supplierInvoice', () => narrow.supplierInvoice(E)),
  block: await viaApi('setSupplierInvoicePaymentBlock', () => narrow.setSupplierInvoicePaymentBlock(E, true)),
  bookUnattested: await viaApi('bookSupplierInvoice', () => narrow.bookSupplierInvoice(E)),
  attest: await attest(E, narrow).then((r) => (r.status < 300 ? { ok: true as const, value: r.status } : { ok: false as const, error: `${r.status} ${JSON.stringify(r.json)}` })),
  book: await viaApi('bookSupplierInvoice', () => narrow.bookSupplierInvoice(E)),
  release: await viaApi('setSupplierInvoicePaymentBlock', () => narrow.setSupplierInvoicePaymentBlock(E, false)),
  comment: await viaApi('addSupplierInvoiceComment', () => narrow.addSupplierInvoiceComment(E, 'Mätning: bara supplierinvoice')),
  comments: await viaApi('supplierInvoiceComments', () => narrow.supplierInvoiceComments(E)),
  companyInformation: await viaApi('companyInformation', () => narrow.companyInformation()),
};
for (const [name, outcome] of Object.entries(narrowOutcomes)) {
  note(`supplierinvoice-only ${name}: ${outcome.ok ? 'ok' : `refused (${outcome.error})`}`);
}

// ---------------------------------------------------------------------------
// 5b. Can an unbooked invoice be paid? Registering a payment is the API's half of the question;
//     a payment file or a bank-integration run is the UI's, and is left to a person.
// ---------------------------------------------------------------------------
step = '5b payment of an unbooked invoice';
await viaApi('setSupplierInvoicePaymentBlock', () => api.setSupplierInvoicePaymentBlock(I, true));
for (const [label, givenNumber] of [['H unbooked', H], ['I unbooked and blocked', I]] as const) {
  const paid = await direct('POST', '/supplierinvoicepayments', {
    SupplierInvoicePayment: { InvoiceNumber: Number(givenNumber), Amount: 125, PaymentDate: today },
  });
  const after = await snapshot(givenNumber);
  note(`${label}: payment registration ${paid.status}; after it Booked=${JSON.stringify(after['Booked'])} Balance=${JSON.stringify(after['Balance'])}`);
}

// ---------------------------------------------------------------------------
// 6. Question 5: what the list holds.
// ---------------------------------------------------------------------------
step = '6 list';
const listed = await direct('GET', '/supplierinvoices?limit=500');
const entries = (listed.json?.SupplierInvoices ?? []) as Record<string, unknown>[];
note(`GET /supplierinvoices: ${entries.length} entries; fields per entry: ${JSON.stringify(Object.keys(entries[0] ?? {}))}`);
for (const filter of ['unbooked', 'cancelled', 'authorizepending']) {
  const filtered = await direct('GET', `/supplierinvoices?filter=${filter}&limit=500`);
  note(`filter=${filter}: ${filtered.status} ${JSON.stringify(((filtered.json?.SupplierInvoices ?? []) as { GivenNumber: string }[]).map((i) => i.GivenNumber))}`);
}
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 16).replace('T', ' ');
const since = await viaApi('supplierInvoicesModifiedSince', () => api.supplierInvoicesModifiedSince(yesterday));
note(`supplierInvoicesModifiedSince(${yesterday}): ${JSON.stringify(since)}`);
if (B !== null) note(`B (no cost account) is ${entries.some((e) => String(e['GivenNumber']) === B) ? '' : 'NOT '}in the list`);

// ---------------------------------------------------------------------------
// 7. The connector's own write-back, end to end, on F. Nothing real is bound: a throwaway host.
// ---------------------------------------------------------------------------
step = '7 end to end';
const dir = mkdtempSync(join(tmpdir(), 'substrat-fortnox-measure-'));
const hostFetch = recording();
const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(7)), fetch: hostFetch });
try {
  host.registerModule(measuring);
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const conn = connectionId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
  await host.admin.grantEntitlement(staff, t, 'ledger');
  await host.provisionScope(staff, { tenantId: t, scopeId: s, jurisdiction: 'eu', vertical: 'measure' });
  await host.admin.activateScope(staff, t, s);
  await host.admin.createConnection(staff, { id: conn, tenantId: t, vertical: 'measure', provider: 'fortnox', label: 'sandbox', secret });
  await host.admin.grantToConnection(staff, { connectionId: conn, permission: RECORD, node: { tenantId: t, scopeId: s }, grantedBy: staff });
  await bindFortnoxScope(host, {
    connectionId: conn, tenantId: t, scopeId: s, vertical: 'measure', operation: 'invoices/record', permission: RECORD,
    kind: 'supplier-invoice', firstPass: 1, writeback: { read: 'invoices/writeback', record: 'invoices/writeback-record' },
  });
  const binding = async () => (await listFortnoxBindings(host, conn))[0]!;
  const pass = async (label: string, answer: FortnoxInvoiceWriteback): Promise<void> => {
    step = `7 end to end: ${label}`;
    waiting = answer;
    const from = calls.length;
    via = 'syncFortnoxSupplierInvoices';
    const result = await syncFortnoxSupplierInvoices(host, conn, await binding(), { fetch: hostFetch }).then(
      (r) => JSON.stringify(r),
      (err: unknown) => `threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    via = 'direct';
    const writes = calls.slice(from).filter((c) => c.method !== 'GET' && c.path !== '/oauth-v1/token');
    note(`result ${result}`);
    note(`writes, in order: ${JSON.stringify(writes.map((c) => `${c.method} ${c.path} → ${c.status}`))}`);
  };
  const decided = (n: string) => ({ key: `measure-${n}`, givenNumber: n, book: true, release: true, comment: `Mätning: faktura ${n} godkänd av styrelsen` });
  const state = async (n: string) => {
    const x = await snapshot(n);
    note(`${n} now: Booked=${JSON.stringify(x['Booked'])} DisablePaymentFile=${JSON.stringify(x['DisablePaymentFile'])} CommentLog=${JSON.stringify((x['CommentLog'] as { Comment: string }[] | undefined)?.map((c) => c.Comment))}`);
  };

  // G: attested before the board decides, so nothing in Fortnox is in the way.
  await attest(G);
  await pass(`G pass 1, held and decided in one answer`, { hold: [{ givenNumber: G }], decisions: [decided(G)] });
  note(`receipts: ${JSON.stringify(receipts.splice(0))}`);
  await pass(`G pass 2, the same decision again (a receipt that did not land)`, { hold: [], decisions: [decided(G)] });
  note(`receipts: ${JSON.stringify(receipts.splice(0))}`);
  await state(G);

  // F: nobody approved it. In a company that requires approval, the decision approves it.
  await pass(`F pass 1, not approved, held and decided`, { hold: [{ givenNumber: F }], decisions: [decided(F)] });
  note(`receipts: ${JSON.stringify(receipts.splice(0))}`);
  await pass(`F pass 2, the same decision again (a receipt that did not land)`, { hold: [], decisions: [decided(F)] });
  note(`receipts: ${JSON.stringify(receipts.splice(0))}`);
  await state(F);
} finally {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
}
