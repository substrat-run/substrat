import type { FetchLike } from '@substrat-run/kernel';
import { PLANIMA_ACCEPT, PLANIMA_MAX_PAGE } from './api.js';

// Web-standard everywhere this runs; declared locally so the mock pulls in no platform typings.
declare const URL: new (input: string) => {
  pathname: string;
  searchParams: { get(name: string): string | null; getAll(name: string): string[] };
};

/**
 * Planima in memory — the five reads the sweep makes, enough to run the whole inbound
 * path without a provider account.
 *
 * **What a mock proves:** that our shape works — the bare-token header, the `page[…]`
 * walk, the year window, the per-facility paging, the unchanged-hash skip, the
 * rate-limit throttle. **What it cannot prove:** that our reading of Planima's API is
 * correct. The mock IS our reading. Green here means *ready to check against a real
 * account*, which is what `test/live.test.ts` does when a token is present.
 *
 * Three things it models strictly rather than conveniently, because each is a way a
 * client can be wrong while every test passes:
 *
 * 1. **The `Authorization` header must be the bare token.** A `Bearer ` prefix is a 401
 *    here, as it is at Planima — a mock that accepted both would let the prefix ship.
 * 2. **`page[limit]` is capped at 50 server-side, silently.** Asking for 500 returns 50
 *    and no error, so a client that trusts its own limit and stops after one page
 *    silently syncs a truncated plan.
 * 3. **Nullable fields are sent as explicit `null`s**, not omitted. That is the
 *    distinction that broke `connector-fortnox` against a real company: `.optional()`
 *    permits an absent key while the provider sends a present null.
 */
export interface PlanimaMockOptions {
  token?: string;
  organizations?: { id: number; name: string }[];
  facilities?: MockFacility[];
  buildings?: MockBuilding[];
  components?: MockComponent[];
  actions?: MockAction[];
  /**
   * Answer the first N requests with 429 and a `Retry-After`, then behave.
   *
   * Exists so a test can prove the client sits out a rate limit and completes, rather
   * than surfacing the provider's backpressure as a failed sweep.
   */
  rateLimitFirst?: number;
  retryAfterSeconds?: number;
}

export interface MockFacility {
  id: number;
  name: string;
  organizationId: number;
  address?: string | null;
  zip_code?: string | null;
  region?: string | null;
  tags?: string[];
  residential_area?: number | null;
  non_residential_area?: number | null;
  year_of_construction?: number | null;
  description?: string | null;
}

export interface MockBuilding {
  id: number;
  name: string;
  facility_id: number;
  address?: string | null;
  zip_code?: string | null;
  region?: string | null;
  year_of_construction?: number | null;
}

export interface MockComponent {
  id: number;
  name: string;
  facility_id: number;
  building_id?: number | null;
  component?: string | null;
  category?: string | null;
  type?: string | null;
  amount?: number | null;
  unit?: string | null;
}

export interface MockAction {
  id: number;
  name: string;
  facility_id: number;
  year: number;
  status: string;
  amount?: number | null;
  unit?: string | null;
  unit_price?: number | null;
  total_price?: number | null;
  total_price_incl_vat?: number | null;
  description?: string | null;
  investment_rate?: number | null;
  vat_rate?: number | null;
  category?: string | null;
  location?: string | null;
  building?: string | null;
  building_id?: number | null;
  component_id?: number | null;
  is_energy_saving?: boolean;
  co2_equivalent?: number | null;
  final_cost?: number | null;
  tags?: string[];
  project_id?: number | null;
}

interface MockResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): MockResponse => {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    text: async () => JSON.stringify(body),
  };
};

export class PlanimaMock {
  readonly apiBase = 'https://api.planima.test';

  private readonly token: string;
  private readonly organizations: { id: number; name: string }[];
  private readonly facilities: MockFacility[];
  private readonly buildings: MockBuilding[];
  private readonly components: MockComponent[];
  private readonly actions: MockAction[];
  private readonly retryAfterSeconds: number;

