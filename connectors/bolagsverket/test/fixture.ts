import type { BolagsverketApiOptions } from '../src/api.js';
import type { Fetch } from '../src/token.js';

/**
 * Provider answers for the fixture suite. **Not recorded**: no credential exists yet, so
 * these follow the response shape community client libraries read from
 * `POST /organisationer`, filled with placeholder data. The live suite is what checks the
 * shape against Bolagsverket; when it disagrees, these are corrected from its log.
 */
export const ACTIVE = {
  organisationer: [
    {
      organisationsidentitet: { identitetsbeteckning: '5560000001', typ: { kod: 'ORGNR', klartext: 'Organisationsnummer' } },
      organisationsnamn: {
        organisationsnamnLista: [
          { namn: 'Exempel Särskilt Firmanamn', organisationsnamntyp: { kod: 'SARSKILT_FORETAGSNAMN', klartext: 'Särskilt företagsnamn' } },
          { namn: 'Exempelbolaget Ö AB', organisationsnamntyp: { kod: 'FORETAGSNAMN', klartext: 'Företagsnamn' } },
        ],
      },
      juridiskForm: { kod: '49', klartext: 'Övriga aktiebolag' },
      organisationsform: { kod: 'AB', klartext: 'Aktiebolag' },
      organisationsdatum: { registreringsdatum: '1999-04-01' },
      avregistreradOrganisation: null,
      pagandeAvvecklingsEllerOmstruktureringsforfarande: null,
      naringsgrenOrganisation: {
        sni: [
          { kod: '62010', klartext: 'Dataprogrammering' },
          { kod: '', klartext: '' },
        ],
      },
      postadressOrganisation: {
        postadress: { utdelningsadress: 'Exempelgatan 1', postnummer: '11122', postort: 'STOCKHOLM', land: null },
      },
      // A field this connector does not read, to hold that extras are ignored.
      verksamhetsbeskrivning: { beskrivning: 'Exempelverksamhet.' },
    },
  ],
};

const withEntry = (patch: Record<string, unknown>) => ({
  organisationer: [{ ...ACTIVE.organisationer[0], ...patch }],
});

export const DEREGISTERED = withEntry({
  avregistreradOrganisation: { avregistreringsdatum: '2021-06-30' },
  avregistreringsorsak: { kod: 'FUS', klartext: 'Fusion' },
});

export const BANKRUPT = withEntry({
  pagandeAvvecklingsEllerOmstruktureringsforfarande: {
    pagandeAvvecklingsEllerOmstruktureringsforfarandeLista: [{ kod: 'KK', klartext: 'Konkurs inledd' }],
  },
});

export const TOKEN = { access_token: 'placeholder-token', token_type: 'Bearer', expires_in: 3600 };

export const TOKEN_URL = 'https://token.invalid/oauth2/token';
export const API_BASE = 'https://api.invalid/vardefulla-datamangder/v1';

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/**
 * A scripted `fetch`: token requests always succeed unless `token` is given, and API
 * requests take the next scripted reply. Every call is recorded.
 */
export function fakeFetch(api: Reply[], token: Reply = { status: 200, body: TOKEN }) {
  const calls: { url: string; init?: Parameters<Fetch>[1] }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    const reply = url === TOKEN_URL ? token : api.shift();
    if (!reply) throw new Error(`unscripted request ${url}`);
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => text,
      json: async () => JSON.parse(text),
      arrayBuffer: async () => new ArrayBuffer(0),
      body: null,
      headers: { get: (name: string) => reply.headers?.[name] ?? null },
    };
  };
  return { fetch, calls, apiCalls: () => calls.filter((c) => c.url !== TOKEN_URL) };
}

/** A clock the throttle and the token cache read, advanced by every `sleep`. */
export function manualTime(startMs = Date.UTC(2026, 10, 4, 9, 0, 0)) {
  let t = startMs;
  const slept: number[] = [];
  const options: BolagsverketApiOptions = {
    tokenUrl: TOKEN_URL,
    apiBase: API_BASE,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
  };
  return { options, slept, advance: (ms: number) => (t += ms) };
}

export const CREDENTIAL = { clientId: 'placeholder-client', clientSecret: 'placeholder-secret' };
