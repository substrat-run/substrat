import { z } from 'zod';
import type { ConnectorConnection } from '@substrat-run/kernel';

// Web-standard everywhere this runs (Node, Workers); declared locally so the
// connector pulls in no platform typings, exactly as `connector-fortnox` does.
declare const URL: new (input: string) => {
  searchParams: { set(k: string, v: string): void; append(k: string, v: string): void };
  toString(): string;
};
// The default `sleep` only. Every caller inside the platform injects its own, and a
// test always does — this is the last-resort implementation for a plain `new
// PlanimaApi(conn)`, and it is web-standard in Node, Workers and browsers alike.
declare const setTimeout: (handler: () => void, timeout: number) => unknown;

/**
 * A thin, typed client over the Planima REST API.
 *
 * Every call goes through the connection's `fetch`, never a global one: that is what
 * gets it a timeout, an egress policy, and health recorded against the right
 * connection. Module code cannot reach any of this — boundary-lint bans `fetch`
 * outright — and a connector is host code.
 *
 * ## One host, and the two headers that are easy to get wrong
 *
 * Unlike Fortnox there is no separate OAuth origin: Planima has a single host and a
 * static token, so there is nothing to mint and nothing to refresh. What replaces that
 * complexity is two header details the docs state once and a client gets wrong
 * silently:
 *
 * 1. **`Authorization` carries the bare token** — no `Bearer` prefix. Planima's own
 *    curl example is `-H "Authorization: NotARealToken+tm6rdPsx23u+4/HiguLIFQw="`.
 *    Prefixing it is a 401 that reads exactly like a bad token.
 * 2. **`Accept: application/vnd.planima.v1+json`** pins the version. Omitting it works
 *    today — v1 is the default — and is precisely the kind of thing that breaks on the
 *    day the default moves, months after the code that omitted it was written. So it
 *    is sent on every request rather than left to the default.
 */

/** The one REST host. Everything hangs off this. */
export const PLANIMA_API_BASE = 'https://api.planima.se';

/** The version-pinning `Accept` value — sent on every request, never defaulted to. */
export const PLANIMA_ACCEPT = 'application/vnd.planima.v1+json';

/**
 * Planima's page ceiling. Asking for more is not an error — the server silently caps —
 * so the client asks for exactly this and paginates, rather than asking for a big
 * number and believing the answer is complete.
 */
export const PLANIMA_MAX_PAGE = 50;

/**
 * A Planima connection's credential — one static API token, and nothing else.
 *
 * Created by a person in Planima under *account settings → API*, and it carries
 * **that person's access level**: a token minted by a read-only user cannot write, and
 * one minted by an admin can do everything that admin can. That is a fact worth
 * stating in a credential's docs because it is the whole security model — there are no
 * scopes to narrow, so the narrowing is done by choosing which user mints the token.
 * A connector that only reads should be handed a read-only user's token, and this one
 * only reads.
 *
 * There is no refresh token and no expiry, which removes the rotation hazard entirely
 * and replaces it with a different one: a token is valid until a human revokes it in
 * Planima, so revocation is out-of-band and the first this connector hears of it is a
 * 401. {@link PlanimaApiError.refused} is what carries that distinction to the health
 * record.
 */
export const planimaSecret = z.object({
  token: z.string().min(1),
});
export type PlanimaSecret = z.infer<typeof planimaSecret>;

/**
 * A Planima API failure, with the two bits a caller actually branches on.
 *
 * `refused` means the provider said "not with this token" — a 401 or 403. Everything
 * else (a timeout, a 5xx, a parse failure) says nothing about the credential, and
 * treating it as a refusal would make a Planima outage look like every tenant's token
 * going bad at once.
 *
 * `retryAfterSeconds` is set only on a 429 and only when Planima sent the header. It is
 * the provider's own instruction, so the throttle below obeys it rather than guessing.
 */