  /** Requests still to be answered with a 429, counting down. */
  private rateLimited: number;

  /** Every request path this mock served, in order — the assertion surface for paging. */
  readonly requests: string[] = [];

  constructor(options: PlanimaMockOptions = {}) {
    this.token = options.token ?? 'planima-test-token';
    this.organizations = options.organizations ?? [{ id: 1, name: 'Bostads AB Exempel' }];
    this.facilities = options.facilities ?? [];
    this.buildings = options.buildings ?? [];
    this.components = options.components ?? [];
    this.actions = options.actions ?? [];
    this.rateLimited = options.rateLimitFirst ?? 0;
    this.retryAfterSeconds = options.retryAfterSeconds ?? 1;
  }

  /** Replace one action, so a test can make the plan change between sweeps. */
  setAction(action: MockAction): void {
    const i = this.actions.findIndex((a) => a.id === action.id);
    if (i === -1) this.actions.push(action);
    else this.actions[i] = action;
  }

  /** The `fetch` a `ConnectorConnection` is built around. */
  get fetch(): FetchLike {
    return (async (input: string | { toString(): string }, init?: { headers?: Record<string, string> }) => {
      const raw = typeof input === 'string' ? input : input.toString();
      const url = new URL(raw);
      this.requests.push(raw.slice(this.apiBase.length));

      const headers = init?.headers ?? {};
      const authorization = headerOf(headers, 'authorization');
      const accept = headerOf(headers, 'accept');

      // The bare token, exactly. `Bearer <token>` is a 401 here as it is at Planima —
      // accepting both would let the prefix ship and fail on the first live call.
      if (authorization !== this.token) {
        return json(401, { error: 'Invalid API token' });
      }
      if (accept !== PLANIMA_ACCEPT) {
        return json(406, { error: `Unsupported Accept header: ${String(accept)}` });
      }
      if (this.rateLimited > 0) {
        this.rateLimited -= 1;
        return json(
          429,
          { error: 'Rate limit exceeded' },
          {
            'Retry-After': String(this.retryAfterSeconds),
            'RateLimit-Limit': '10',
            'RateLimit-Remaining': '0',
            'RateLimit-Reset': String(this.retryAfterSeconds),
          },
        );
      }

      const path = url.pathname;
      // Silently capped, as Planima's is — a client that asks for 500 gets 50 and no
      // hint that it was cut.
      const limit = Math.min(Number(url.searchParams.get('page[limit]') ?? '20') || 20, PLANIMA_MAX_PAGE);
      const offset = Number(url.searchParams.get('page[offset]') ?? '0') || 0;

      if (path === '/organizations') {
        return json(200, page(this.organizations.map(organizationRow), offset, limit));
      }
      if (path === '/facilities') {
        const organizationId = url.searchParams.get('organization_id');
        const rows = this.facilities
          .filter((f) => organizationId === null || String(f.organizationId) === organizationId)
          .map((f) => this.facilityRow(f));
        return json(200, page(rows, offset, limit));
      }
      const buildingsMatch = /^\/facilities\/(\d+)\/buildings$/.exec(path);
      if (buildingsMatch) {
        const facilityId = Number(buildingsMatch[1]);
        return json(200, page(this.buildings.filter((b) => b.facility_id === facilityId).map(buildingRow), offset, limit));
      }
      const componentsMatch = /^\/facilities\/(\d+)\/components$/.exec(path);
      if (componentsMatch) {
        const facilityId = Number(componentsMatch[1]);
        return json(200, page(this.components.filter((c) => c.facility_id === facilityId).map(componentRow), offset, limit));
      }
      if (path === '/actions') {
        const facilityId = url.searchParams.get('facility_id');
        const startYear = url.searchParams.get('start_year');
        const endYear = url.searchParams.get('end_year');
        const rows = this.actions
          .filter((a) => facilityId === null || String(a.facility_id) === facilityId)
          .filter((a) => startYear === null || a.year >= Number(startYear))
          .filter((a) => endYear === null || a.year <= Number(endYear))
          .map((a) => this.actionRow(a));
        return json(200, page(rows, offset, limit));
      }
      return json(404, { error: `No such Planima endpoint: ${path}` });
    }) as unknown as FetchLike;
  }

