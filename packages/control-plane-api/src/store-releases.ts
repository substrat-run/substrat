/**
 * A store driver's releases: stored, canaried, rolled out and rolled back (D-63, #2300).
 *
 * The bytes live outside the directory, content-addressed under `<driver>/<sha256>`, where the
 * sha256 is `storeDriverReleaseDigest` of the bundle, computed here when it arrives and again by
 * the ensurer before every upload of it, restore and rollback included. The directory holds who
 * uploaded which release from which commit, every rollout, and the current good release
 * (`store-driver-releases.ts` in the kernel).
 *
 * A rollout is one request across a fleet. It holds the driver exclusively for its whole length,
 * renewing the hold before every upload, so no push or serve rebuilds a script between the
 * rollout's read and its upload, and two rollouts never interleave. It canaries the release on the
 * platform's own object first, and no vertical's script moves unless every reserved operation
 * answered there. Then it moves each vertical that ever declared the driver, at most
 * {@link ROLLOUT_VERTICALS_PER_REQUEST} uploads and {@link ROLLOUT_WALKS_PER_REQUEST} verticals
 * walked per request. A bigger fleet ends the request `paused`, and posting the same rollout (or
 * rollback) again continues it from the attempt's walk ledger (#2312), so a fleet of any size
 * converges, a rollback included. A request that stops on a failure ends `failed` or `diverged`.
 */
import {
  STORE_RELEASE_MAX_BYTES,
  scopeStoreCanaryObjectName,
  scopeStoreCanaryScriptName,
  scopeStoreScriptName,
  storeDriverReleaseDigest,
  storeDriverReleaseUpload,
  type PlatformActorId,
  type ReservedStoreOperation,
  type ScopeStoreNeed,
  type StoreDriverRegistration,
} from '@substrat-run/contracts';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import {
  createUlid,
  ulid,
  type HostAdmin,
  type StoreDriverApprovalRecord,
  type StoreDriverRolloutAction,
  type StoreDriverRolloutRecord,
  type StoreDriverRolloutTarget,
} from '@substrat-run/kernel';
import { assertPythonDriverModules } from './store-entry.js';
import type { ScopeStoreEnsurerOptions, StoreDriverReleaseArtifact } from './store-script.js';