export class PlanimaApiError extends Error {
  readonly status: number;
  readonly refused: boolean;
  readonly body: string;
  readonly retryAfterSeconds: number | null;
  constructor(message: string, status: number, body: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'PlanimaApiError';
    this.status = status;
    this.refused = status === 401 || status === 403;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Planima's error envelope. A caller wants the message from whichever shape arrived
 * rather than a bare status.
 */
function errorMessage(body: string, status: number): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const e = parsed as {
      error?: string | { message?: string };
      errors?: unknown;
      message?: string;
    };
    if (typeof e.error === 'string') return e.error;
    if (typeof e.error === 'object' && e.error !== null && typeof e.error.message === 'string') {
      return e.error.message;
    }
    if (typeof e.message === 'string') return e.message;
    if (Array.isArray(e.errors) && e.errors.length > 0) {
      return e.errors.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ');
    }
  } catch {
    // Not JSON — fall through to the raw slice, which is more use than nothing.
  }
  const slice = body.trim().slice(0, 200);
  return slice === '' ? `HTTP ${status}` : slice;
}

/**
 * `JSON.parse`, but a non-JSON body stays inside this module's error contract.
 *
 * This runs AFTER `res.ok`, which is exactly when it bites: a proxy, captive portal or
 * gateway that answers `200` with an HTML page makes a bare `JSON.parse` throw a
 * `SyntaxError`, and the caller loses `status`, `body` and `refused` — the three fields
 * {@link PlanimaApiError} exists to carry, and the ones a sweep reports and a probe
 * branches on.
 */
function asJson(body: string, what: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new PlanimaApiError(`${what} was not JSON`, 502, body);
  }
}

// ---------------------------------------------------------------------------
// Provider shapes. Extra fields are ignored; every field Planima documents as
// nullable is read as nullable, because `.optional()` alone is not enough.
// ---------------------------------------------------------------------------

/**
 * A field Planima may send as an explicit `null`.
 *
 * `.optional()` permits an ABSENT key; Planima sends the key with `null` in it for
 * anything unset — `address`, `zip_code`, `description` and most of `Action` are
 * documented that way. Both mean "not set", so both become `null`, and a caller gets
 * one case to handle instead of two.
 */
const nullableString = () =>
  z
    .union([z.string(), z.null()])
    .optional()
    .transform((v) => v ?? null);

const nullableNumber = () =>
  z
    .union([z.number(), z.null()])
    .optional()
    .transform((v) => v ?? null);

/** A list's pagination block — the cursor the walk below is driven by. */
export const planimaPagination = z.object({
  total_count: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});
export type PlanimaPagination = z.infer<typeof planimaPagination>;

export const planimaOrganization = z.object({
  id: z.number().int(),
  name: z.string(),
  updated_at: nullableString(),
  created_at: nullableString(),
});
export type PlanimaOrganization = z.infer<typeof planimaOrganization>;

export const planimaFacility = z.object({
  id: z.number().int(),
  name: z.string(),
  address: nullableString(),
  zip_code: nullableString(),
  region: nullableString(),
  tags: z.array(z.string()).default([]),
  /** Residential area (sv. BOA) in m². */
  residential_area: nullableNumber(),
  /** Non-residential area (sv. LOA) in m². */
  non_residential_area: nullableNumber(),
  year_of_construction: nullableNumber(),
  description: nullableString(),
  /**
   * The owning organization, nested by Planima on a facility read.
   *
   * Nullable AND optional, which is not belt-and-braces: `.optional()` alone permits
   * an absent key, and a provider that sends `"organization": null` — for a facility
   * whose organization the token cannot see, say — fails the parse and takes the whole
   * sweep down with it. That is the exact shape of the bug `connector-fortnox` shipped
   * against a real company, and the mock reproduces it here rather than agreeing with
   * a convenient assumption.
   */
  organization: z
    .union([planimaOrganization, z.null()])
    .optional()
    .transform((v) => v ?? null),
  updated_at: nullableString(),
  created_at: nullableString(),
});
export type PlanimaFacility = z.infer<typeof planimaFacility>;

