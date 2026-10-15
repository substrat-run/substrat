/**
 * A store kind's releases: stored, canaried, rolled out and rolled back (D-63, #2300).
 *
 * The bytes live outside the directory, content-addressed under `<kind>/<sha256>`, where the
 * sha256 is `storeKindReleaseDigest` of the bundle, computed here when it arrives and again by
 * the ensurer before every upload of it, restore and rollback included. The directory holds who
 * uploaded which release from which commit, every rollout, and the current good release
 * (`store-kind-releases.ts` in the kernel).
 *
 * A rollout is one request across a fleet. It holds the kind exclusively for its whole length,
 * renewing the hold before every upload, so no push or serve rebuilds a script between the
 * rollout's read and its upload, and two rollouts never interleave. It canaries the release on the
 * platform's own object first, and no vertical's script moves unless every reserved operation
 * answered there. Then it moves each vertical that ever declared the kind, at most
 * {@link ROLLOUT_VERTICALS_PER_REQUEST} per request: a bigger fleet, or a request that stops,
 * leaves the rollout `diverged`, and posting the same rollout again converges it, skipping the
 * scripts already there.
 */
import {
  STORE_RELEASE_MAX_BYTES,
  scopeStoreCanaryObjectName,
  storeKindReleaseDigest,
  storeKindReleaseUpload,
  type PlatformActorId,
  type ReservedStoreOperation,
  type ScopeStoreNeed,
  type StoreKindRegistration,
} from '@substrat-run/contracts';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { createUlid, ulid, type HostAdmin, type StoreKindRolloutAction, type StoreKindRolloutRecord } from '@substrat-run/kernel';
import { assertPythonKindModules } from './store-entry.js';
import type { ScopeStoreEnsurerOptions, StoreKindReleaseArtifact } from './store-script.js';

