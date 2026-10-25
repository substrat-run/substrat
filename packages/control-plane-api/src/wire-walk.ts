/**
 * The fleet walk (RFC wire-signing follow-on 4): bring every deployed script's key lists, audience
 * and state to what the control plane gives now, so that a key listed, rotated, dropped or withdrawn
 * reaches every script, not only the ones an upload happens to reach. A vertical's serving script is
 * uploaded again at each promote, but a version's own script (its archive script, which a preview is
 * routed to) is uploaded once, at its push, and nothing else ever rewrites it.
 *
 * A person runs it, a pass at a time, and it reports before it changes anything:
 *
 * - **Dry run by default.** Without `apply` a pass only reads: the settings write is unreachable, no
 *   operational failure is filed and no hold is released.
 * - **Bounded and resumable.** A pass walks at most `limit` scripts in a fixed order (verticals by
 *   slug; each one's serving script, then its versions' scripts by id) and answers the cursor the next
 *   pass starts from, `null` when the fleet is done. A vertical deleted since it was listed, or named by
 *   a saved cursor, is passed over.
 * - **Only scripts it can attribute.** The inventory is the registry's: a vertical's serving script and
 *   each of its versions' scripts. A script the registry does not name is never touched, nor is one
 *   whose name is the platform's own.
 * - **No call it does not need.** A script whose record already says it was given what the settings give
 *   now is not read. A script with no record, which the settings give nothing, is not read either: in an
 *   environment where the rollout was never set, a pass makes no call to the runtime at all. A
 *   **confirming** pass (`confirm`) reads every recorded script instead, trusting no record; a held
 *   script, and one with no record that nothing is given or that is skipped, it leaves unread as well.
 * - **Only a script that verifies is given lists by it.** A script with no record is read back first, on
 *   every pass that reaches it (no verdict is kept between passes: pushing it again gives it a record);
 *   one that runs without the platform's entry is skipped (`no-entry`), never recorded as verifying.
 * - **One script's failure is that script's.** It is reported, recorded as an operational failure by
 *   reason, and the pass goes on.
 * - **A script it cannot vouch for is held.** When the read after an update differs, or the serve moved
 *   under it, the script's record is marked held, with the binding names that differed, and later passes
 *   leave it alone until a person names it in `release`, or an upload of it writes a fresh record.
 *
 * Each script it changes writes its capability record and that record's admin row in one directory
 * transaction (`recordWireAuth`), and each pass writes one `walkWireAuth` row. The settings write is
 * `wire-settings.ts`. Do not run the walk while a push or promote of the same vertical is in flight,
 * and end with a confirming pass.
 */
import {
  errorCodeOf,
  instant,
  LIST_PAGE_MAX,
  PLATFORM_SCRIPT_NAMES,
  storedDeployManifest,
  verticalSlug as verticalSlugSchema,
  WALK_HOLD_BINDINGS_MAX,
  type DeploymentWireAuth,
  type PlatformActorId,
  type WireAuthRecord,
} from '@substrat-run/contracts';
import type { HostAdmin } from '@substrat-run/kernel';
import type { FetchVerticalModulesFn } from './deploy.js';
import { PLATFORM_ENTRY_MODULE } from './platform-entry.js';
import { applyWireSettings, CONCURRENT_RETRIES, type WireSettingsApi, type WireSettingsOutcome } from './wire-settings.js';
import { wireEntryOf, wireUploadGiven, type WireEntry, type WireUploadSettings } from './wire-upload.js';

/** A pass walks this many scripts when it names no limit. */
export const WIRE_WALK_LIMIT_DEFAULT = 25;
/** A pass walks at most this many scripts. */
export const WIRE_WALK_LIMIT_MAX = 50;
/** A pass releases at most this many held scripts. */
export const WIRE_WALK_RELEASE_MAX = 50;

const PAGE = 50;
const GONE: unique symbol = Symbol('gone');
/** The cursor's position inside a vertical just after its serving script: nothing after the `|`. */
const AFTER_SERVING = '';

/**
 * Where a pass starts: inside a vertical, after its serving script (`after` empty) or after one of its
 * versions (`after` that version's id, whatever its spelling: the publish route takes any id).
 */