export const planimaBuilding = z.object({
  id: z.number().int(),
  name: z.string(),
  address: nullableString(),
  zip_code: nullableString(),
  region: nullableString(),
  year_of_construction: nullableNumber(),
  facility_id: z.number().int(),
  updated_at: nullableString(),
  created_at: nullableString(),
});
export type PlanimaBuilding = z.infer<typeof planimaBuilding>;

export const planimaComponent = z.object({
  id: z.number().int(),
  name: z.string(),
  amount: nullableNumber(),
  building_id: nullableNumber(),
  /** The component DEFINITION's name — what kind of thing this is. */
  component: nullableString(),
  unit: nullableString(),
  category: nullableString(),
  /** `null` when the component has no specific type set. */
  type: nullableString(),
  facility_id: z.number().int(),
  updated_at: nullableString(),
  created_at: nullableString(),
});
export type PlanimaComponent = z.infer<typeof planimaComponent>;

/**
 * One planned maintenance action — the row a maintenance plan is actually made of.
 *
 * Every price arrives as a JSON **number**. It does not stay one: see `plan.ts`, where
 * it becomes a decimal string before it can reach a scope.
 */
export const planimaAction = z.object({
  id: z.number().int(),
  name: z.string(),
  amount: nullableNumber(),
  unit: nullableString(),
  unit_price: nullableNumber(),
  total_price: nullableNumber(),
  total_price_incl_vat: nullableNumber(),
  year: z.number().int(),
  status: z.string(),
  description: nullableString(),
  /** Fraction of the cost treated as investment, as a decimal fraction. */
  investment_rate: nullableNumber(),
  /** VAT rate as a decimal fraction (0.25 = 25 %). */
  vat_rate: nullableNumber(),
  category: nullableString(),
  location: nullableString(),
  building: nullableString(),
  building_id: nullableNumber(),
  component_id: nullableNumber(),
  is_energy_saving: z.boolean().optional().default(false),
  co2_equivalent: nullableNumber(),
  final_cost: nullableNumber(),
  tags: z.array(z.string()).default([]),
  facility: z.object({ id: z.number().int(), name: z.string() }).optional(),
  /** Requires the Project feature; absent or null on accounts without it. */
  project_id: nullableNumber(),
  updated_at: nullableString(),
  created_at: nullableString(),
});
export type PlanimaAction = z.infer<typeof planimaAction>;

/**
 * The eight action statuses Planima documents as its `status` filter enum.
 *
 * Exported as data rather than enforced as a schema, and that is the point: the field
 * itself is typed `string` in Planima's own spec, so a ninth status is an ordinary
 * product change, not a protocol break. Parsing against a closed set would turn that
 * into a sweep-wide throw — a whole tenant's plan failing to land because one action
 * moved to a status added last week. A consumer that wants to branch on status has the
 * list; the connector passes through whatever arrived.
 */
export const PLANIMA_ACTION_STATUSES = [
  'draft',
  'planned',
  'prioritized',
  'decided',
  'in_progress',
  'deferred',
  'completed',
  'inactive',
] as const;

export interface PlanimaApiOptions {
  apiBase?: string;
  /** Injected so a test can assert elapsed time without sleeping. */
  now?: () => number;
  /** Injected for the same reason — the throttle waits through this, never a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * How many 429s in a row this client will sit out before giving up on a request.
   * Zero disables the retry entirely, which is what a probe wants.
   */
  maxRateLimitRetries?: number;
}

