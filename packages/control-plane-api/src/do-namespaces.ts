/**
 * Resolving a scope's Durable Object to something an operator can OPEN.
 *
 * A scope's data lives in one Durable Object, named after the scope id inside a namespace
 * (a class × a script). The console has always been able to say the name; the dashboard,
 * however, addresses a namespace by an id Cloudflare assigns — not by the class or the
 * script — so without that id the best a link could do was the account-wide namespace
 * list, which on a real fleet is one entry per pushed script.
 *
 * This is the seam that closes the gap: given the script a scope serves from, hand back
 * the namespaces defined in it. Injected by the host like every other Cloudflare read
 * (D-34: this package holds no SDK and no credential), and entirely optional — absent, the
 * console falls back to the namespace list exactly as before.
 */

/** One Durable Object namespace as Cloudflare describes it. */
export interface DoNamespaceRecord {
  /** The dashboard's address for this namespace — the whole point of the read. */
  id: string;
  /** The exported class the namespace is defined by (e.g. `ScopeDO`). */
  className: string;
  /** The script defining it — a dispatch-namespace script name for a pushed vertical. */
  script: string | null;
  name: string | null;
  useSqlite: boolean;
}

export interface DoNamespaceReader {
  /** Every Durable Object namespace on the account. Filtering by script happens above:
   *  Cloudflare's list endpoint takes no filter, and a reader that pretended otherwise
   *  would hide the pagination cost from the one place that can cache it. */
  list(): Promise<DoNamespaceRecord[]>;
}

export interface CfDoNamespaceOptions {
  accountId: string;
  apiToken: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /**
   * How long a listing stays fresh. The mapping changes only when a script is pushed or
   * deleted, and the read is one-or-more paginated API calls that would otherwise run on
   * every scope-detail open — so the default trades a few minutes of staleness (worst
   * case: a just-pushed script's namespace is not linkable yet) for not hammering the API.
   */
  ttlMs?: number;
  /** Hard cap on pages walked, so an account with a very large fleet degrades to a slow
   *  read rather than an unbounded one. */
  maxPages?: number;
}

const PER_PAGE = 100;

/**
 * A {@link DoNamespaceReader} over Cloudflare's account-wide list endpoint, with a small
 * TTL cache. Pure web-standard `fetch`, like every other Cloudflare seam in this package.
 */
export function createCfDoNamespaceReader(opts: CfDoNamespaceOptions): DoNamespaceReader {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ttlMs = opts.ttlMs ?? 5 * 60_000;
  const maxPages = opts.maxPages ?? 50;
  const base = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/workers/durable_objects/namespaces`;

  let cached: { at: number; rows: DoNamespaceRecord[] } | null = null;
  // Concurrent scope-detail opens must not each start their own walk; they share the
  // in-flight promise and settle together.
  let inFlight: Promise<DoNamespaceRecord[]> | null = null;

  async function walk(): Promise<DoNamespaceRecord[]> {
    const rows: DoNamespaceRecord[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const res = await fetchImpl(`${base}?page=${page}&per_page=${PER_PAGE}`, {
        headers: { authorization: `Bearer ${opts.apiToken}` },
      });
      if (!res.ok) {
        throw new Error(`Cloudflare Durable Object namespace list failed (${res.status})`);
      }
      const body = (await res.json()) as {
        success?: boolean;
        errors?: { message?: string }[];
        result?: { id?: string; class?: string; script?: string; name?: string; use_sqlite?: boolean }[];
      };
      if (body.success === false) {
        throw new Error(
          `Cloudflare Durable Object namespace list failed: ${
            body.errors?.map((e) => e.message).join('; ') || 'unknown error'
          }`,
        );
      }
      const batch = body.result ?? [];
      for (const r of batch) {
        // An id-less row cannot be linked to, which is this read's whole purpose.
        if (!r.id || !r.class) continue;
        rows.push({
          id: r.id,
          className: r.class,
          script: r.script ?? null,
          name: r.name ?? null,
          useSqlite: r.use_sqlite === true,
        });
      }
      if (batch.length < PER_PAGE) break;
    }
    return rows;
  }

  return {
    async list() {
      const now = Date.now();
      if (cached && now - cached.at < ttlMs) return cached.rows;
      if (inFlight) return inFlight;
      inFlight = walk()
        .then((rows) => {
          cached = { at: Date.now(), rows };
          return rows;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

/**
 * The namespaces defined in one script, most-likely-scope-class first.
 *
 * A vertical's script defines several classes (the scope DO, an identity DO, sweepers), so
 * ORDER is the useful part: the console links the first entry, and a scope's data is in the
 * scope class. Matching is on the class name because that is the only stable signal — the
 * namespace's `name` is Cloudflare's, and the binding name lives in the script's settings,
 * not here. Every namespace of the script is still returned, so a vertical that named its
 * class something else is one click away rather than unreachable.
 */
export function namespacesForScript(rows: DoNamespaceRecord[], script: string): DoNamespaceRecord[] {
  const mine = rows.filter((r) => r.script === script);
  const rank = (r: DoNamespaceRecord) => {
    const c = r.className.toLowerCase();
    if (c === 'scopedo') return 0;
    if (c.includes('scope')) return 1;
    return 2;
  };
  return mine.sort((a, b) => rank(a) - rank(b) || a.className.localeCompare(b.className));
}
