/**
 * The fleet walk (RFC wire-signing follow-on 4): bring every deployed script's key lists, audience
 * and state to what the control plane gives now, so that a key listed, rotated, dropped or withdrawn
 * reaches every script, not only the ones an upload happens to reach. A vertical's serving script is
 * uploaded again at each promote, but a version's own script (its archive script, which a preview is
 * routed to) is uploaded once, at its push, and nothing else ever rewrites it.
 *
 * A person runs it, a pass at a time, and it reports before it changes anything:
 *
 * - **Dry run by default.** Without `apply` a pass only reads: the settings write is unreachable.
 * - **Bounded and resumable.** A pass walks at most `limit` scripts in a fixed order (verticals by
 *   slug; each one's serving script, then its versions' scripts by id) and answers the cursor the next
 *   pass starts from, `null` when the fleet is done.
 * - **Only scripts it can attribute.** The inventory is the registry's: a vertical's serving script and
 *   each of its versions' scripts. A script the registry does not name is never touched, nor is one
 *   whose name is the platform's own.
 * - **No call it does not need.** A script whose record already says it was given what the settings give
 *   now is not read. A script with no record, which the settings give nothing, is not read either: in an
 *   environment where the rollout was never set, a pass makes no call to the runtime at all.
 * - **One script's failure is that script's.** It is reported, recorded as an operational failure by
 *   reason, and the pass goes on.
 * - **A script it cannot vouch for is held.** When the read after an update differs, or the serve moved
 *   under it, the script's record is marked held, with the binding names that differed, and later passes
 *   leave it alone until a person names it in `release`, or an upload of it writes a fresh record.
 *
 * Each script it changes writes its capability record and that record's admin row in one directory
 * transaction (`recordWireAuth`), and each pass writes one `walkWireAuth` row. The settings write is
 * `wire-settings.ts`, which states the one risk it cannot rule out: a write landing between its last
 * read and its own. Do not run the walk while a push or promote of the same vertical is in flight.
 */
import {
  instant,
  LIST_PAGE_MAX,
  PLATFORM_SCRIPT_NAMES,
  storedDeployManifest,
  verticalSlug as verticalSlugSchema,
  type DeploymentWireAuth,
  type PlatformActorId,
  type WireAuthRecord,
} from '@substrat-run/contracts';
import type { HostAdmin } from '@substrat-run/kernel';
import type { FetchVerticalModulesFn } from './deploy.js';
import { applyWireSettings, CONCURRENT_RETRIES, type WireSettingsApi, type WireSettingsOutcome } from './wire-settings.js';
import { wireEntryOf, wireUploadGiven, type WireEntry, type WireUploadSettings } from './wire-upload.js';

/** A pass walks this many scripts when it names no limit. */
export const WIRE_WALK_LIMIT_DEFAULT = 25;
/** A pass walks at most this many scripts. */
export const WIRE_WALK_LIMIT_MAX = 50;
/** A pass releases at most this many held scripts. */
export const WIRE_WALK_RELEASE_MAX = 50;

const PAGE = 50;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** The cursor's position inside a vertical: just after its serving script. */
const AFTER_SERVING = '-';

/** Where a pass starts: inside a vertical, after its serving script or after one of its versions. */
export interface WireWalkCursor {
  readonly vertical: string;
  readonly after: string;
}

/** A cursor as a pass answers it, or `null` for one that is not one. Opaque to a caller. */
export function parseWireWalkCursor(text: string): WireWalkCursor | null {
  const at = text.lastIndexOf('|');
  if (at <= 0) return null;
  const vertical = text.slice(0, at);
  const after = text.slice(at + 1);
  if (!verticalSlugSchema.safeParse(vertical).success) return null;
  if (after !== AFTER_SERVING && !ULID.test(after)) return null;
  return { vertical, after };
}
const cursorText = (vertical: string, after: string) => `${vertical}|${after}`;