/**
 * Planima's documented ceiling: 10 requests per 10 seconds per token (and 10,000 per
 * 24 h, which a sweep of this shape cannot approach).
 *
 * The throttle below is a sliding window rather than a fixed delay because the two
 * behave differently for the traffic this connector actually makes: a sweep is bursty —
 * one facility is 3 requests back to back, then nothing while pages are landed. A fixed
 * 1 s spacing would tax the quiet stretches for nothing; a window lets the burst
 * through and only waits when the tenth request in ten seconds is genuinely due.
 */
const RATE_LIMIT_REQUESTS = 10;
const RATE_LIMIT_WINDOW_MS = 10_000;

export class PlanimaApi {
  private readonly conn: ConnectorConnection;
  private readonly apiBase: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRateLimitRetries: number;

  /**
   * When the last {@link RATE_LIMIT_REQUESTS} requests went out, oldest first.
   *
   * Per-instance rather than per-token-global, matching `FortnoxApi`'s token cache: an
   * instance is built for one sweep pass, so the window lives exactly as long as the
   * work that uses it and no cross-request state accumulates in a Worker's isolate.
   * The cost of that choice is honest and small — two concurrent passes on one token
   * each keep their own window and can jointly exceed the limit, which the 429 retry
   * below then absorbs.
   */
  private readonly sent: number[] = [];

  constructor(conn: ConnectorConnection, options?: PlanimaApiOptions) {
    this.conn = conn;
    this.apiBase = options?.apiBase ?? PLANIMA_API_BASE;
    this.now = options?.now ?? (() => Date.now());
    this.sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRateLimitRetries = options?.maxRateLimitRetries ?? 3;
  }

