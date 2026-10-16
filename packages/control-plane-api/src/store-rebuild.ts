/**
 * The platform's rebuild of every store script (#2309, D-63).
 *
 * A store script is built from a driver's release and from what the platform adds to every script:
 * the entry, its verifier, the compatibility flags and both audiences' public key lists. A push, a
 * serve or a rollout rebuilds the scripts it reaches. This walk rebuilds the rest when the platform's
 * half changes, so a key dropped from a list (a revocation) or a verifier fix reaches every script
 * whether or not its vertical is pushed again.
 *
 * What the platform builds from is one digest, `storePlatformFingerprint`. Each driver has one
 * rebuild row in the directory: the fingerprint it converges on, the last vertical it walked, and
 * the verticals it could not rebuild. A pass:
 *
 * - does nothing for a driver whose row is `done` at the current fingerprint (one directory read);
 * - takes the row's lease (so two passes never walk one driver), then a **shared** hold on the
 *   driver, the hold a push takes. A rollout or rollback holds the driver exclusively, so a pass
 *   that meets one stops and the next pass continues. Under the shared hold no rollout can move a
 *   script between this walk's read of the release a script runs and its upload, which would
 *   upload the old release back over the new one;
 * - rebuilds each script at the release it already runs (no `to`), so a rollout that paused part
 *   way, or a rollback that has not finished, keeps every script where it is. A script that does not
 *   exist is left alone, and one already built from the current fingerprint is not uploaded again;
 * - walks the driver's canary script first, then each vertical that declared the driver, in slug
 *   order, recording the cursor after each, then retries the verticals that failed. At most
 *   `budget` scripts per pass, across drivers.
 *
 * The cursor is a slug, and a vertical behind it is not walked again. That is sound because every
 * upload builds from the platform's current inputs: a vertical pushed or served after the walk
 * passed its slug was built from the fingerprint the walk converges on, and one ahead of the cursor
 * is reached and found current (no upload).
 */
import type { PlatformActorId, ScopeStoreNeed, StoreDriverRegistration } from '@substrat-run/contracts';
import { SCOPE_STORE_CANARY } from '@substrat-run/contracts';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { ulid, type HostAdmin, type StoreDriverRebuildFailure, type StoreDriverRebuildRecord } from '@substrat-run/kernel';
import { PUSH_HOLD_TTL_MS, storedReleaseLoader, type StoreReleaseBytes } from './store-releases.js';
import type { ScopeStoreEnsurerOptions } from './store-script.js';

type LoadRelease = ScopeStoreEnsurerOptions['loadRelease'];

/**
 * What one script of the walk costs in subrequests: the hold renewal, the script's settings read,
 * the release's bytes (read once per release a pass meets, counted for every script to stay on the
 * safe side), at most one upload, and the progress write.
 */
const STORE_REBUILD_SUBREQUESTS_PER_SCRIPT = 5;
/**
 * The subrequests a pass of the walk may spend by default. A Worker invocation gets 1000 on the
 * paid plan; the scheduled pass shares its invocation with every other phase, so it takes half.
 * A staff request runs alone and may take {@link STORE_REBUILD_REQUEST_SUBREQUESTS}.
 */
export const STORE_REBUILD_PASS_SUBREQUESTS = 500;
export const STORE_REBUILD_REQUEST_SUBREQUESTS = 900;
/** The scripts a pass with `subrequests` to spend may walk: {@link STORE_REBUILD_SUBREQUESTS_PER_SCRIPT} each. */
export const storeRebuildBudget = (subrequests: number): number =>
  Math.max(1, Math.floor(subrequests / STORE_REBUILD_SUBREQUESTS_PER_SCRIPT));
/** How long a pass's lease on a driver's rebuild lives between progress writes. */
const STORE_REBUILD_LEASE_TTL_MS = 10 * 60_000;

/** The cursor once the canary is walked: before every slug, after "not started" (null). */
const CANARY_WALKED = '';

interface StoreFleetRebuildDeps {
  admin: HostAdmin;
  actor: PlatformActorId;
  drivers: readonly StoreDriverRegistration[];
  /** What the platform builds every script from now (`storePlatformFingerprint`). */
  fingerprint: string;
  bytes: StoreReleaseBytes;
  /** Rebuild one vertical's scripts of a driver at the release each runs, existing scripts only. */
  ensure: (input: {
    vertical: string;
    stores: readonly ScopeStoreNeed[];
    existingOnly: true;
    loadRelease: LoadRelease;
  }) => Promise<void | { uploaded: number }>;
  /** Rebuild the driver's canary script the same way. */
  ensureCanary: (input: { driver: string; existingOnly: true; loadRelease: LoadRelease }) => Promise<{ uploaded: boolean }>;
  /** The most scripts this pass walks, across drivers. */
  budget: number;
}

