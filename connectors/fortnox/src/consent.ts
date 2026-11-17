import { connectionConsent, instant, type ConnectionConsent, type ConnectionId } from '@substrat-run/contracts';
import type { HostAdmin } from '@substrat-run/kernel';
import type { FortnoxApi } from './api.js';

/**
 * What the company's consent covers, apart from whether the credential works (#2422).
 *
 * A Fortnox consent fixes its scopes: a company approves a set once, and widening it takes a new
 * consent round. So a company that consented before the platform asked for `supplierinvoice`,
 * `archive` or `connectfile` holds a credential that mints and reads its books perfectly well, and
 * answers `403` to the first read outside its set. Classed with a bad key, that `403` made a
 * connection that only needed a new consent look refused. The token mint names the granted scopes
 * every time, so the connector compares them before it reads, and says "needs re-consent".
 */

/**
 * The scopes the platform's Connect asks for. `bookkeeping` is what the ledger reads,
 * `companyinformation` names the company, `supplierinvoice` reads and writes supplier invoices,
 * and an invoice's file takes `connectfile` (the connection) and `archive` (the bytes). A
 * deployment that asks for another set passes it as `consentScopes`.
 */
export const FORTNOX_CONSENT_SCOPES: readonly string[] = [
  'bookkeeping',
  'companyinformation',
  'supplierinvoice',
  'archive',
  'connectfile',
];

/** What a ledger binding reads: financial years and the SIE export. */
export const FORTNOX_LEDGER_SCOPES: readonly string[] = ['bookkeeping'];
/** What a supplier-invoice binding cannot land without: the invoices, and the company it names on each page. */
export const FORTNOX_INVOICE_SCOPES: readonly string[] = ['supplierinvoice', 'companyinformation'];
/** What an invoice's files need. Without them the invoices still land, and the files wait. */
export const FORTNOX_INVOICE_FILE_SCOPES: readonly string[] = ['connectfile', 'archive'];

/**
 * A read this consent does not cover. Not a refused credential: the keys work, and the company's
 * Fortnox administrator approving the platform's Connect again is the whole repair.
 */
export class FortnoxConsentShortfall extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[], what: string) {
    super(needsReconsent(missing, what));
    this.name = 'FortnoxConsentShortfall';
    this.missing = missing;
  }
}

/** The sentence every shortfall is reported in, so a sweep row and a probe say the same thing. */
export function needsReconsent(missing: readonly string[], what: string): string {
  const list = missing.join(', ');
  return (
    `needs re-consent: the company's Fortnox consent does not cover the ${list} scope${missing.length === 1 ? '' : 's'} ` +
    `${what} needs. The credential works; connect the company again (Re-consent) so its Fortnox administrator approves them.`
  );
}

/** Throw a {@link FortnoxConsentShortfall} when the consent lacks any of `wanted`. Unknown grants pass. */
export async function requireFortnoxScopes(api: FortnoxApi, wanted: readonly string[], what: string): Promise<void> {
  const missing = await api.lacks(wanted);
  if (missing.length > 0) throw new FortnoxConsentShortfall(missing, what);
}

const CONSENT_KEY = 'fortnox:consent';

/** The consent as the mint reports it, against what the platform asks for; `null` when Fortnox names nothing. */
export async function fortnoxConsentOf(
  api: FortnoxApi,
  consentScopes: readonly string[],
  at: string,
): Promise<ConnectionConsent | null> {
  const granted = await api.grantedScopes();
  if (granted === null) return null;
  return { granted, missing: consentScopes.filter((s) => !granted.includes(s)), checkedAt: instant.parse(at) };
}

/**
 * Record what the consent covers, against the connection — the state a console reads back
 * ({@link readFortnoxConsent}). Written only when the answer changed, so a sweep pass that finds
 * the same grant writes nothing; `checkedAt` is then when the grant was last seen to change.
 * `always` rewrites it anyway: a probe a person asked for is a fresh check.
 */
export async function recordFortnoxConsent(
  admin: HostAdmin,
  connectionId: ConnectionId,
  consent: ConnectionConsent,
  always = false,
): Promise<void> {
  if (!always) {
    const held = await readFortnoxConsent(admin, connectionId);
    if (held && same(held.granted, consent.granted) && same(held.missing, consent.missing)) return;
  }
  await admin.putConnectorState(connectionId, CONSENT_KEY, consent);
}

/** The consent last recorded for a connection, or `null` when none was (or it does not parse). */
export async function readFortnoxConsent(admin: HostAdmin, connectionId: ConnectionId): Promise<ConnectionConsent | null> {
  const parsed = connectionConsent.safeParse(await admin.getConnectorState(connectionId, CONSENT_KEY));
  return parsed.success ? parsed.data : null;
}

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