  private secret(): PlanimaSecret {
    const parsed = planimaSecret.safeParse(this.conn.secret);
    if (!parsed.success) {
      throw new PlanimaApiError(
        `incomplete Planima credential: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
        400,
        '',
      );
    }
    return parsed.data;
  }

  /** Wait, if the sliding window says the next request would breach the limit. */
  private async throttle(): Promise<void> {
    const cutoff = this.now() - RATE_LIMIT_WINDOW_MS;
    while (this.sent.length > 0 && this.sent[0]! <= cutoff) this.sent.shift();
    if (this.sent.length >= RATE_LIMIT_REQUESTS) {
      // The oldest request leaving the window is the earliest moment a new one fits.
      const waitMs = this.sent[0]! + RATE_LIMIT_WINDOW_MS - this.now();
      if (waitMs > 0) await this.sleep(waitMs);
      const after = this.now() - RATE_LIMIT_WINDOW_MS;
      while (this.sent.length > 0 && this.sent[0]! <= after) this.sent.shift();
    }
    this.sent.push(this.now());
  }

  /**
   * A JSON GET against the REST host, throttled, and retried through a 429.
   *
   * The retry exists because the window above cannot be authoritative: it models one
   * client's own traffic, and the tenant's token may be in use by their own scripts at
   * the same time. When Planima says "too many", it says how long to wait — so the
   * client obeys `Retry-After` rather than backing off on a schedule of its own
   * invention, and gives up after {@link PlanimaApiOptions.maxRateLimitRetries} so a
   * pathologically busy token surfaces as a failed sweep instead of a hung one.
   */
  private async getJson(path: string): Promise<unknown> {
    const { token } = this.secret();
    for (let attempt = 0; ; attempt += 1) {
      await this.throttle();
      const res = await this.conn.fetch(`${this.apiBase}${path}`, {
        headers: {
          // Bare, no `Bearer` — see this module's header note.
          Authorization: token,
          Accept: PLANIMA_ACCEPT,
        },
      });
      if (res.ok) return asJson(await res.text(), `Planima GET ${path}`);

      const body = await res.text();
      if (res.status === 429 && attempt < this.maxRateLimitRetries) {
        const retryAfter = retryAfterMs(res.headers?.get('Retry-After') ?? null);
        await this.sleep(retryAfter);
        continue;
      }
      throw new PlanimaApiError(
        `Planima GET ${path} failed: ${errorMessage(body, res.status)}`,
        res.status,
        body,
        res.status === 429
          ? (retryAfterMs(res.headers?.get('Retry-After') ?? null) / 1000)
          : null,
      );
    }
  }

  /**
   * Walk every page of a list endpoint.
   *
   * Termination is driven by what came BACK, never by `total_count` alone: a plan that
   * grows mid-walk would otherwise leave the loop reading past the end, and a
   * `total_count` that disagrees with the rows (a filter applied server-side after the
   * count) would loop forever. An empty page ends the walk, and `total_count` is used
   * only as the belt to that braces — a bound on how many pages can be worth asking
   * for.
   */
  private async list<T>(
    path: string,
    schema: z.ZodType<T>,
    query: Record<string, string | number | undefined> = {},
  ): Promise<T[]> {
    const rows: T[] = [];
    let offset = 0;
    for (;;) {
      const url = new URL(`${this.apiBase}${path}`);
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
      url.searchParams.set('page[limit]', String(PLANIMA_MAX_PAGE));
      url.searchParams.set('page[offset]', String(offset));
      const raw = (await this.getJson(url.toString().slice(this.apiBase.length))) as {
        data?: unknown;
        pagination?: unknown;
      };
      const page = z.array(schema).parse(raw.data ?? []);
      rows.push(...page);
      if (page.length === 0) return rows;

      const pagination = planimaPagination.safeParse(raw.pagination);
      // No pagination block at all ⇒ the endpoint is not paged, and one page is the
      // whole answer. Trusting a missing block as "there is more" would loop forever.
      if (!pagination.success) return rows;
      offset += page.length;
      if (offset >= pagination.data.total_count) return rows;
      // A page shorter than the limit with the count still ahead of us means the server
      // has stopped handing rows over; believing the count would spin.
      if (page.length < Math.min(PLANIMA_MAX_PAGE, pagination.data.limit)) return rows;
    }
  }

  /** Every organization this token can see — the probe read, and the sweep's entry point. */
  async organizations(): Promise<PlanimaOrganization[]> {
    return this.list('/organizations', planimaOrganization);
  }

  /** Every facility, optionally narrowed to one organization. */
  async facilities(organizationId?: number): Promise<PlanimaFacility[]> {
    return this.list('/facilities', planimaFacility, { organization_id: organizationId });
  }

  /** One facility's buildings. */
  async buildings(facilityId: number): Promise<PlanimaBuilding[]> {
    return this.list(`/facilities/${facilityId}/buildings`, planimaBuilding);
  }

  /** One facility's components. */
  async components(facilityId: number): Promise<PlanimaComponent[]> {
    return this.list(`/facilities/${facilityId}/components`, planimaComponent);
  }

  /**
   * One facility's planned actions, over a year window.
   *
   * The window is server-side (`start_year`/`end_year`) rather than a filter applied
   * after the fact, because a maintenance plan routinely runs 30 years out and pulling
   * all of it to keep five years is a rate-limit budget spent on rows that get dropped.
   */
  async actions(facilityId: number, window: { fromYear: number; toYear: number }): Promise<PlanimaAction[]> {
    return this.list('/actions', planimaAction, {
      facility_id: facilityId,
      start_year: window.fromYear,
      end_year: window.toYear,
    });
  }
}

/**
 * `Retry-After` in milliseconds, defaulting to the full window.
 *
 * Planima documents it as a count of seconds. A missing or unparseable value falls back
 * to the whole rate-limit window, which is the only wait guaranteed to clear a
 * 10-per-10-seconds limit — a shorter guess just spends another request to be told the
 * same thing.
 */
function retryAfterMs(header: string | null): number {
  const seconds = header === null ? Number.NaN : Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return RATE_LIMIT_WINDOW_MS;
  // A provider that answers with an hour must not become an hour-long hung sweep.
  return Math.min(seconds * 1000, RATE_LIMIT_WINDOW_MS * 3);
}
