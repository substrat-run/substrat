import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { globalFetch } from '@substrat-run/kernel';
import { BolagsverketApi } from '../src/api.js';
import type { BolagsverketCredential, BolagsverketEnvironment } from '../src/config.js';
import { organisationValidation } from '../src/organisation.js';

/**
 * The real thing: Bolagsverket's API, the acceptance environment unless
 * `BOLAGSVERKET_ENV=prod` says otherwise.
 *
 * Runs ONLY when `secrets/connectors.env` (or this package's `.dev.vars`, both gitignored)
 * or the environment holds `BOLAGSVERKET_CLIENT_ID` and `BOLAGSVERKET_CLIENT_SECRET`, so
 * CI skips it. It is the suite that turns the fixture suite's shapes, read from community
 * clients rather than recorded, into checked ones:
 *
 * 1. the token URL, the scope string and the form body mint a token;
 * 2. the API base and `GET /isalive` answer;
 * 3. `POST /organisationer` takes `{ identitetsbeteckning }` and answers the shape
 *    `rawOrganisation` parses — the result is logged, so a field read as `null` because the
 *    provider names it differently is visible.
 *
 * Read-only: every lookup is of a public register entry, and nothing is written.
 */

const dir = dirname(fileURLToPath(import.meta.url));

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && m[2] !== '') out[m[1]!] = m[2]!;
  }
  return out;
}

const env: Record<string, string | undefined> = {
  ...parseEnvFile(join(dir, '..', '..', '..', 'secrets', 'connectors.env')),
  ...parseEnvFile(join(dir, '..', '.dev.vars')),
  ...process.env,
};

const credential: BolagsverketCredential | null =
  env.BOLAGSVERKET_CLIENT_ID && env.BOLAGSVERKET_CLIENT_SECRET
    ? { clientId: env.BOLAGSVERKET_CLIENT_ID, clientSecret: env.BOLAGSVERKET_CLIENT_SECRET }
    : null;

const environment: BolagsverketEnvironment = env.BOLAGSVERKET_ENV === 'prod' ? 'prod' : 'test';
/** A register entry to look up; the acceptance environment's data may differ from production's. */
const orgnr = env.BOLAGSVERKET_TEST_ORGNR ?? '5560125790';

describe.skipIf(credential === null)('bolagsverket connector — live', () => {
  const api = () =>
    new BolagsverketApi(
      credential!,
      // `globalFetch`, never the bare global: workerd refuses the bare one called as a
      // method (`lint:bound-fetch`, #1291).
      (input, init) => globalFetch(input, { ...init, signal: AbortSignal.timeout(30_000) }),
      {
        environment,
        tokenUrl: env.BOLAGSVERKET_TOKEN_URL,
        apiBase: env.BOLAGSVERKET_API_BASE,
      },
    );

  it('mints a token and pings', async () => {
    await api().ping();
  });

  it('looks an organisation up and the answer parses', async () => {
    const result = await api().validateOrganisation(orgnr);
    console.log(`bolagsverket (${environment}): ${JSON.stringify(result, null, 2)}`);
    expect(organisationValidation.parse(result)).toEqual(result);
    if (result.exists) expect(result.name).not.toBeNull();
  });
});