/** Where a release's bytes are kept: an object store keyed by driver and sha256. */
export interface StoreReleaseBytes {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

/** The key a release's bytes are stored under. */
export const storeReleaseKey = (driver: string, sha256: string): string => `${driver}/${sha256}`;

/** How long a rollout's exclusive hold lives between renewals. */
export const ROLLOUT_HOLD_TTL_MS = 10 * 60_000;
/**
 * How long a push's or a serve's shared hold lives. It is renewed before each driver's upload; one
 * driver's upload (a settings read and at most one upload per script) must fit inside it, or a
 * rollout could take the driver before that upload lands. The same lease as a rollout's.
 */
export const PUSH_HOLD_TTL_MS = 10 * 60_000;
/**
 * The verticals one rollout request moves. Each costs a settings read and at most one upload,
 * plus a hold renewal, so a request stays well inside a Worker invocation's subrequest budget.
 * A fleet bigger than this is moved over several requests (the rollout answers `complete: false`).
 */
export const ROLLOUT_VERTICALS_PER_REQUEST = 100;
/**
 * The verticals one rollout request walks. Every one costs a settings read and a hold renewal even
 * when it is already at the release, so a request that reaches this many ends `paused` and the
 * next continues from the walk ledger (#2312). It also bounds what a failure returns: an attempt
 * that reached more ends `diverged` without returning any, and a rollback, paged the same way,
 * converges them.
 */
export const ROLLOUT_WALKS_PER_REQUEST = 300;

export interface StoreDriverRevokeResult {
  approval: StoreDriverApprovalRecord;
  complete: boolean;
  remaining: number;
}

/** Walk the scripts' own settings under the driver's exclusive hold before a normal revoke. */
export async function runStoreDriverRevoke(input: {
  admin: HostAdmin; actor: PlatformActorId; driver: string; sha256: string;
  reason: string; emergency: boolean;
  readScriptRelease: (scriptName: string) => Promise<{ exists: boolean; release?: string }>;
  ensureCanary: (sha256: string) => Promise<unknown>;
  perRequestWalks?: number;
}): Promise<StoreDriverRevokeResult> {
  const { admin, actor, driver, sha256 } = input;
  const holder = ulid();
  if (!(await admin.holdStoreDriver(actor, { driver, holder, mode: 'exclusive', ttlMs: ROLLOUT_HOLD_TTL_MS }))) {
    throw new ControlPlaneError(409, `driver '${driver}' is held by a rollout or push; try the revoke again shortly`);
  }
  try {
    const approval = await admin.liveStoreDriverApproval(actor, driver, sha256);
    if (!approval) throw new ControlPlaneError(409, `release ${sha256} of '${driver}' has no live approval to revoke`);
    const state = await admin.storeDriverState(actor, driver);
    if (!input.emergency && state.current?.sha256 === sha256) {
      throw new ControlPlaneError(409, `release ${sha256} is current for '${driver}'; an emergency revoke with a reason is required`);
    }
    if (input.emergency) {
      return {
        approval: await admin.revokeStoreDriverRelease(actor, { approvalId: approval.approvalId, driver, sha256, holder, reason: input.reason, emergency: true }),
        complete: true, remaining: 0,
      };
    }
    const declarations = await admin.storeDriverDeclarations(actor, driver);
    if (declarations.unreadable.length > 0) {
      throw new ControlPlaneError(409, `driver '${driver}' cannot be revoked: ${declarations.unreadable.join(', ')} cannot name its store scripts; roll it out first`);
    }
    const rolloutSeq = state.rollouts.at(-1)?.seq ?? 0;
    const prior = await admin.storeDriverRevokeWalk(actor, approval.approvalId);
    const cursor = prior?.actor === actor && prior.reason === input.reason && prior.rolloutSeq === rolloutSeq ? prior.cursor : null;
    const verticals = declarations.verticals.map((v) => v.vertical).sort();
    const pending = verticals.filter((v) => cursor === null || v > cursor);
    const limit = input.perRequestWalks ?? ROLLOUT_WALKS_PER_REQUEST;
    if (!(Number.isInteger(limit) && limit > 0 && limit <= ROLLOUT_WALKS_PER_REQUEST)) {
      throw new ControlPlaneError(422, 'a revoke page needs a positive bounded walk limit');
    }
    const page = pending.slice(0, limit);
    const renew = async () => {
      const held = await admin.holdStoreDriver(actor, { driver, holder, mode: 'exclusive', ttlMs: ROLLOUT_HOLD_TTL_MS, renew: true });
      if (!held) throw new ControlPlaneError(409, `the hold on driver '${driver}' lapsed; post the revoke again`);
    };
    for (const vertical of page) {
      await renew();
      const script = scopeStoreScriptName(vertical, driver);
      let running: { exists: boolean; release?: string };
      try {
        running = await input.readScriptRelease(script);
      } catch {
        throw new ControlPlaneError(409, `store script '${script}' settings are unreadable; roll it out before revoking ${sha256}`);
      }
      if (running.exists && !running.release) {
        throw new ControlPlaneError(409, `store script '${script}' records no release; roll it out before revoking ${sha256}`);
      }
      if (running.release === sha256) {
        throw new ControlPlaneError(409, `store script '${script}' still runs ${sha256}; roll it out before revoking`);
      }
    }
    const remaining = pending.length - page.length;
    if (remaining > 0) {
      await admin.recordStoreDriverRevokeWalk(actor, { approvalId: approval.approvalId, driver, holder, cursor: page.at(-1)!, reason: input.reason, rolloutSeq });
      return { approval, complete: false, remaining };
    }
    await renew();
    const canary = scopeStoreCanaryScriptName(driver);
    let runningCanary: { exists: boolean; release?: string };
    try {
      runningCanary = await input.readScriptRelease(canary);
    } catch {
      throw new ControlPlaneError(409, `store canary '${canary}' settings are unreadable; roll it out before revoking ${sha256}`);
    }
    if (runningCanary.exists && !runningCanary.release) {
      throw new ControlPlaneError(409, `store canary '${canary}' records no release; roll it out before revoking ${sha256}`);
    }
    if (runningCanary.release === sha256 && state.current) {
      if (!(await admin.liveStoreDriverApproval(actor, driver, state.current.sha256))) {
        throw new ControlPlaneError(409, `current release ${state.current.sha256} of '${driver}' has no live approval for a canary move`);
      }
      await renew();
      await input.ensureCanary(state.current.sha256);
    }
    return {
      approval: await admin.revokeStoreDriverRelease(actor, { approvalId: approval.approvalId, driver, sha256, holder, reason: input.reason, emergency: false }),
      complete: true, remaining: 0,
    };
  } finally {
    await admin.releaseStoreDriverHold(actor, { driver, holder }).catch(() => undefined);
  }
}

type LoadRelease = ScopeStoreEnsurerOptions['loadRelease'];

const decodeBase64 = (text: string): Uint8Array => {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    throw new ControlPlaneError(422, 'a release module is not base64');
  }
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
};