/** What a pass did, or in a dry run would do, with one script. */
export type WireWalkAction =
  /** Its record says it was given what the settings give now: not read. */
  | 'current'
  /** No record, and the settings give it nothing: not read. */
  | 'unrecorded'
  /** Held by an earlier pass and not released: not read. */
  | 'held'
  /** Read: it already carries what the settings give now. Applied, its record is refreshed. */
  | 'unchanged'
  /** A dry run: these settings would change. */
  | 'would-change'
  /** Updated, verified and recorded. */
  | 'updated'
  /** Not done, for `reason`; held as well when the reason says the script could not be vouched for. */
  | 'failed';

export interface WireWalkScript {
  readonly deploymentRef: string;
  readonly vertical: string;
  readonly versionId: string | null;
  readonly kind: 'serving' | 'version';
  readonly action: WireWalkAction;
  /** The settings that differ (`would-change`, `updated`), by name. */
  readonly changes?: readonly string[];
  /** Why it failed: `concurrent-change`, `serve-in-flight`, `verify`, `entry-unknown`, `settings` or `record`. */
  readonly reason?: string;
  /** For `verify`: the binding names that differed. Never a value. */
  readonly bindings?: readonly string[];
  /** Whether the pass left the script held. */
  readonly held?: true;
  /** Whether it was held and a person released it for this pass. */
  readonly released?: true;
}

export interface WireWalkPass {
  readonly apply: boolean;
  /** The cursor the pass started from, `null` for the start of the fleet. */
  readonly from: string | null;
  /** Where the next pass starts, or `null` when this one reached the end of the fleet. */
  readonly next: string | null;
  readonly scripts: readonly WireWalkScript[];
}

export interface WireWalkDeps {
  readonly admin: HostAdmin;
  readonly actor: PlatformActorId;
  readonly settings: WireUploadSettings | undefined;
  readonly api: WireSettingsApi;
  /** Reads a script's modules back, to learn whether a script with no record carries the platform's entry. */
  readonly fetchModules?: FetchVerticalModulesFn;
  /** Records a script's failure as an operational failure: names, reasons and binding names only. */
  readonly fail: (entry: { readonly vertical: string; readonly version: string | null; readonly stage: string; readonly message: string }) => void;
  readonly now?: () => Date;
}

interface InventoryScript {
  readonly vertical: string;
  readonly deploymentRef: string;
  readonly versionId: string | null;
  readonly kind: 'serving' | 'version';
  readonly cursor: string;
}

/** The registry's scripts in walk order, from `from` on: each vertical's serving script, then its versions' scripts. */
async function* inventory(admin: HostAdmin, actor: PlatformActorId, from: WireWalkCursor | null): AsyncGenerator<InventoryScript> {
  async function* scriptsOf(vertical: string, after: string | null): AsyncGenerator<InventoryScript> {
    const serving = await admin.verticalServing(actor, vertical);
    const servingRef = serving && !PLATFORM_SCRIPT_NAMES.has(serving.ref) ? serving.ref : null;
    if (after === null && servingRef !== null) {
      yield { vertical, deploymentRef: servingRef, versionId: serving!.versionId, kind: 'serving', cursor: cursorText(vertical, AFTER_SERVING) };
    }
    let cursor = after !== null && after !== AFTER_SERVING ? after : undefined;
    for (;;) {
      const versions = await admin.listVersions(actor, vertical, { limit: PAGE, ...(cursor ? { cursor } : {}) });
      for (const v of versions) {
        const ref = v.deploymentRef;
        if (ref === null || ref === servingRef || PLATFORM_SCRIPT_NAMES.has(ref)) continue;
        yield { vertical, deploymentRef: ref, versionId: v.id, kind: 'version', cursor: cursorText(vertical, v.id) };
      }
      if (versions.length < PAGE) return;
      cursor = versions.at(-1)!.id;
    }
  }
  let slugCursor: string | undefined;
  if (from) {
    yield* scriptsOf(from.vertical, from.after);
    slugCursor = from.vertical;
  }
  for (;;) {
    const verticals = await admin.listVerticals(actor, { limit: PAGE, ...(slugCursor ? { cursor: slugCursor } : {}) });
    for (const v of verticals) yield* scriptsOf(v.slug, null);
    if (verticals.length < PAGE) return;
    slugCursor = verticals.at(-1)!.slug;
  }
}