/** Where a release's bytes are kept: an object store keyed by kind and sha256. */
export interface StoreReleaseBytes {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

/** The key a release's bytes are stored under. */
export const storeReleaseKey = (kind: string, sha256: string): string => `${kind}/${sha256}`;

/** How long a rollout's exclusive hold lives between renewals. */
export const ROLLOUT_HOLD_TTL_MS = 10 * 60_000;
/** How long a push's or a serve's shared hold lives: one store ensure. */
export const PUSH_HOLD_TTL_MS = 2 * 60_000;
/**
 * The verticals one rollout request moves. Each costs a settings read and at most one upload,
 * plus a hold renewal, so a request stays well inside a Worker invocation's subrequest budget.
 * A fleet bigger than this is moved over several requests (the rollout answers `complete: false`).
 */
export const ROLLOUT_VERTICALS_PER_REQUEST = 100;
/**
 * The most verticals one rollout walks. Every one costs a settings read and a hold renewal even
 * when it is already at the release, so a bigger fleet would outrun one invocation; it is refused
 * (409) rather than left unable to converge. Raising it needs a cursor on the rollout row.
 */
export const ROLLOUT_FLEET_MAX = 300;

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
 * decoded size cap, and the Python kind's module rule. Refusals are 422 (413 for the size).
 */
export function decodeStoreKindRelease(raw: unknown): Omit<StoreKindReleaseArtifact, 'sha256'> {
  const parsed = storeKindReleaseUpload.safeParse(raw);
  if (!parsed.success) {
    throw new ControlPlaneError(422, `not a store kind release: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  let total = 0;
  const modules = parsed.data.modules.map((module) => {
    const content = decodeBase64(module.contentBase64);
    total += content.byteLength;
    if (total > STORE_RELEASE_MAX_BYTES) {
      throw new ControlPlaneError(413, `a store kind release carries at most ${STORE_RELEASE_MAX_BYTES} module bytes`);
    }
    return { name: module.name, content };
  });
  const release = { sourceCommit: parsed.data.sourceCommit, entry: parsed.data.entry, modules };
  try {
    assertPythonKindModules(release);
  } catch (e) {
    throw new ControlPlaneError(422, e instanceof Error ? e.message : String(e));
  }
  return release;
}

/** The stored form: the upload body again, so one decoder reads both. */
function encodeStoreKindRelease(release: Omit<StoreKindReleaseArtifact, 'sha256'>): Uint8Array {
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
export async function storeKindRelease(input: {
  admin: HostAdmin;
  actor: PlatformActorId;
  bytes: StoreReleaseBytes;
  kind: string;
  body: unknown;
}) {
  const release = decodeStoreKindRelease(input.body);
  const sha256 = await storeKindReleaseDigest(release).catch((e: unknown) => {
    throw new ControlPlaneError(422, e instanceof Error ? e.message : String(e));
  });
  const held = await input.admin.getStoreKindRelease(input.actor, input.kind, sha256);
  if (held && held.sourceCommit !== release.sourceCommit) {
    throw new ControlPlaneError(409, `release ${sha256} of '${input.kind}' is stored as built from ${held.sourceCommit}`);
  }
  if (!held) await input.bytes.put(storeReleaseKey(input.kind, sha256), encodeStoreKindRelease(release));
  return input.admin.recordStoreKindRelease(input.actor, { kind: input.kind, sha256, sourceCommit: release.sourceCommit });
}

/**
 * The ensurer's loader over the stored bytes: a named release, or the kind's current good one.
 * Each answer carries the sha256 it was read as, which the ensurer holds the bytes to.
 */
export function storedReleaseLoader(input: { admin: HostAdmin; actor: PlatformActorId; bytes: StoreReleaseBytes }): LoadRelease {
  return async ({ kind, sha256 }) => {
    const wanted = sha256 ?? (await input.admin.storeKindState(input.actor, kind)).current?.sha256;
    if (!wanted) return undefined;
    const raw = await input.bytes.get(storeReleaseKey(kind, wanted));
    if (!raw) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new ControlPlaneError(422, `kind '${kind}' release ${wanted} is stored as something other than a release`);
    }
    return { ...decodeStoreKindRelease(json), sha256: wanted };
  };
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

export interface StoreKindRolloutDeps {
  admin: HostAdmin;
  actor: PlatformActorId;
  registration: StoreKindRegistration;
  sha256: string;
  action: StoreKindRolloutAction;
  /**
   * Move one vertical's scripts of the kind to `to` (the push's ensurer, with `to`). Answers
   * whether anything was uploaded: false for a script already there, built the same way.
   */
  ensure: (input: { vertical: string; stores: readonly ScopeStoreNeed[]; to: string }) => Promise<boolean>;
  /** Put `to` in the kind's canary script; answers its name. */
  ensureCanary: (to: string) => Promise<{ scriptName: string }>;
  callCanary: CanaryCall;
  /** For a test: a smaller batch than {@link ROLLOUT_VERTICALS_PER_REQUEST}. */
  perRequest?: number;
}

export interface StoreKindRolloutResult {
  rollout: StoreKindRolloutRecord;
  /** The verticals whose scripts this request uploaded. */
  moved: string[];
  /** False when verticals remain: post the same rollout again. */
  complete: boolean;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const schemaOf = (registration: StoreKindRegistration, sha256: string | null) =>
  sha256 === null ? undefined : registration.releases.find((pin) => pin.sha256 === sha256)?.schema;

/** The hold lapsed, or another holder ended the rollout: nothing more may be moved under it. */
class HoldLost extends ControlPlaneError {
  constructor(kind: string) {
    super(409, `the hold on kind '${kind}' lapsed or its rollout was ended by another; post the rollout again to converge it`);
  }
}

/**
 * Move every script of a kind to a stored, pinned release (D-63): hold, canary, then each
 * vertical. A failure after a vertical moved returns every vertical it reached to the release
 * the rollout started from, rehashing those bytes as it uploads them, and ends `failed`. It ends
 * `diverged` instead, naming what is where, when there is nothing to return to (a kind's first
 * rollout), when returning would lower the stored schema, or when a return fails: the next
 * rollout or rollback converges every script. The hold is renewed before every upload, the
 * returns included, and a hold that cannot be renewed stops everything at once: another holder
 * may be moving the same scripts, so nothing is returned either. The hold is released however it
 * ends.
 *
 * Each request uploads at most `perRequest` scripts. A vertical already at the release is
 * walked past without counting, so posting the same rollout again continues where the last
 * request stopped, and a fleet of any size within {@link ROLLOUT_FLEET_MAX} converges.
 */
export async function runStoreKindRollout(deps: StoreKindRolloutDeps): Promise<StoreKindRolloutResult> {
  const { admin, actor, registration, sha256 } = deps;
  const kind = registration.kind;
  const holder = ulid();
  if (!(await admin.holdStoreKind(actor, { kind, holder, mode: 'exclusive', ttlMs: ROLLOUT_HOLD_TTL_MS }))) {
    throw new ControlPlaneError(409, `kind '${kind}' is being rolled out or a vertical declaring it is being pushed; try again shortly`);
  }
  try {
    const declared = await admin.storeKindDeclarations(actor, kind);
    if (declared.unreadable.length > 0) {
      throw new ControlPlaneError(
        409,
        `kind '${kind}' cannot be rolled out: ${declared.unreadable.join(', ')} ha${declared.unreadable.length === 1 ? 's a version' : 've versions'} whose stores cannot be named`,
      );
    }
    if (declared.verticals.length > ROLLOUT_FLEET_MAX) {
      throw new ControlPlaneError(
        409,
        `kind '${kind}' is declared by ${declared.verticals.length} verticals; a rollout walks at most ${ROLLOUT_FLEET_MAX} per request`,
      );
    }
    const row = await admin.beginStoreKindRollout(actor, { kind, sha256, action: deps.action, holder });
    const end = (state: 'good' | 'failed' | 'diverged', detail: string | null) =>
      admin.finishStoreKindRollout(actor, { kind, seq: row.seq, holder, state, detail });
    const renew = async () => {
      const held = await admin.holdStoreKind(actor, { kind, holder, mode: 'exclusive', ttlMs: ROLLOUT_HOLD_TTL_MS, renew: true, rolloutSeq: row.seq });
      if (!held) throw new HoldLost(kind);
    };

    try {
      await deps.ensureCanary(sha256).then(({ scriptName }) => canaryStoreRelease({ call: deps.callCanary, scriptName }));
    } catch (e) {
      // No vertical's script moved; the current release stays. A row the end cannot write (the
      // hold lapsed) reads as diverged, which is what it then is.
      await end('failed', message(e)).catch(() => undefined);
      throw e;
    }

    const targets = declared.verticals.map((v) => ({ vertical: v.vertical, stores: v.stores.map((s) => ({ binding: s.binding, kind })) }));
    const budget = deps.perRequest ?? ROLLOUT_VERTICALS_PER_REQUEST;
    // Every vertical walked: the ones moved now, and the ones an earlier request moved.
    const reached: string[] = [];
    const moved: string[] = [];
    for (const target of targets) {
      if (moved.length >= budget) {
        const rest = targets.length - reached.length;
        const rollout = await end('diverged', `this request moved ${moved.length}; ${rest} vertical(s) not walked yet: post the rollout again`);
        return { rollout, moved, complete: false };
      }
      try {
        await renew();
        reached.push(target.vertical);
        if (await deps.ensure({ vertical: target.vertical, stores: target.stores, to: sha256 })) moved.push(target.vertical);
      } catch (e) {
        const detail = e instanceof HoldLost
          ? { state: 'diverged' as const, text: `Nothing was returned: ${reached.join(', ') || 'no vertical'} may run ${sha256}.` }
          : await restore(deps, row.fromSha256, reached, targets, renew);
        await end(detail.state, `${target.vertical}: ${message(e)}. ${detail.text}`).catch(() => undefined);
        throw new ControlPlaneError(e instanceof ControlPlaneError ? e.status : 502, `rollout of '${kind}' to ${sha256} stopped at ${target.vertical} (${message(e)}). ${detail.text}`);
      }
    }
    return { rollout: await end('good', null), moved, complete: true };
  } finally {
    await admin.releaseStoreKindHold(actor, { kind, holder }).catch(() => undefined);
  }
}

/**
 * Return every vertical a failed rollout reached to the release it started from, where that is
 * allowed, renewing the hold before each upload. A hold that cannot be renewed stops the return.
 */
async function restore(
  deps: StoreKindRolloutDeps,
  from: string | null,
  reached: readonly string[],
  verticals: readonly { vertical: string; stores: readonly ScopeStoreNeed[] }[],
  renew: () => Promise<void>,
): Promise<{ state: 'failed' | 'diverged'; text: string }> {
  if (reached.length === 0) return { state: 'failed', text: 'No vertical moved.' };
  if (from === null) {
    return { state: 'diverged', text: `There is no earlier release to return to; ${reached.join(', ')} may run ${deps.sha256}.` };
  }
  const leaving = schemaOf(deps.registration, deps.sha256);
  const returning = schemaOf(deps.registration, from);
  if (leaving === undefined || returning === undefined || returning < leaving) {
    return {
      state: 'diverged',
      text: `Returning to ${from} would lower the stored schema (${leaving} to ${returning}), so ${reached.join(', ')} may run ${deps.sha256}.`,
    };
  }
  const stuck: string[] = [];
  for (const [i, vertical] of reached.entries()) {
    try {
      await renew();
    } catch {
      return { state: 'diverged', text: `The hold was lost while returning; ${reached.slice(i).join(', ')} may run ${deps.sha256}.` };
    }
    const target = verticals.find((v) => v.vertical === vertical)!;
    try {
      await deps.ensure({ vertical, stores: target.stores, to: from });
    } catch (e) {
      stuck.push(`${vertical} (${message(e)})`);
    }
  }
  return stuck.length === 0
    ? { state: 'failed', text: `${reached.join(', ')} returned to ${from}.` }
    : { state: 'diverged', text: `Could not return ${stuck.join(', ')} to ${from}.` };
}
