/**
 * Put bookkeeping into a Fortnox SANDBOX, so the live suite has something to read.
 *
 * ## Why this exists
 *
 * A fresh test environment has no financial year and no vouchers, and three of the five
 * live tests then fail on absent data rather than on a defect — which is the worst kind
 * of red, because it trains you to ignore the suite. Worse, the assertions that matter
 * most never run at all: the charset check and the double-entry check both need a real
 * SIE export with real Swedish account names in it. An empty sandbox lets a broken
 * decoder pass, which is exactly what happened before 2026-09-03.
 *
 * ## Why it is a script and not part of the suite
 *
 * `test/live.test.ts` is READ-ONLY against Fortnox, deliberately and prominently, so it
 * is safe to point at a production company. Writing from inside it would quietly destroy
 * that property. So the writing lives here, is run on purpose, and refuses to touch
 * anything that does not look like a sandbox.
 *
 * ## The guard
 *
 * Fortnox gives every test environment the organisation number `555555-5555`. This
 * script reads `/3/companyinformation` first and REFUSES to write unless it sees that
 * number. `--force` overrides it, and exists only so the refusal is a decision rather
 * than a wall — but a real company's books are not a fixture, and the default says so.
 *
 * Usage, from the repo root:
 *
 *   pnpm fortnox:seed              # ensure a year + vouchers exist
 *   pnpm fortnox:seed --year=2026  # a specific year
 *   pnpm fortnox:seed --force      # write to a company that is not a sandbox
 *
 * Credentials come from `secrets/connectors.env`, the same file the live suite reads.
 * Harness code — `node:*` is fine here, and `scripts/` ships in no `dist`.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectionId } from '@substrat-run/contracts';
import type { ConnectorConnection } from '@substrat-run/kernel';
import { FortnoxApi, FORTNOX_API_BASE, type FortnoxSecret } from '../src/api.js';
import { financialYearFor } from '../src/aggregate.js';
import { loadDevSecrets, providerEnv } from './dev-secrets.mjs';

const PKG = dirname(fileURLToPath(import.meta.url));

/** Fortnox stamps every sandbox with this organisation number. */
const SANDBOX_ORGNR = '555555-5555';

const flag = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const env = {
  ...loadDevSecrets(join(PKG, '..', '..', '..', 'secrets', 'connectors.env'), join(PKG, '..', '.dev.vars')),
  ...providerEnv('FORTNOX_'),
};

const { FORTNOX_CLIENT_ID, FORTNOX_CLIENT_SECRET, FORTNOX_TENANT_ID } = env;
if (!FORTNOX_CLIENT_ID || !FORTNOX_CLIENT_SECRET || !FORTNOX_TENANT_ID) {
  console.error(
    'fortnox:seed: need FORTNOX_CLIENT_ID / FORTNOX_CLIENT_SECRET / FORTNOX_TENANT_ID\n' +
      '  in secrets/connectors.env (run `pnpm fortnox:connect` for the tenant id).',
  );
  process.exit(2);
}

const secret: FortnoxSecret = {
  clientId: FORTNOX_CLIENT_ID,
  clientSecret: FORTNOX_CLIENT_SECRET,
  tenantId: FORTNOX_TENANT_ID,
};

const connection: ConnectorConnection = {
  id: connectionId.parse('00000000000000000000000000'),
  tenantId: '',
  vertical: '',
  provider: 'fortnox',
  secret,
  expiresAt: null,
  fetch: (input, init) => fetch(input, init as RequestInit) as never,
};

const api = new FortnoxApi(connection);

/** A JSON call against the REST host, authenticated with the connector's own token. */
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await api.accessToken();
  const res = await fetch(`${FORTNOX_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} failed (HTTP ${res.status}): ${text}`);
  return (text === '' ? {} : JSON.parse(text)) as T;
}

const year = Number(flag('year') ?? new Date().getFullYear());

// ---------------------------------------------------------------------------
// 1. Prove what we are about to write into.
// ---------------------------------------------------------------------------
const company = await api.companyInformation();
console.log(`company : ${company.CompanyName || '(unnamed)'} — org ${company.OrganizationNumber || '—'}`);
console.log(`tenant  : ${secret.tenantId}\n`);

if (company.OrganizationNumber !== SANDBOX_ORGNR && !has('force')) {
  console.error(
    `fortnox:seed: REFUSING — org number is ${company.OrganizationNumber || '(none)'}, not a sandbox.\n` +
      `  Fortnox stamps every test environment ${SANDBOX_ORGNR}. This script WRITES vouchers,\n` +
      `  and a real company's books are not a fixture. Pass --force only if you mean it.`,
  );
  process.exit(1);
}

const VOUCHERS = [
  { month: '01', day: '15', text: 'Substrat seed – försäljning', net: 1000, vat: 250 },
  { month: '02', day: '08', text: 'Substrat seed – försäljning', net: 2400, vat: 600 },
  { month: '03', day: '22', text: 'Substrat seed – försäljning', net: 800, vat: 200 },
  { month: '05', day: '03', text: 'Substrat seed – försäljning', net: 3125, vat: 781.25 },
];


// ---------------------------------------------------------------------------
// 2. A financial year, if there is none covering the target year.
// ---------------------------------------------------------------------------
interface FinancialYearRow {
  Id: number;
  FromDate: string;
  ToDate: string;
}

