import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectionId } from '@substrat-run/contracts';
import { globalFetch, type ConnectorConnection } from '@substrat-run/kernel';
import { PlanimaApi, type PlanimaSecret } from '../src/api.js';
import { actionFactIn, facilityFact } from '../src/plan.js';

/**
 * The real thing — this talks to `api.planima.se`.
 *
 * It runs ONLY when `secrets/connectors.env` (or this package's `.dev.vars`, both
 * gitignored) or `PLANIMA_TOKEN` in the environment holds a token, so CI without
 * secrets skips it and a local run against a real account exercises the actual API.
 * This is the test that turns "ready to check against reality" into "checked" — the
 * mock's whole limitation is that it is the author's reading of the docs on both sides
 * of the call, so mock and reader can agree with each other while both disagree with
 * Planima. That is exactly how `connector-fortnox` shipped a wrong charset.
 *
 * **Read-only, and structurally so.** Every call here is a GET, and this connector has
 * no write path to Planima at all — which is what makes running it against a real
 * account acceptable. There is nothing to clean up because nothing is created.
 *
 * What it proves, and what only a live call can:
 *
 * 1. **The bare `Authorization` token actually authenticates.** No `Bearer` prefix is
 *    the single most likely thing to be wrong, and it fails identically to a bad token.
 * 2. **`Accept: application/vnd.planima.v1+json` is accepted**, rather than 406'd by a
 *    server that wants a different spelling.
 * 3. **The `page[limit]` / `page[offset]` walk really pages**, and `pagination` comes
 *    back in the envelope the walk is driven by.
 * 4. **The documented shapes are the sent shapes** — especially which fields arrive as
 *    an explicit `null`, which is the distinction a schema gets wrong silently.
 * 5. **Prices are numbers that survive the decimal conversion.** A real plan has öre and
 *    seven-figure totals; the mock's fixtures are the author's guess at both.
 */

const dir = dirname(fileURLToPath(import.meta.url));

/** Parse a flat `KEY=value` env file. Blank values are treated as absent. */
function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && m[2] !== '') out[m[1]!] = m[2]!;
  }
  return out;
}

/**
 * The token, from the shared connector secrets file, this package's own `.dev.vars`, or
 * the environment — in that order of increasing precedence.
 *
 * `secrets/connectors.env` is the canonical home and is deliberately NOT
 * `secrets/platform.<env>.env`: the latter is a push map whose every key is uploaded to
 * the deployed workers, and a provider credential must never take that path. A
 * connection's credential belongs sealed in the directory, opened per (tenant,
 * vertical, provider).
 */
function loadSecret(): PlanimaSecret | null {
  const env = {
    ...parseEnvFile(join(dir, '..', '..', '..', 'secrets', 'connectors.env')),
    ...parseEnvFile(join(dir, '..', '.dev.vars')),
    ...(typeof process !== 'undefined' ? (process.env as Record<string, string | undefined>) : {}),
  };
  const token = env.PLANIMA_TOKEN;
  return token ? { token } : null;
}

const secret = loadSecret();
const base = process.env.PLANIMA_API_BASE;

const connection = (): ConnectorConnection => ({
  id: connectionId.parse('00000000000000000000000000'),
  tenantId: '',
  vertical: '',
  provider: 'planima',
  secret: secret!,
  expiresAt: null,
  // `globalFetch` from the kernel, never the bare global. workerd throws
  // `Illegal invocation` when a connector calls the bare global as `obj.fetch(…)`, and
  // `lint:bound-fetch` is what keeps that from shipping green (#1291).
  fetch: (input, init) => globalFetch(input, { ...init, signal: AbortSignal.timeout(30_000) }),
});

describe.skipIf(secret === null)('planima connector — live', () => {
  const api = () => new PlanimaApi(connection(), base ? { apiBase: base } : undefined);

  it('authenticates with a bare token and lists organizations', async () => {
    const organizations = await api().organizations();
    // An empty list is a legitimate answer for a token whose user was given no access,
    // and it is a different fact from a 401 — so this asserts the CALL succeeded, and
    // reports what came back rather than demanding it be non-empty.
    expect(Array.isArray(organizations)).toBe(true);
    console.log(`planima: ${organizations.length} organization(s): ${organizations.map((o) => o.name).join(', ')}`);
    for (const o of organizations) {
      expect(typeof o.id).toBe('number');
      expect(typeof o.name).toBe('string');
    }
  });

  it('reads a facility and converts its plan without losing a price', async () => {
    const client = api();
    const facilities = await client.facilities();
    if (facilities.length === 0) {
      console.log('planima: the token sees no facilities — nothing further to check');
      return;
    }
    const facility = facilities[0]!;
    // The conversion is the assertion: `facilityFact` and `actionFactIn` throw on a
    // number they cannot represent exactly, so a live plan that survives them is a live
    // plan the seam schemas will accept.
    expect(() => facilityFact(facility)).not.toThrow();

    const year = new Date().getUTCFullYear();
    const actions = await client.actions(facility.id, { fromYear: year, toYear: year + 10 });
    console.log(`planima: facility "${facility.name}" — ${actions.length} action(s) in ${year}..${year + 10}`);
    for (const action of actions) {
      const fact = actionFactIn(action, facility.id, 'SEK');
      expect(fact.facilityId).toBe(facility.id);
      expect(typeof fact.status).toBe('string');
      // Whatever arrived is representable as exact decimal money. A float Planima can
      // send and this cannot express is the failure mode worth catching live.
      if (fact.totalPrice) expect(fact.totalPrice.amount).toMatch(/^-?\d+(\.\d{1,6})?$/);
    }
  });

  it('pages a list rather than stopping at the first 50', async () => {
    // Only meaningful on an account with more than one page of anything; on a smaller
    // one this still proves the pagination envelope parses, which is half the claim.
    const client = api();
    const facilities = await client.facilities();
    if (facilities.length === 0) return;
    const components = await client.components(facilities[0]!.id);
    console.log(`planima: facility ${facilities[0]!.id} — ${components.length} component(s)`);
    // Ids are unique, so a walk that re-read the same page would show duplicates.
    expect(new Set(components.map((c) => c.id)).size).toBe(components.length);
  });
});
