/**
 * A shard's side of the control plane's lease table (`control-plane.ts`).
 *
 * `validUntil` is measured on the HOLDER's monotonic clock from the moment the request was
 * SENT, minus a safety margin: the control plane started its TTL no earlier than that, so
 * a holder that stops at `validUntil` stops before the control plane can hand the scope to
 * anyone else, as long as the two clocks run at nearly the same rate. That rate assumption
 * is the whole safety argument of a lease (FINDINGS.md §2); it holds trivially on one
 * runner and is a property of the nodes in a cluster.
 */
import { performance } from 'node:perf_hooks';

export interface Grant {
  epoch: number;
  /** Monotonic (`performance.now()`) instant after which the holder must not acknowledge a write. */
  validUntil: number;
  /** The node whose volume holds the latest state, or `null` for a scope nobody has written. */
  dataOn: string | null;
}

/** The scope is held by someone else. Carries what a router needs to go there (the holder's node), or wait. */
export class NotHolder extends Error {
  constructor(
    readonly scope: string,
    readonly holder: string | undefined,
    readonly epoch: number | undefined,
    readonly retryAfterMs: number,
  ) {
    super(`scope ${scope} is held by ${holder ?? 'nobody'} (epoch ${epoch ?? '-'})`);
  }
}

/**
 * Who holds a lease is the process INCARNATION (`todo-1/<boot id>`), never the pod name.
 * A StatefulSet reuses the name for the pod it brings back, and a force-deleted pod can still
 * be running when its replacement starts: two live processes named `todo-1` must not share
 * one lease. The name is still what the volume and the router are keyed by (`node`).
 */
export class LeaseClient {
  readonly holder: string;

  constructor(
    readonly controlPlane: string,
    readonly node: string,
    readonly marginMs: number,
    incarnation: string = crypto.randomUUID(),
  ) {
    this.holder = `${node}/${incarnation}`;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${this.controlPlane}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ holder: this.holder, node: this.node, ...body }),
      signal: AbortSignal.timeout(5_000),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  private refused(scope: string, json: Record<string, unknown>): NotHolder {
    return new NotHolder(
      scope,
      (json.holder as string | undefined)?.split('/')[0],
      json.epoch as number | undefined,
      Number(json.retryAfterMs ?? 0),
    );
  }

  async acquire(scope: string): Promise<Grant> {
    const sent = performance.now();
    const { status, json } = await this.post('/lease/acquire', { scope });
    if (status !== 200) throw this.refused(scope, json);
    return {
      epoch: Number(json.epoch),
      validUntil: sent + Number(json.ttlMs) - this.marginMs,
      dataOn: (json.dataOn as string | null) ?? null,
    };
  }

  /** Extends the grant in place; throws {@link NotHolder} when the epoch moved on. */
  async renew(scope: string, grant: Grant): Promise<void> {
    const sent = performance.now();
    const { status, json } = await this.post('/lease/renew', { scope, epoch: grant.epoch });
    if (status !== 200) throw this.refused(scope, json);
    grant.validUntil = sent + Number(json.ttlMs) - this.marginMs;
  }

  async settle(scope: string, grant: Grant): Promise<void> {
    const { status, json } = await this.post('/lease/settle', { scope, epoch: grant.epoch });
    if (status !== 200) throw this.refused(scope, json);
    grant.dataOn = this.node;
  }

  async release(scope: string, grant: Grant): Promise<void> {
    await this.post('/lease/release', { scope, epoch: grant.epoch });
  }
}

export interface LeaseGuardOptions {
  /** Place the scope's data before the first write under a new grant (seed, open or copy). */
  onAcquire?(scope: string, grant: Grant): Promise<void>;
  /**
   * `false` is the control (`LEASES=off`): a grant, once had, is never re-checked and never
   * fences — routing plus a placement table, which is what the kill test shows losing writes.
   */
  fencing?: boolean;
}

/**
 * The `ScopeGuard` (`fence.ts`) a shard and the contract binding both use: one grant per
 * scope, acquired on first use, renewed in the background, re-checked on every invocation.
 */
export class LeaseGuard {
  private readonly grants = new Map<string, Grant>();
  private renewer: NodeJS.Timeout | undefined;

  constructor(
    readonly client: LeaseClient,
    private readonly opts: LeaseGuardOptions = {},
  ) {}

  grant(scope: string): Grant | undefined {
    return this.grants.get(scope);
  }

  async admit(scope: string): Promise<void> {
    const g = this.grants.get(scope);
    if (g && (this.opts.fencing === false || performance.now() < g.validUntil)) return;
    if (g) {
      try {
        await this.client.renew(scope, g);
        return;
      } catch (e) {
        this.grants.delete(scope);
        throw e;
      }
    }
    const grant = await this.client.acquire(scope);
    await this.opts.onAcquire?.(scope, grant);
    this.grants.set(scope, grant);
  }

  /** Drop the grant without asking anyone (the caller releases it). */
  forget(scope: string): void {
    this.grants.delete(scope);
  }

  stillHeld(scope: string): boolean {
    const g = this.grants.get(scope);
    return g !== undefined && (this.opts.fencing === false || performance.now() < g.validUntil);
  }

  /** Renew every held grant each `intervalMs`, dropping the ones whose epoch moved on. */
  startRenewing(intervalMs: number): void {
    if (this.opts.fencing === false) return;
    this.renewer = setInterval(() => {
      for (const [scope, g] of this.grants) {
        // A refused renewal only forgets the grant: the next `admit` finds it gone and asks
        // again, so whatever the scope had open is replaced under the shard's own queue.
        this.client.renew(scope, g).catch(() => this.grants.delete(scope));
      }
    }, intervalMs);
    this.renewer.unref();
  }

  stop(): void {
    clearInterval(this.renewer);
  }
}