// The dates this seed will post to. Derived from VOUCHERS rather than assumed to be
// 1 Jan–31 Dec, because the year we need is the one that COVERS these.
const seedFrom = `${year}-${VOUCHERS[0]!.month}-${VOUCHERS[0]!.day}`;
const seedTo = `${year}-${VOUCHERS[VOUCHERS.length - 1]!.month}-${VOUCHERS[VOUCHERS.length - 1]!.day}`;

let years = await api.financialYears();

// Overlap, not `FromDate.startsWith(year)` — and the connector already owns this rule,
// so use it rather than a second, weaker copy. A broken financial year (1 July–30 June)
// covers the seed dates while STARTING in the previous calendar year: a prefix match
// misses it and then tries to create a 1 Jan–31 Dec year on top of it. Fortnox keeps
// financial years sequential and non-overlapping, so that either fails outright or
// seeds into a different year than the live suite will read.
let target = financialYearFor(years, { from: seedFrom, to: seedTo });

if (target === null) {
  // The account chart name is NOT free text and NOT stable across years: Fortnox
  // rejects an unknown one with "Vald kontoplan existerar inte." So ask which ones
  // exist rather than hard-coding "Bas 2026" and breaking every January.
  const charts = await call<{ AccountCharts: { Name: string }[] }>('GET', '/accountcharts');
  const chart =
    charts.AccountCharts.find((c) => c.Name === `Bas ${year}`)?.Name ??
    charts.AccountCharts.find((c) => c.Name.startsWith('Bas '))?.Name;
  if (chart === undefined) throw new Error(`no BAS account chart offered: ${JSON.stringify(charts)}`);

  console.log(`→ no financial year covers ${seedFrom}..${seedTo}; creating ${year} on "${chart}"`);
  const created = await call<{ FinancialYear: FinancialYearRow }>('POST', '/financialyears', {
    FinancialYear: {
      FromDate: `${year}-01-01`,
      ToDate: `${year}-12-31`,
      AccountChartType: chart,
    },
  });
  console.log(`  ✓ financial year Id ${created.FinancialYear.Id}`);
  years = await api.financialYears();
  target = financialYearFor(years, { from: seedFrom, to: seedTo });
} else {
  console.log(`→ financial year ${target.FromDate}..${target.ToDate} covers the seed dates (Id ${target.Id})`);
}

if (target === null) throw new Error(`no financial year covers ${seedFrom}..${seedTo} after creation`);

// ---------------------------------------------------------------------------
// 3. Vouchers — spread across months, and balanced.
// ---------------------------------------------------------------------------
//
// Several months on purpose: `summarizeLedger` buckets by month, so a single-month
// ledger cannot tell a working grouping from one that drops the month entirely.
// Every voucher balances to zero, because that is what the live suite asserts and a
// deliberately unbalanced fixture would make a real parser bug indistinguishable.
const existing = await call<{ Vouchers?: { Description?: string; TransactionDate?: string }[] }>(
  'GET',
  `/vouchers?financialyear=${target.Id}`,
);

// Matched by (date, description), not counted. A count assumes the vouchers that exist
// are a PREFIX of the ones we want: delete January and the count says 3, which posts May
// a second time and leaves January missing. Fortnox returns `TransactionDate` in the list
// response (verified against the live API), so identity is available without a fetch per
// voucher.
const present = new Set(
  (existing.Vouchers ?? [])
    .filter((v) => (v.Description ?? '').startsWith('Substrat seed'))
    .map((v) => `${v.TransactionDate ?? ''}|${v.Description ?? ''}`),
);

const missing = VOUCHERS.filter(
  (v) => !present.has(`${year}-${v.month}-${v.day}|${v.text}`),
);

if (missing.length === 0) {
  console.log(`→ all ${VOUCHERS.length} seed voucher(s) already present — nothing to write`);
} else {
  for (const v of missing) {
    // 1930 bank / 3001 sales / 2611 output VAT — the accounts a BAS chart always has.
    await call('POST', '/vouchers', {
      Voucher: {
        Description: v.text,
        TransactionDate: `${year}-${v.month}-${v.day}`,
        VoucherSeries: 'A',
        VoucherRows: [
          { Account: 1930, Debit: v.net + v.vat },
          { Account: 3001, Credit: v.net },
          { Account: 2611, Credit: v.vat },
        ],
      },
    });
    console.log(`  ✓ ${year}-${v.month}-${v.day}  ${v.net + v.vat} kr`);
  }
}

// ---------------------------------------------------------------------------
// 4. Prove the export the live suite actually reads.
// ---------------------------------------------------------------------------
const sie = await api.sieFile(target.Id);
const accounts = (sie.match(/^#KONTO /gm) ?? []).length;
const swedish = /[åäöÅÄÖ]/.test(sie);
console.log(`\nSIE4: ${sie.length} chars, ${accounts} accounts, Swedish letters ${swedish ? 'OK' : 'MISSING'}`);
if (!swedish) {
  // Not a seeding failure — a decoding one, and the whole reason this data exists.
  console.error('  ✗ no å/ä/ö in the export: the charset handling is wrong again.');
  process.exit(1);
}
console.log('\nReady. Run: pnpm --filter @substrat-run/connector-fortnox test');
