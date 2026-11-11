/**
 * The one check every script that WRITES to Fortnox makes before its first write.
 *
 * Fortnox gives every test environment the organisation number `555555-5555`. A script
 * reads `/3/companyinformation` and refuses to write unless it sees that number, because a
 * real company's books are not a fixture. `pnpm fortnox:seed` and
 * `pnpm fortnox:measure-writeback` share this function, so there is one check, not two.
 */
import type { FortnoxApi, FortnoxCompany } from '../src/api.js';

/** Fortnox stamps every sandbox with this organisation number. */
export const SANDBOX_ORGNR = '555555-5555';

/**
 * The company the credential points at, or a refusal (exit 1) when it is not a sandbox.
 * `force` exists only so the seed's refusal is a decision rather than a wall; a script that
 * must never write to a real company does not pass it.
 */
export async function requireSandbox(
  api: FortnoxApi,
  opts: { script: string; writes: string; force?: boolean },
): Promise<FortnoxCompany> {
  const company = await api.companyInformation();
  console.log(`company : ${company.CompanyName || '(unnamed)'} — org ${company.OrganizationNumber || '—'}`);
  if (company.OrganizationNumber === SANDBOX_ORGNR || opts.force === true) return company;
  console.error(
    `${opts.script}: REFUSING — org number is ${company.OrganizationNumber || '(none)'}, not a sandbox.\n` +
      `  Fortnox stamps every test environment ${SANDBOX_ORGNR}. This script WRITES ${opts.writes},\n` +
      `  and a real company's books are not a fixture.` +
      // Only a script that takes `--force` is told about it.
      (opts.force === false ? ' Pass --force only if you mean it.' : ''),
  );
  process.exit(1);
}