export interface StoreDriverRebuildPass {
  driver: string;
  /**
   * `current`: done at this fingerprint, nothing walked. `busy`: another pass holds the lease.
   * `held`: a rollout or rollback holds the driver; the next pass continues. `paused`: the budget ran
   * out with scripts left. `done`: every script walked, none failed. `failing`: every script walked,
   * some failed; they are retried on the next pass. `error`: the pass could not walk the driver.
   */
  outcome: 'current' | 'busy' | 'held' | 'paused' | 'done' | 'failing' | 'error';
  /** The scripts walked this pass: a vertical's slug, or the canary's marker. */
  walked: string[];
  /** The ones of those that were uploaded. */
  uploaded: string[];
  rebuild?: StoreDriverRebuildRecord;
  error?: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One pass of the walk over every driver, within `budget` scripts. */
export async function runStoreFleetRebuild(deps: StoreFleetRebuildDeps): Promise<StoreDriverRebuildPass[]> {
  // One loader for the pass: a release's bytes are read once, however many scripts run it.
  const read = storedReleaseLoader({ admin: deps.admin, actor: deps.actor, bytes: deps.bytes });
  const cache = new Map<string, ReturnType<LoadRelease>>();
  const loadRelease: LoadRelease = (input) => {
    const key = `${input.driver}/${input.sha256 ?? ''}`;
    let hit = cache.get(key);
    if (!hit) cache.set(key, (hit = read(input)));
    return hit;
  };
  let budget = deps.budget;
  const passes: StoreDriverRebuildPass[] = [];
  for (const registration of deps.drivers) {
    // One driver's failure (its directory read, its lease write) never stops the others.
    const pass = await rebuildDriver(deps, registration, loadRelease, budget).catch(
      (e: unknown): StoreDriverRebuildPass => ({ driver: registration.driver, outcome: 'error', walked: [], uploaded: [], error: message(e) }),
    );
    budget -= pass.walked.length;
    passes.push(pass);
  }
  return passes;
}

async function rebuildDriver(
  deps: StoreFleetRebuildDeps,
  registration: StoreDriverRegistration,
  loadRelease: LoadRelease,
  budget: number,
): Promise<StoreDriverRebuildPass> {
  const { admin, actor, fingerprint } = deps;
  const driver = registration.driver;
  const walked: string[] = [];
  const uploaded: string[] = [];
  const result = (outcome: StoreDriverRebuildPass['outcome'], rebuild?: StoreDriverRebuildRecord): StoreDriverRebuildPass =>
    ({ driver, outcome, walked, uploaded, ...(rebuild ? { rebuild } : {}) });
  const stood = await admin.storeDriverRebuild(actor, driver);
  if (stood && stood.fingerprint === fingerprint && stood.state === 'done') return result('current', stood);
  if (budget <= 0) return result('paused', stood);

  const holder = ulid();
  const claimed = await admin.claimStoreDriverRebuild(actor, { driver, fingerprint, holder, ttlMs: STORE_REBUILD_LEASE_TTL_MS });
  if (!claimed) return result('busy', stood);
  let rebuild = claimed;
  let cursor = claimed.cursor;
  const failures = new Map(claimed.failures.map((f) => [f.vertical, f.detail]));
  const advance = async (done: boolean, release = false) => {
    const list: StoreDriverRebuildFailure[] = [...failures].map(([vertical, detail]) => ({ vertical, detail }));
    rebuild = await admin.advanceStoreDriverRebuild(actor, { driver, fingerprint, holder, cursor, failures: list, done, ttlMs: STORE_REBUILD_LEASE_TTL_MS, release });
  };
  // The lease is dropped once, however the walk ends; the end of a whole walk drops it itself.
  let leaseDropped = false;
  let held = false;
  try {
    held = await admin.holdStoreDriver(actor, { driver, holder, mode: 'shared', ttlMs: PUSH_HOLD_TTL_MS });
    if (!held) return result('held', rebuild);
    const declared = await admin.storeDriverDeclarations(actor, driver);
    const unreadable = new Set(declared.unreadable);
    for (const vertical of unreadable) {
      failures.set(vertical, 'a version of it declares stores that cannot be named, so its scripts cannot be listed');
    }
    const byVertical = new Map(declared.verticals.map((v) => [v.vertical, v.stores.map((s) => ({ binding: s.binding, driver }))]));
    // A failure no longer to be had: the vertical declares the driver no more, and is readable.
    for (const vertical of [...failures.keys()]) {
      if (vertical !== SCOPE_STORE_CANARY && !byVertical.has(vertical) && !unreadable.has(vertical)) failures.delete(vertical);
    }
    const ahead = aheadOf(cursor, [...byVertical.keys()].sort());
    const walking = new Set(ahead);
    const steps: { key: string; walk: boolean }[] = [
      ...ahead.map((key) => ({ key, walk: true })),
      // The retries: a failure behind the cursor that can be rebuilt now.
      ...[...failures.keys()]
        .filter((key) => !walking.has(key) && (key === SCOPE_STORE_CANARY || byVertical.has(key)))
        .map((key) => ({ key, walk: false })),
    ];
    for (const step of steps) {
      if (walked.length >= budget) break;
      if (!(await admin.holdStoreDriver(actor, { driver, holder, mode: 'shared', ttlMs: PUSH_HOLD_TTL_MS, renew: true }))) {
        // The hold lapsed, and a rollout may hold the driver now: walk nothing more. The lease may
        // have lapsed with it, and then another pass owns the row; what was walked is recorded.
        return result('held', rebuild);
      }
      walked.push(step.key);
      try {
        const up = step.key === SCOPE_STORE_CANARY
          ? (await deps.ensureCanary({ driver, existingOnly: true, loadRelease })).uploaded
          : await deps.ensure({ vertical: step.key, stores: byVertical.get(step.key)!, existingOnly: true, loadRelease }).then((r) => (r ? r.uploaded > 0 : true));
        if (up) uploaded.push(step.key);
        failures.delete(step.key);
      } catch (e) {
        failures.set(step.key, message(e));
        await admin
          .recordOpsFailure({
            actor,
            operation: 'store-rebuild',
            stage: 'store-upload',
            vertical: step.key === SCOPE_STORE_CANARY ? null : step.key,
            status: e instanceof ControlPlaneError ? e.status : 502,
            message: `store script rebuild of '${driver}' for ${step.key === SCOPE_STORE_CANARY ? 'its canary' : step.key}: ${message(e)}`,
          })
          .catch(() => undefined);
      }
      if (step.walk) cursor = step.key === SCOPE_STORE_CANARY ? CANARY_WALKED : step.key;
      await advance(false);
    }
    const left = steps.length - walked.length;
    const done = left === 0 && failures.size === 0;
    leaseDropped = true;
    await advance(done, true);
    return result(left > 0 ? 'paused' : done ? 'done' : 'failing', rebuild);
  } finally {
    if (held) await admin.releaseStoreDriverHold(actor, { driver, holder }).catch(() => undefined);
    if (!leaseDropped) await advance(false, true).catch(() => undefined);
  }
}

/** The scripts ahead of a walk's cursor: the canary before any vertical, then each slug after it. */
function aheadOf(cursor: string | null, verticals: readonly string[]): string[] {
  return [...(cursor === null ? [SCOPE_STORE_CANARY] : []), ...verticals.filter((v) => cursor === null || v > cursor)];
}

/**
 * Whether every script of a driver is built from what the platform builds from now, and which may
 * not be: while the rebuild is towards another fingerprint (or none ran yet), the canary and every
 * vertical that declared the driver; while it runs, the ones ahead of its cursor and the ones that
 * failed. A push or serve may have rebuilt some of them since, and the walk then finds them
 * current, so `pending` may over-count, never under-count.
 */
export function storeRebuildStatus(
  rebuild: StoreDriverRebuildRecord | undefined,
  fingerprint: string,
  declared: readonly string[],
): { current: boolean; pending: string[] } {
  if (!rebuild || rebuild.fingerprint !== fingerprint) return { current: false, pending: [SCOPE_STORE_CANARY, ...declared] };
  if (rebuild.state === 'done') return { current: true, pending: [] };
  const pending = new Set([...aheadOf(rebuild.cursor, declared), ...rebuild.failures.map((f) => f.vertical)]);
  return { current: false, pending: [...pending] };
}
