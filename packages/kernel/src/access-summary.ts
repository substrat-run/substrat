import type { PlatformActorId, ScopeId, TenantId } from '@substrat-run/contracts';

/**
 * K-73 (amends K-24; #3326): the platform's own bookkeeping reads, recorded as ONE access-log row
 * per pass instead of one per read.
 *
 * The scheduled pass reads the directory through the audited `HostAdmin` seam as its sweep actor,
 * about 720 times a pass on the hosted fleet (#3326): scope records, tenants, undrained events,
 * versions. K-24 recorded each of them, so the access log was ~95% the platform talking to itself,
 * at ~7 directory row writes per row. A host that is summarizing an actor folds that actor's reads
 * into this instead, and writes one row when the summary is flushed: which methods were read how
 * often, how many distinct tenants and scopes they named, the total result count, and the window.
 * That a piece of code read tenant records stays on the record; the per-read detail does not.
 *
 * Only the actor a summary was opened for is folded in. A person's read in the same isolate, or a
 * delegated one, is recorded exactly as before. Opening nests (`depth`): the hosted scheduled
 * handler opens one around the whole pass and `runPlatformSweep` opens one around itself, and the
 * row is written when the outermost closes.
 */
export const ACCESS_SUMMARY_METHOD = 'summarizedReads';

/** The params column's cap for a summary row: one row a pass, so wider than a read's 500. */
const SUMMARY_PARAMS_MAX = 4_000;

/** What a flush wrote, for the caller's own log line. */
export interface AccessSummaryResult {
  reads: number;
  methods: number;
  tenants: number;
  scopes: number;
  resultCount: number;
}

export class AccessSummary {
  depth = 1;
  private readonly reads = new Map<string, number>();
  private readonly tenants = new Set<string>();
  private readonly scopes = new Set<string>();
  private results = 0;

  constructor(
    readonly actor: PlatformActorId,
    readonly since: string,
  ) {}

  add(method: string, target: { tenantId?: TenantId | null; scopeId?: ScopeId | null }, resultCount: number): void {
    this.reads.set(method, (this.reads.get(method) ?? 0) + 1);
    if (target.tenantId) this.tenants.add(target.tenantId);
    if (target.scopeId) this.scopes.add(target.scopeId);
    this.results += Number.isFinite(resultCount) ? resultCount : 0;
  }

  get empty(): boolean {
    return this.reads.size === 0;
  }

  result(): AccessSummaryResult {
    let reads = 0;
    for (const n of this.reads.values()) reads += n;
    return { reads, methods: this.reads.size, tenants: this.tenants.size, scopes: this.scopes.size, resultCount: this.results };
  }

  /**
   * The row's params: the window, counts per method (most read first), and the distinct tenants
   * and scopes. Methods that would not fit the cap are counted in `otherMethods` rather than cut
   * mid-JSON, so the column always parses.
   */
  params(until: string): string {
    const sorted = [...this.reads.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const base = { since: this.since, until, tenants: this.tenants.size, scopes: this.scopes.size };
    const reads: Record<string, number> = {};
    let other = 0;
    for (const [method, n] of sorted) {
      reads[method] = n;
      if (JSON.stringify({ ...base, reads }).length > SUMMARY_PARAMS_MAX - 40) {
        delete reads[method];
        other += n;
      }
    }
    return JSON.stringify({ ...base, reads, ...(other > 0 ? { otherMethods: other } : {}) });
  }
}

/**
 * Open (or nest) a summary for `actor` on a host's slot. A host summarizes one actor at a time: a
 * second actor is refused rather than folded in, so nobody's reads land under another's name.
 */
export function openAccessSummary(current: AccessSummary | null, actor: PlatformActorId, now: string): AccessSummary {
  if (current === null) return new AccessSummary(actor, now);
  if (current.actor !== actor) {
    throw new Error(`access summary: already summarizing ${current.actor}; refusing to fold ${actor}'s reads into it`);
  }
  current.depth += 1;
  return current;
}