  private facilityRow(f: MockFacility): Record<string, unknown> {
    const organization = this.organizations.find((o) => o.id === f.organizationId);
    return {
      id: f.id,
      name: f.name,
      address: f.address ?? null,
      zip_code: f.zip_code ?? null,
      region: f.region ?? null,
      tags: f.tags ?? [],
      residential_area: f.residential_area ?? null,
      non_residential_area: f.non_residential_area ?? null,
      year_of_construction: f.year_of_construction ?? null,
      description: f.description ?? null,
      organization: organization ? organizationRow(organization) : null,
      updated_at: '2026-01-15T10:00:00Z',
      created_at: '2020-03-01T09:00:00Z',
    };
  }

  private actionRow(a: MockAction): Record<string, unknown> {
    const facility = this.facilities.find((f) => f.id === a.facility_id);
    return {
      id: a.id,
      name: a.name,
      amount: a.amount ?? null,
      unit: a.unit ?? null,
      unit_price: a.unit_price ?? null,
      total_price: a.total_price ?? null,
      total_price_incl_vat: a.total_price_incl_vat ?? null,
      year: a.year,
      status: a.status,
      description: a.description ?? null,
      investment_rate: a.investment_rate ?? null,
      vat_rate: a.vat_rate ?? null,
      category: a.category ?? null,
      location: a.location ?? null,
      building: a.building ?? null,
      building_id: a.building_id ?? null,
      component_id: a.component_id ?? null,
      is_energy_saving: a.is_energy_saving ?? false,
      co2_equivalent: a.co2_equivalent ?? null,
      final_cost: a.final_cost ?? null,
      tags: a.tags ?? [],
      facility: facility ? { id: facility.id, name: facility.name } : undefined,
      project_id: a.project_id ?? null,
      updated_at: '2026-02-01T08:30:00Z',
      created_at: '2021-06-11T12:00:00Z',
    };
  }
}

const organizationRow = (o: { id: number; name: string }): Record<string, unknown> => ({
  id: o.id,
  name: o.name,
  facilities_url: `https://api.planima.test/facilities?organization_id=${o.id}`,
  updated_at: '2026-01-02T00:00:00Z',
  created_at: '2019-01-01T00:00:00Z',
});

const buildingRow = (b: MockBuilding): Record<string, unknown> => ({
  id: b.id,
  name: b.name,
  address: b.address ?? null,
  zip_code: b.zip_code ?? null,
  region: b.region ?? null,
  year_of_construction: b.year_of_construction ?? null,
  facility_id: b.facility_id,
  updated_at: '2026-01-10T00:00:00Z',
  created_at: '2020-05-05T00:00:00Z',
});

const componentRow = (c: MockComponent): Record<string, unknown> => ({
  id: c.id,
  name: c.name,
  amount: c.amount ?? null,
  building_id: c.building_id ?? null,
  component: c.component ?? null,
  unit: c.unit ?? null,
  category: c.category ?? null,
  type: c.type ?? null,
  facility_id: c.facility_id,
  updated_at: '2026-01-12T00:00:00Z',
  created_at: '2020-05-06T00:00:00Z',
});

/** One page plus the metadata block, exactly as Planima wraps a list. */
const page = <T>(rows: T[], offset: number, limit: number): { data: T[]; pagination: unknown } => ({
  data: rows.slice(offset, offset + limit),
  pagination: { total_count: rows.length, offset, limit },
});

/** Header lookup that does not care about case, as a real one would not. */
function headerOf(headers: Record<string, string>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return v;
  }
  return undefined;
}