/**
 * A release bundle as uploaded or as stored, decoded and judged: the upload body's shape, the
 * decoded size cap, and the Python driver's module rule. Refusals are 422 (413 for the size).
 */
export function decodeStoreDriverRelease(raw: unknown): Omit<StoreDriverReleaseArtifact, 'sha256'> {
  const parsed = storeDriverReleaseUpload.safeParse(raw);
  if (!parsed.success) {
    throw new ControlPlaneError(422, `not a store driver release: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  let total = 0;
  const modules = parsed.data.modules.map((module) => {
    const content = decodeBase64(module.contentBase64);
    total += content.byteLength;
    if (total > STORE_RELEASE_MAX_BYTES) {
      throw new ControlPlaneError(413, `a store driver release carries at most ${STORE_RELEASE_MAX_BYTES} module bytes`);
    }
    return { name: module.name, content };
  });
  const release = { sourceCommit: parsed.data.sourceCommit, entry: parsed.data.entry, modules };
  try {
    assertPythonDriverModules(release);
  } catch (e) {
    throw new ControlPlaneError(422, e instanceof Error ? e.message : String(e));
  }
  return release;
}

/** The stored form: the upload body again, so one decoder reads both. */
function encodeStoreDriverRelease(release: Omit<StoreDriverReleaseArtifact, 'sha256'>): Uint8Array {
  const base64 = (bytes: Uint8Array) => {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };
  return new TextEncoder().encode(
    JSON.stringify({
      sourceCommit: release.sourceCommit,
      entry: release.entry,
      modules: release.modules.map((m) => ({ name: m.name, contentBase64: base64(m.content) })),
    }),
  );
}

/**
 * Store a release's bytes and record them (D-63: bytes may be published before the pin lands).
 * The bytes go first, so a recorded release always has bytes; a retry of the same bundle writes
 * the same key and records nothing new.
 */
export async function storeDriverRelease(input: {
  admin: HostAdmin;
  actor: PlatformActorId;
  bytes: StoreReleaseBytes;
  driver: string;
  body: unknown;
}) {
  const release = decodeStoreDriverRelease(input.body);
  const sha256 = await storeDriverReleaseDigest(release).catch((e: unknown) => {
    throw new ControlPlaneError(422, e instanceof Error ? e.message : String(e));
  });
  const held = await input.admin.getStoreDriverRelease(input.actor, input.driver, sha256);
  if (held && held.sourceCommit !== release.sourceCommit) {
    throw new ControlPlaneError(409, `release ${sha256} of '${input.driver}' is stored as built from ${held.sourceCommit}`);
  }
  if (!held) await input.bytes.put(storeReleaseKey(input.driver, sha256), encodeStoreDriverRelease(release));
  return input.admin.recordStoreDriverRelease(input.actor, { driver: input.driver, sha256, sourceCommit: release.sourceCommit });
}

/**
 * The ensurer's loader over the stored bytes: a named release, or the driver's current good one.
 * Each answer carries the sha256 it was read as, which the ensurer holds the bytes to.
 */
export function storedReleaseLoader(input: { admin: HostAdmin; actor: PlatformActorId; bytes: StoreReleaseBytes }): LoadRelease {
  return async ({ driver, sha256 }) => {
    const wanted = sha256 ?? (await input.admin.storeDriverState(input.actor, driver)).current?.sha256;
    if (!wanted) return undefined;
    const raw = await input.bytes.get(storeReleaseKey(driver, wanted));
    if (!raw) return undefined;
    return { ...decodeStoredReleaseBytes(raw, driver, wanted), sha256: wanted };
  };
}

function decodeStoredReleaseBytes(raw: Uint8Array, driver: string, sha256: string) {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new ControlPlaneError(422, `driver '${driver}' release ${sha256} is stored as something other than a release`);
  }
  return decodeStoreDriverRelease(json);
}

/** Verify the named stored bundle before an approval can be recorded. */
export async function approveStoredDriverRelease(input: {
  admin: HostAdmin; actor: PlatformActorId; bytes: StoreReleaseBytes;
  driver: string; sha256: string;
  approval: Omit<Parameters<HostAdmin['approveStoreDriverRelease']>[1], 'driver' | 'sha256'>;
}) {
  const { admin, actor, bytes, driver, sha256 } = input;
  const stored = await admin.getStoreDriverRelease(actor, driver, sha256);
  if (!stored) throw new ControlPlaneError(404, `release ${sha256} of '${driver}' is not stored`);
  const raw = await bytes.get(storeReleaseKey(driver, sha256));
  if (!raw) throw new ControlPlaneError(404, `release ${sha256} of '${driver}' has no stored bytes`);
  let release: ReturnType<typeof decodeStoredReleaseBytes>;
  try {
    release = decodeStoredReleaseBytes(raw, driver, sha256);
  } catch (e) {
    if (e instanceof ControlPlaneError && e.status === 422) {
      throw new ControlPlaneError(409, `release ${sha256} of '${driver}' has unverifiable stored bytes`);
    }
    throw e;
  }
  const digest = await storeDriverReleaseDigest(release).catch(() => undefined);
  if (digest !== sha256 || release.sourceCommit !== stored.sourceCommit) {
    throw new ControlPlaneError(409, `release ${sha256} of '${driver}' differs from its stored digest or source commit`);
  }
  return admin.approveStoreDriverRelease(actor, { driver, sha256, ...input.approval });
}

/** The reserved calls a canary makes, at the canary script. */
export type CanaryCall = (target: { scriptName: string; objectName: string }, operation: ReservedStoreOperation, input?: unknown) => Promise<unknown>;

/**
 * A canary object's name. Each id comes from a mint of its own, so its 80 random bits are fresh
 * from `crypto.getRandomValues`: the shared mint would make the second id the first plus one
 * within a millisecond, and either id would then give the other away.
 */
export const canaryObjectName = (binding: string): string => scopeStoreCanaryObjectName(createUlid()(), createUlid()(), binding);

const tablesOf = (answer: unknown) => (answer as { tables: { name: string; rows: unknown[] }[] }).tables;

/**
 * Every reserved operation, on a fresh object of the platform's own (D-63): its tenant and scope
 * ids are new ulids, from the runtime's CSPRNG, never in the directory, and its vertical segment
 * is no vertical's. Each answer is parsed by the call and asserted here; the first that is not
 * what an object holding no data answers fails the canary. The object is wiped at the end.
 */
export async function canaryStoreRelease(input: { call: CanaryCall; scriptName: string; binding?: string }): Promise<void> {
  const target = { scriptName: input.scriptName, objectName: canaryObjectName(input.binding ?? 'CANARY') };
  const step = async (operation: ReservedStoreOperation, check: (answer: unknown) => string | null, body?: unknown) => {
    let answer: unknown;
    try {
      answer = await input.call(target, operation, body);
    } catch (e) {
      throw new ControlPlaneError(502, `canary refused: ${operation} failed (${e instanceof Error ? e.message : String(e)})`);
    }
    const wrong = check(answer);
    if (wrong) throw new ControlPlaneError(502, `canary refused: ${operation} ${wrong}`);
    return answer;
  };
  const ok = () => null;
  await step('substrat.size', ok);
  const exported = tablesOf(await step('substrat.export', (a) => (tablesOf(a).some((t) => t.rows.length > 0) ? 'exported rows from an object holding none' : null)));
  await step('substrat.import', (a) => ((a as { tables: number }).tables === exported.length ? null : `imported ${(a as { tables: number }).tables} of ${exported.length} tables`), { tables: exported });
  await step('substrat.export', (a) => (JSON.stringify(tablesOf(a)) === JSON.stringify(exported) ? null : 'did not export what it imported'));
  await step('substrat.erase', (a) => ((a as { erased: number }).erased === 0 ? null : 'erased rows of a subject the object never held'), { subjectId: ulid() });
  await step('substrat.wipe', ok);
  await step('substrat.export', (a) => (tablesOf(a).some((t) => t.rows.length > 0) ? 'still holds rows after its wipe' : null));
}

export interface StoreDriverRolloutDeps {
  admin: HostAdmin;
  actor: PlatformActorId;
  registration: StoreDriverRegistration;
  sha256: string;
  action: StoreDriverRolloutAction;
  /**
   * Move one vertical's scripts of the driver to `to` (the push's ensurer, with `to`). Answers
   * whether anything was uploaded: false for a script already there, built the same way.
   */
  ensure: (input: { vertical: string; stores: readonly ScopeStoreNeed[]; to: string }) => Promise<boolean>;
  /** Put `to` in the driver's canary script; answers its name. */
  ensureCanary: (to: string) => Promise<{ scriptName: string }>;
  callCanary: CanaryCall;
  /** For a test: a smaller batch than {@link ROLLOUT_VERTICALS_PER_REQUEST}. */
  perRequest?: number;
  /** For a test: fewer verticals walked per request than {@link ROLLOUT_WALKS_PER_REQUEST}. */
  perRequestWalks?: number;
}

export interface StoreDriverRolloutResult {
  rollout: StoreDriverRolloutRecord;
  /** The verticals whose scripts this request uploaded. */
  moved: string[];
  /** False when verticals remain: post the same rollout again. */
  complete: boolean;
  /** The verticals not walked yet; 0 once complete. */
  remaining: number;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const schemaOf = (registration: StoreDriverRegistration, sha256: string | null) =>
  sha256 === null ? undefined : registration.releases.find((pin) => pin.sha256 === sha256)?.schema;

/** The hold lapsed, or another holder ended the rollout: nothing more may be moved under it. */
class HoldLost extends ControlPlaneError {
  constructor(driver: string) {
    super(409, `the hold on driver '${driver}' lapsed or its rollout was ended by another; post the rollout again to converge it`);
  }
}

/**
 * Move every script of a driver to a stored, pinned release (D-63): hold, canary, then each
 * vertical. A failure after a vertical moved returns every vertical the attempt reached to the
 * release the rollout started from, rehashing those bytes as it uploads them, and ends `failed`.
 * It ends `diverged` instead, naming what is where, when there is nothing to return to (a driver's
 * first rollout), when returning would lower the stored schema, when the attempt reached more
 * verticals than one request returns, or when a return fails: the next rollout or rollback
 * converges every script. The hold is renewed before every upload, the returns included, and a
 * hold that cannot be renewed stops everything at once: another holder may be moving the same
 * scripts, so nothing is returned either. The hold is released however it ends.
 *
 * A fleet bigger than one request is paged (#2312). Each request walks at most
 * {@link ROLLOUT_WALKS_PER_REQUEST} verticals and uploads at most `perRequest` scripts; one that runs out
 * ends `paused`, and its end records what it walked in the attempt's ledger. Posting the same
 * rollout (or rollback) again continues the attempt and walks only declarations the ledger does
 * not hold, in (vertical, binding) order: a vertical declared between two requests, wherever it
 * sorts, is walked by the next one, and one walked is never walked again. A request ends `good`
 * only when the pending list it read under its exclusive hold was the whole of it and it walked
 * every vertical on it: no push can create a script while the hold is held, so nothing declared
 * can be left on another release.
 */
export async function runStoreDriverRollout(deps: StoreDriverRolloutDeps): Promise<StoreDriverRolloutResult> {
  const { admin, actor, registration, sha256 } = deps;
  const driver = registration.driver;
  const holder = ulid();
  if (!(await admin.holdStoreDriver(actor, { driver, holder, mode: 'exclusive', ttlMs: ROLLOUT_HOLD_TTL_MS }))) {
    throw new ControlPlaneError(409, `driver '${driver}' is being rolled out or a vertical declaring it is being pushed; try again shortly`);
  }
  try {
    const walkMax = deps.perRequestWalks ?? ROLLOUT_WALKS_PER_REQUEST;
    const page = await admin.storeDriverRolloutPending(actor, { driver, sha256, action: deps.action, limit: walkMax });
    if (page.unreadable.length > 0) {
      throw new ControlPlaneError(
        409,
        `driver '${driver}' cannot be rolled out: ${page.unreadable.join(', ')} ha${page.unreadable.length === 1 ? 's a version' : 've versions'} whose stores cannot be named`,
      );
    }
    const row = await admin.beginStoreDriverRollout(actor, { driver, sha256, action: deps.action, holder });
    const end = (state: 'good' | 'failed' | 'diverged', detail: string | null) =>
      admin.finishStoreDriverRollout(actor, { driver, seq: row.seq, holder, state, detail });
    const renew = async () => {
      const held = await admin.holdStoreDriver(actor, { driver, holder, mode: 'exclusive', ttlMs: ROLLOUT_HOLD_TTL_MS, renew: true, rolloutSeq: row.seq });
      if (!held) throw new HoldLost(driver);
    };

    try {
      await deps.ensureCanary(sha256).then(({ scriptName }) => canaryStoreRelease({ call: deps.callCanary, scriptName }));
    } catch (e) {
      // No vertical's script moved in this request; the current release stays. A row the end
      // cannot write (the hold lapsed) reads as diverged, which is what it then is.
      await end('failed', message(e)).catch(() => undefined);
      throw e;
    }

    const budget = deps.perRequest ?? ROLLOUT_VERTICALS_PER_REQUEST;
    const moved: string[] = [];
    // Every vertical this request reached. A request that pauses failed at none of them, so its
    // paused end records exactly the verticals whose ensure answered.
    const reached: StoreDriverRolloutTarget[] = [];
    for (const target of page.verticals) {
      if (moved.length >= budget) break;
      try {
        await renew();
        reached.push(target);
        const stores = target.stores.map((s) => ({ binding: s.binding, driver }));
        if (await deps.ensure({ vertical: target.vertical, stores, to: sha256 })) moved.push(target.vertical);
      } catch (e) {
        const detail = e instanceof HoldLost
          ? { state: 'diverged' as const, text: `Nothing was returned: ${reachedText(page.walked, reached)} may run ${sha256}.` }
          : await restore(deps, row, page.walked, reached, renew);
        await end(detail.state, `${target.vertical}: ${message(e)}. ${detail.text}`).catch(() => undefined);
        throw new ControlPlaneError(e instanceof ControlPlaneError ? e.status : 502, `${deps.action} of '${driver}' to ${sha256} stopped at ${target.vertical} (${message(e)}). ${detail.text}`);
      }
    }
    const remaining = page.pending - reached.length;
    if (remaining > 0) {
      const rollout = await admin.finishStoreDriverRollout(actor, {
        driver,
        seq: row.seq,
        holder,
        state: 'paused',
        detail: `this request walked ${reached.length} and moved ${moved.length}; ${remaining} vertical(s) not walked yet: post the same ${deps.action} again`,
        walked: reached,
      });
      return { rollout, moved, complete: false, remaining };
    }
    return { rollout: await end('good', null), moved, complete: true, remaining: 0 };
  } finally {
    await admin.releaseStoreDriverHold(actor, { driver, holder }).catch(() => undefined);
  }
}

/** The verticals an attempt reached, for a refusal: earlier requests' count, then this one's names. */
const reachedText = (before: number, reached: readonly StoreDriverRolloutTarget[]) => {
  const names = reached.map((t) => t.vertical).join(', ');
  if (before === 0) return names || 'no vertical';
  return `${before} vertical(s) earlier requests of this attempt walked${names ? ` and ${names}` : ''}`;
};

/**
 * Return every vertical a failed attempt reached to the release it started from, where that is
 * allowed, renewing the hold before each upload: the ones its earlier requests walked (the
 * ledger), then the ones this request reached. A hold that cannot be renewed stops the return.
 * More than one request returns ({@link ROLLOUT_WALKS_PER_REQUEST}) returns nothing and ends diverged.
 */
async function restore(
  deps: StoreDriverRolloutDeps,
  row: StoreDriverRolloutRecord,
  before: number,
  reached: readonly StoreDriverRolloutTarget[],
  renew: () => Promise<void>,
): Promise<{ state: 'failed' | 'diverged'; text: string }> {
  const from = row.fromSha256;
  const all = reachedText(before, reached);
  if (before + reached.length === 0) return { state: 'failed', text: 'No vertical moved.' };
  if (from === null) {
    return { state: 'diverged', text: `There is no earlier release to return to; ${all} may run ${deps.sha256}.` };
  }
  const leaving = schemaOf(deps.registration, deps.sha256);
  const returning = schemaOf(deps.registration, from);
  if (leaving === undefined || returning === undefined || returning < leaving) {
    return {
      state: 'diverged',
      text: `Returning to ${from} would lower the stored schema (${leaving} to ${returning}), so ${all} may run ${deps.sha256}.`,
    };
  }
  const max = deps.perRequestWalks ?? ROLLOUT_WALKS_PER_REQUEST;
  if (before + reached.length > max) {
    return {
      state: 'diverged',
      text: `The attempt reached ${before + reached.length} verticals, more than one request returns (${max}), so none was returned and they may run ${deps.sha256}: post a rollback, which converges every script on ${from} over as many requests as it takes.`,
    };
  }
  const earlier = before === 0 ? [] : (await deps.admin.storeDriverRolloutWalked(deps.actor, { driver: row.driver, seq: row.seq, limit: max })).verticals;
  const back = [...earlier, ...reached];
  const stuck: string[] = [];
  for (const [i, target] of back.entries()) {
    try {
      await renew();
    } catch {
      return { state: 'diverged', text: `The hold was lost while returning; ${back.slice(i).map((t) => t.vertical).join(', ')} may run ${deps.sha256}.` };
    }
    try {
      await deps.ensure({ vertical: target.vertical, stores: target.stores.map((s) => ({ binding: s.binding, driver: deps.registration.driver })), to: from });
    } catch (e) {
      stuck.push(`${target.vertical} (${message(e)})`);
    }
  }
  return stuck.length === 0
    ? { state: 'failed', text: `${back.map((t) => t.vertical).join(', ')} returned to ${from}.` }
    : { state: 'diverged', text: `Could not return ${stuck.join(', ')} to ${from}.` };
}