export interface WireWalkCursor {
  readonly vertical: string;
  readonly after: string;
}

/**
 * A cursor as a pass answers it, or `null` for one that is not one. Opaque to a caller. A slug never
 * holds a `|`, so the first one ends it, and everything after it is the position.
 */
export function parseWireWalkCursor(text: string): WireWalkCursor | null {
  const at = text.indexOf('|');
  if (at <= 0) return null;
  const vertical = text.slice(0, at);
  if (!verticalSlugSchema.safeParse(vertical).success) return null;
  return { vertical, after: text.slice(at + 1) };
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
  /** Not given lists, for `reason`: `no-entry`, a script with no record that runs without the platform's entry. */
  | 'skipped'
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
  /**
   * Why it failed (`concurrent-change`, `serve-in-flight`, `verify`, `entry-unknown`, `settings`,
   * `settings-refused` or `record`), or was skipped (`no-entry`).
   */
  readonly reason?: string;
  /** For `verify`: the binding names that differed. Never a value. */
  readonly bindings?: readonly string[];
  /** For `verify`: how many more bindings differed than `bindings` names (it keeps the first `WALK_HOLD_BINDINGS_MAX`). */
  readonly more?: number;
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
  /** A directory read of one vertical, or `gone` when the vertical no longer exists (deleted since it was listed, or named by a saved cursor). */
  const ofVertical = async <T>(read: () => Promise<T>): Promise<T | typeof GONE> => {
    try {
      return await read();
    } catch (error) {
      if (errorCodeOf(error) === 'not_found') return GONE;
      throw error;
    }
  };
  async function* scriptsOf(vertical: string, after: string | null): AsyncGenerator<InventoryScript> {
    const serving = await ofVertical(() => admin.verticalServing(actor, vertical));
    if (serving === GONE) return;
    const servingRef = serving && !PLATFORM_SCRIPT_NAMES.has(serving.ref) ? serving.ref : null;
    if (after === null && servingRef !== null) {
      yield { vertical, deploymentRef: servingRef, versionId: serving!.versionId, kind: 'serving', cursor: cursorText(vertical, AFTER_SERVING) };
    }
    let cursor = after !== null && after !== AFTER_SERVING ? after : undefined;
    for (;;) {
      const versions = await ofVertical(() => admin.listVersions(actor, vertical, { limit: PAGE, ...(cursor ? { cursor } : {}) }));
      if (versions === GONE) return;
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
  input: {
    readonly apply: boolean;
    readonly cursor: WireWalkCursor | null;
    readonly limit: number;
    readonly release: readonly string[];
    /** A confirming pass: read every recorded script, never trusting its record (no `current`). */
    readonly confirm?: boolean;
    /**
     * Where each script's result is put as soon as it is known: the caller's, so a pass that ends in a
     * throw still says what it did. Defaults to a fresh list.
     */
    readonly sink?: WireWalkScript[];
  },
): Promise<WireWalkPass> {
  const { admin, actor, settings, api } = deps;
  const now = deps.now ?? (() => new Date());
  const release = new Set(input.apply ? input.release : []);
  const recordsBy = async (vertical: string) => {
    const held = new Map<string, DeploymentWireAuth>();
    let cursor: string | undefined;
    for (;;) {
      const page = await admin.listWireAuth!(actor, { reach: { fleet: true }, verticalSlug: vertical, limit: LIST_PAGE_MAX, ...(cursor ? { cursor } : {}) });
      for (const r of page) held.set(r.deploymentRef, r);
      if (page.length < LIST_PAGE_MAX) return held;
      cursor = page.at(-1)!.deploymentRef;
    }
  };
  const records = new Map<string, Map<string, DeploymentWireAuth>>();
  const recordsOf = async (vertical: string) => {
    let held = records.get(vertical);
    if (held) return held;
    held = await recordsBy(vertical);
    records.clear(); // one vertical at a time: the walk moves through them in order
    records.set(vertical, held);
    return held;
  };
  const record = (script: InventoryScript, rec: WireAuthRecord, versionId: string | null = script.versionId) =>
    admin.recordWireAuth!(actor, { deploymentRef: script.deploymentRef, verticalSlug: script.vertical, versionId, record: rec, recordedAt: now().toISOString() });

  /**
   * Whether the script carries the platform's entry, which holds the verifier, read back from the
   * script itself: its modules must hold the entry module, and its own bundle must be one the entry
   * wraps. `no-manifest` when it cannot be told; `no-entry` when the script runs without one.
   */
  const entryOf = async (script: InventoryScript): Promise<WireEntry | 'no-manifest' | 'no-entry'> => {
    if (!deps.fetchModules || script.versionId === null) return 'no-manifest';
    const manifestJson = await admin.versionManifest(actor, script.vertical, script.versionId);
    if (!manifestJson) return 'no-manifest';
    const manifest = storedDeployManifest.parse(JSON.parse(manifestJson));
    const modules = await deps.fetchModules(script.deploymentRef);
    if (!modules.some((m) => m.name === PLATFORM_ENTRY_MODULE)) return 'no-entry';
    const entry = wireEntryOf({ entry: manifest.entry, modules });
    return entry.envelope === null ? 'no-entry' : entry;
  };

  const walkOne = async (script: InventoryScript): Promise<WireWalkScript> => {
    const stored = (await recordsOf(script.vertical)).get(script.deploymentRef);
    const wasHeld = stored?.record.walkHold !== undefined;
    const base = { deploymentRef: script.deploymentRef, vertical: script.vertical, versionId: script.versionId, kind: script.kind };
    if (wasHeld && !release.has(script.deploymentRef)) return { ...base, action: 'held' };
    /** A failure: reported, and recorded as an operational failure when the pass applies (a dry run attempts nothing). */
    const failed = (reason: string, message: string, extra: Partial<WireWalkScript> = {}): WireWalkScript => {
      if (input.apply) {
        deps.fail({ vertical: script.vertical, version: script.versionId, stage: reason, message: `the wire walk did not bring '${script.deploymentRef}' current: ${message}` });
      }
      return { ...base, action: 'failed', reason, ...extra };
    };
    /**
     * Mark the script held: a script the walk wrote and could not confirm is never left without one.
     * It holds the record as it stands now, read again (an upload's record written during the pass
     * included, which the hold keeps and marks), or, with none, a record that claims no lists
     * (`unverified`). It keeps the first `WALK_HOLD_BINDINGS_MAX` binding names and counts the rest.
     * A write that fails is tried once more; answers whether the hold was written, and the failure the
     * walk reports says so when it was not.
     */
    const hold = async (entry: WireEntry, reason: 'verify' | 'serve-in-flight', bindings: readonly string[]): Promise<boolean> => {
      const once = async () => {
        const latest = (await recordsBy(script.vertical)).get(script.deploymentRef);
        const known: WireAuthRecord = latest
          ? (({ walkHold: _previous, ...rest }) => rest)(latest.record)
          : { ...entry, state: 'legacy-only', audience: null, routerKids: [], platformKids: [], withheld: 'unverified' };
        const kept = bindings.slice(0, WALK_HOLD_BINDINGS_MAX);
        const more = bindings.length - kept.length;
        const walkHold = { reason, bindings: [...kept], ...(more > 0 ? { more } : {}), at: instant.parse(now().toISOString()) };
        // Under the version the record it marks names: an upload's record keeps its upload's version.
        await record(script, { ...known, walkHold }, latest ? latest.versionId : script.versionId);
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await once();
          return true;
        } catch {
          // Tried once more, then reported.
        }
      }
      return false;
    };
    /** Binding names for a person to read: the first `WALK_HOLD_BINDINGS_MAX`, and how many more. */
    const named = (bindings: readonly string[]) =>
      bindings.length > WALK_HOLD_BINDINGS_MAX
        ? `${bindings.slice(0, WALK_HOLD_BINDINGS_MAX).join(', ')} and ${bindings.length - WALK_HOLD_BINDINGS_MAX} more`
        : bindings.join(', ');
    const holdNote = (held: boolean) => (held ? 'held until a person looks' : 'and the hold itself could not be written: look at it now');

    try {
      let entry: WireEntry | null = stored ? { envelope: stored.record.envelope, entrySkipped: stored.record.entrySkipped } : null;
      if (!entry) {
        // No record: an upload from before records existed, or one whose record was not written. The
        // settings decide whether it needs reading at all; whether it carries the entry needs its bundle.
        const probe = await wireUploadGiven(settings, { vertical: script.vertical, deploymentRef: script.deploymentRef, entry: { envelope: 1, entrySkipped: null } });
        if (probe.bindings.length === 0) return { ...base, action: 'unrecorded' };
        const read = await entryOf(script);
        if (read === 'no-manifest') return failed('entry-unknown', 'no record, and no stored manifest to read its entry from: upload it again');
        // It runs without the platform's entry, so nothing in it verifies: it is not given lists, nor
        // recorded as verifying. Pushing it again wraps it.
        if (read === 'no-entry') return { ...base, action: 'skipped', reason: 'no-entry' };
        entry = read;
      }
      const given = await wireUploadGiven(settings, { vertical: script.vertical, deploymentRef: script.deploymentRef, entry });
      // Refused settings give nothing, and nothing is not a withdrawal to write: the route refuses such a
      // pass before it starts, and a script never acts on one here either.
      // The route refuses a pass under refused settings before it starts, so what is refused here is
      // this script alone (its name is not one the lists can be given as an audience).
      if (given.refusal !== null) return failed('settings-refused', `the lists are refused for this script (${given.refusal}): nothing was written`);
      if (!input.confirm && stored && !stored.record.walkHold && carriesAlready(stored.record, given.record)) return { ...base, action: 'current' };

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
          const held = await hold(entry, 'serve-in-flight', []);
          return failed(
            'serve-in-flight',
            `the served version moved while it was updated, ${holdNote(held)}; ${held ? 'promote again, then release it' : 'promote again'}`,
            held ? { held: true } : {},
          );
        }
        case 'verify': {
          const held = await hold(entry, 'verify', outcome.bindings);
          return failed(
            'verify',
            `after its update, these bindings read differently: ${named(outcome.bindings)}; ${holdNote(held)}`,
            {
              bindings: outcome.bindings.slice(0, WALK_HOLD_BINDINGS_MAX),
              ...(outcome.bindings.length > WALK_HOLD_BINDINGS_MAX ? { more: outcome.bindings.length - WALK_HOLD_BINDINGS_MAX } : {}),
              ...(held ? { held: true as const } : {}),
            },
          );
        }
      }
    } catch {
      // A read for this one script (its stored manifest, its modules) failed. Its text is not echoed:
      // nothing here vouches that it carries no value.
      return failed('entry-unknown', 'its stored manifest or its modules could not be read');
    }
  };

  /**
   * One script, and whether a person's release of it took: only a script that was held and came out
   * current (its fresh record, with no hold, written) is `released`; one that failed again stays held.
   */
  const walkReleasing = async (script: InventoryScript): Promise<WireWalkScript> => {
    const result = await walkOne(script);
    const wasHeld = (await recordsOf(script.vertical)).get(script.deploymentRef)?.record.walkHold !== undefined;
    const current = result.action === 'updated' || result.action === 'unchanged';
    return wasHeld && release.has(script.deploymentRef) && current ? { ...result, released: true } : result;
  };

  const scripts = input.sink ?? [];
  let next: string | null = null;
  const fleet = inventory(admin, actor, input.cursor);
  try {
    let step = await fleet.next();
    while (!step.done) {
      const script = step.value;
      scripts.push(await walkReleasing(script));
      if (scripts.length >= input.limit) {
        // Looked one ahead, so the pass that ends on the fleet's last script answers `null`. A look
        // that fails does not undo a pass that is done: the next one starts after its last script.
        try {
          step = await fleet.next();
          next = step.done ? null : script.cursor;
        } catch {
          next = script.cursor;
        }
        break;
      }
      step = await fleet.next();
    }
  } finally {
    await fleet.return(undefined).catch(() => undefined);
  }
  return { apply: input.apply, from: input.cursor ? cursorText(input.cursor.vertical, input.cursor.after) : null, next, scripts };
}