/** Whether a record already holds what a given record says, in what a script carries: the state, the audience and the key ids. */
function carriesAlready(stored: WireAuthRecord, given: WireAuthRecord): boolean {
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  return (
    stored.state === given.state &&
    stored.audience === given.audience &&
    same(stored.routerKids, given.routerKids) &&
    same(stored.platformKids, given.platformKids)
  );
}

/** Run one pass. Never throws for one script's failure; throws only for a directory read that fails. */
export async function runWireWalk(
  deps: WireWalkDeps,
  input: { readonly apply: boolean; readonly cursor: WireWalkCursor | null; readonly limit: number; readonly release: readonly string[] },
): Promise<WireWalkPass> {
  const { admin, actor, settings, api } = deps;
  const now = deps.now ?? (() => new Date());
  const release = new Set(input.release);
  const records = new Map<string, Map<string, DeploymentWireAuth>>();
  const recordsOf = async (vertical: string) => {
    let held = records.get(vertical);
    if (held) return held;
    held = new Map();
    let cursor: string | undefined;
    for (;;) {
      const page = await admin.listWireAuth!(actor, { reach: { fleet: true }, verticalSlug: vertical, limit: LIST_PAGE_MAX, ...(cursor ? { cursor } : {}) });
      for (const r of page) held.set(r.deploymentRef, r);
      if (page.length < LIST_PAGE_MAX) break;
      cursor = page.at(-1)!.deploymentRef;
    }
    records.clear(); // one vertical at a time: the walk moves through them in order
    records.set(vertical, held);
    return held;
  };
  const record = (script: InventoryScript, rec: WireAuthRecord) =>
    admin.recordWireAuth!(actor, { deploymentRef: script.deploymentRef, verticalSlug: script.vertical, versionId: script.versionId, record: rec, recordedAt: now().toISOString() });

  /** Whether the script's bundle carries the platform's entry, read back from the script itself. */
  const entryOf = async (script: InventoryScript): Promise<WireEntry | null> => {
    if (!deps.fetchModules || script.versionId === null) return null;
    const manifestJson = await admin.versionManifest(actor, script.vertical, script.versionId);
    if (!manifestJson) return null;
    const manifest = storedDeployManifest.parse(JSON.parse(manifestJson));
    return wireEntryOf({ entry: manifest.entry, modules: await deps.fetchModules(script.deploymentRef) });
  };

  const walkOne = async (script: InventoryScript): Promise<WireWalkScript> => {
    const stored = (await recordsOf(script.vertical)).get(script.deploymentRef);
    const wasHeld = stored?.record.walkHold !== undefined;
    const base = {
      deploymentRef: script.deploymentRef,
      vertical: script.vertical,
      versionId: script.versionId,
      kind: script.kind,
      ...(wasHeld && release.has(script.deploymentRef) ? { released: true as const } : {}),
    };
    if (wasHeld && !release.has(script.deploymentRef)) return { ...base, action: 'held' };
    const failed = (reason: string, message: string, extra: Partial<WireWalkScript> = {}): WireWalkScript => {
      deps.fail({ vertical: script.vertical, version: script.versionId, stage: reason, message: `the wire walk did not bring '${script.deploymentRef}' current: ${message}` });
      return { ...base, action: 'failed', reason, ...extra };
    };
    /**
     * Mark the script held: what was last known (its record, or what it was being given when it had
     * none), no longer vouched for. Answers whether the hold was written; when it was not, the
     * operational failure, which names the script, is the trace.
     */
    const hold = async (last: WireAuthRecord, reason: 'verify' | 'serve-in-flight', bindings: readonly string[]): Promise<boolean> => {
      const { walkHold: _previous, ...known } = last;
      return record(script, { ...known, walkHold: { reason, bindings: [...bindings], at: instant.parse(now().toISOString()) } }).then(
        () => true,
        () => false,
      );
    };

    try {
      let entry: WireEntry | null = stored ? { envelope: stored.record.envelope, entrySkipped: stored.record.entrySkipped } : null;
      if (!entry) {
        // No record: an upload from before records existed, or one whose record was not written. The
        // settings decide whether it needs reading at all; whether it carries the entry needs its bundle.
        const probe = await wireUploadGiven(settings, { vertical: script.vertical, deploymentRef: script.deploymentRef, entry: { envelope: 1, entrySkipped: null } });
        if (probe.bindings.length === 0) return { ...base, action: 'unrecorded' };
        entry = await entryOf(script);
        if (!entry) return failed('entry-unknown', 'no record, and no stored manifest to read its entry from: upload it again');
      }
      const given = await wireUploadGiven(settings, { vertical: script.vertical, deploymentRef: script.deploymentRef, entry });
      if (stored && !stored.record.walkHold && carriesAlready(stored.record, given.record)) return { ...base, action: 'current' };

      let outcome: WireSettingsOutcome;
      try {
        outcome = await applyWireSettings(
          api,
          script.deploymentRef,
          given.bindings.map((b) => ({ name: b.name, text: b.text })),
          {
            apply: input.apply,
            ...(script.kind === 'serving' && script.versionId !== null
              ? {
                  servedVersion: script.versionId,
                  servedVersionAfter: async () => (await admin.verticalServing(actor, script.vertical))?.versionId ?? null,
                }
              : {}),
          },
        );
      } catch (error) {
        // The settings API's own messages name the script and a status, never a value.
        return failed('settings', error instanceof Error ? error.message : 'the settings call failed');
      }
      switch (outcome.outcome) {
        case 'would-change':
          return { ...base, action: 'would-change', changes: outcome.changes };
        case 'unchanged':
        case 'updated': {
          if (input.apply) {
            try {
              await record(script, given.record);
            } catch {
              return failed('record', 'its settings are current, but its record was not written');
            }
          }
          return outcome.outcome === 'updated' ? { ...base, action: 'updated', changes: outcome.changes } : { ...base, action: 'unchanged' };
        }
        case 'concurrent-change':
          return failed('concurrent-change', `its bindings changed between reads ${CONCURRENT_RETRIES} times; nothing was written`);
        case 'serve-in-flight': {
          if (!outcome.written) return failed('serve-in-flight', 'it does not run the version the directory says it serves; nothing was written: promote again, then walk');
          const held = await hold(stored?.record ?? given.record, 'serve-in-flight', []);
          return failed('serve-in-flight', `the served version moved while it was updated${held ? ': held until a person looks' : ''}; promote again, then release it`, held ? { held: true } : {});
        }
        case 'verify': {
          const held = await hold(stored?.record ?? given.record, 'verify', outcome.bindings);
          return failed(
            'verify',
            `${held ? 'held until a person looks: ' : ''}after its update, these bindings read differently: ${outcome.bindings.join(', ')}`,
            { bindings: outcome.bindings, ...(held ? { held: true as const } : {}) },
          );
        }
      }
    } catch {
      // A read for this one script (its stored manifest, its modules) failed. Its text is not echoed:
      // nothing here vouches that it carries no value.
      return failed('entry-unknown', 'its stored manifest or its modules could not be read');
    }
  };

  const scripts: WireWalkScript[] = [];
  let next: string | null = null;
  for await (const script of inventory(admin, actor, input.cursor)) {
    scripts.push(await walkOne(script));
    if (scripts.length >= input.limit) {
      next = script.cursor;
      break;
    }
  }
  return { apply: input.apply, from: input.cursor ? cursorText(input.cursor.vertical, input.cursor.after) : null, next, scripts };
}
