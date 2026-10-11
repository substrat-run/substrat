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

/** The scope is held by someone else. Carries what a router needs to go there, or wait. */
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

export class LeaseClient {
  constructor(
    readonly controlPlane: string,
    readonly holder: string,
    readonly marginMs: number,
  ) {}

  private async post(path: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${this.controlPlane}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ holder: this.holder, ...body }),
      signal: AbortSignal.timeout(5_000),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  private refused(scope: string, json: Record<string, unknown>): NotHolder {
    return new NotHolder(
      scope,
      json.holder as string | undefined,
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
    grant.dataOn = this.holder;
  }

  async release(scope: string, grant: Grant): Promise<void> {
    await this.post('/lease/release', { scope, epoch: grant.epoch });
  }
}
