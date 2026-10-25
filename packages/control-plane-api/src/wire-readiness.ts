/**
 * The readiness report (RFC wire-signing §7, follow-on 4): what the fleet's capability records say
 * about each rollout step, and what still blocks it. Three gates, each a list of blockers:
 *
 * - **`signed-only`**: what blocks moving an environment's down-channel from `dual` to `signed-only`.
 * - **key drop**: what blocks dropping a public key from an issuer's list.
 * - **credential withdrawal**: what blocks withdrawing the shared credential (step 7).
 *
 * It is **advisory**: it informs the person who flips a setting or drops a key, and nothing in the
 * tooling enforces it yet (follow-on 7). It is **read-only** by construction: it reads the registry,
 * the capability records and the fleet walk's admin rows, and calls nothing else. It never reads a
 * script, never walks, and writes nothing; the record reads it makes leave their own access-log rows.
 *
 * **Unknown is never read as fact.** A script with no record, a record the walk holds (`walkHold`),
 * and a record the walk could not verify (`withheld: 'unverified'`) are listed as unknown, and every
 * gate treats unknown as blocking. A record is trusted as current only when it was written after the
 * last confirming walk began (`wireConfirmation`); when that walk cannot be found whole in the admin
 * log, confirmation is unknown, and every gate that needs it is blocked.
 *
 * Every reason is a fixed sentence, naming at most a setting or a vertical; never a key, a key id or
 * a tenant.
 */
import { instant, z, type AdminLogEntry, type DeploymentWireAuth, type PlatformActorId, type WireAuthRecord } from '@substrat-run/contracts';
import { wireUploadSettings, WIRE_UNSIGNED_ROUTES } from '@substrat-run/contracts/wire-signing';
import type { HostAdmin } from '@substrat-run/kernel';
import { wireSettingsRefusal, wireKeysRolloutOf, wireUploadGiven, type WireUploadSettings } from './wire-upload.js';
import { carriesAlready, wireAuthRecordsOf, wireInventory, wireInventoryPass, type InventoryScript, type WireWalkCursor } from './wire-walk.js';

/** A report page covers this many scripts when it names no limit. */
export const WIRE_READINESS_LIMIT_DEFAULT = 25;
/** A report page covers at most this many scripts. */
export const WIRE_READINESS_LIMIT_MAX = 50;
/** The most walk rows the report reads to find the last confirming walk; a walk longer than that is unknown. */
export const WIRE_CONFIRM_ROWS_MAX = 200;

/** What every report says first. */
export const WIRE_READINESS_ADVISORY =
  'advisory: this report informs the person who flips the down-channel, drops a key or withdraws the shared credential; no tooling enforces it yet (follow-on 7)';

/** What every report says second: when its answer holds. */
export const WIRE_READINESS_AS_OF =
  'the answer is as of each record’s recorded time, not live: run the confirming pass immediately before any flip or drop, and run the report after it';

export type WireGate = 'signed-only' | 'key-drop' | 'credential-withdrawal';

/** One thing that blocks a gate. */
export interface WireBlocker {
  /**
   * `standing`: by design, until a later step answers it. `settings`: the control plane's own wire
   * settings. `confirmation`: the last confirming walk. `script`: one script, named.
   */
  readonly kind: 'standing' | 'settings' | 'confirmation' | 'script';
  readonly deploymentRef?: string;
  readonly vertical?: string;
  readonly reason: string;
}

/** What the last confirming walk proves: when it began, or why it proves nothing. */
export type WireConfirmation =
  | { readonly status: 'confirmed'; readonly startedAt: string; readonly passes: number }
  | { readonly status: 'unknown'; readonly reason: string };

/** One script, as the records say. */
export interface WireReadinessScript {
  readonly deploymentRef: string;
  readonly vertical: string;
  readonly versionId: string | null;
  readonly kind: 'serving' | 'version';
  /**
   * `unknown`: no record, held by the walk, or unverified by it. `verifies`: its record says it carries
   * the platform's entry and was given lists. `not-verifying`: its record says it verifies nothing
   * (no entry, or no lists).
   */
  readonly status: 'unknown' | 'verifies' | 'not-verifying';
  /** Its record's state, when it has a record. */
  readonly state?: WireAuthRecord['state'];
  /** Whether its record was written after the last confirming walk began; `null` when that is unknown. */
  readonly confirmed: boolean | null;
}

/** The key a person asks to drop, and when the control plane's list stopped naming it. */
export interface WireKeyDrop {
  readonly issuer: 'router' | 'platform';
  readonly kid: string;
  readonly since: string;
}

export interface WireReadinessReport {
  readonly advisory: string;
  readonly asOf: string;
  readonly from: string | null;
  /** Where the next page starts, `null` at the end of the fleet. A gate is clear only when every page, from the start, shows it clear. */
  readonly next: string | null;
  readonly confirmation: WireConfirmation;
  /** The key drop asked about, echoed: its issuer and `since`. */
  readonly keyDrop?: { readonly issuer: WireKeyDrop['issuer']; readonly since: string };
  readonly scripts: readonly WireReadinessScript[];
  readonly blockers: {
    readonly signedOnly: readonly WireBlocker[];
    readonly keyDrop?: readonly WireBlocker[];
    readonly credentialWithdrawal: readonly WireBlocker[];
  };
}

/** The fixed sentences, in one place, so every copy reads the same. */
export const WIRE_READINESS_REASONS = {
  counters:
    'the cutover counters (no legacy acceptance, no dual-mismatch, no fault, no refusal outside client noise) are not read by this report yet, nor is a version whose default export has no fetch, which only the counters show',
  notSignedOnly: 'no environment is signed-only: every upload and every walk gives dual',
  upChannel: 'the up-channel removals (step 6) are not recorded per version, so no version is shown to make no up-call with the shared credential',
  perDeployment: 'no version carries per-deployment values for its legacy checks (Q10), so a version never rebuilt still needs the shared credential',
  rolloutNotFleet: 'WIRE_KEYS_ROLLOUT is not fleet: not every deployment is given key lists',
  noRecord: 'it has no capability record, so what it carries is unknown',
  held: 'the fleet walk holds it, so its record states what was last known, not what it runs: look at it, then release it or push it again',
  unverified: 'the fleet walk found it with no record and could not verify it, so what it carries is unknown',
  noEntry: 'it was uploaded without the platform entry, so it verifies nothing: it is ready once pushed again',
  noLists: 'it was given no key lists, so it is legacy-only',
  stale: 'it does not carry the key lists, audience and state the control plane gives now: walk the fleet',
  noRouterStandby: 'its router key list holds no standby key beside the key in use',
  noPlatformStandby: 'its platform key list holds no standby key beside the key in use',
  unconfirmed: 'its record was written before the last confirming walk began, so it is not trusted as current',
  confirmationUnknown: 'the last confirming walk is unknown, so no record is trusted as current',
  confirmedBeforeSince: 'the last confirming walk began before the key left the list, so it does not show the key gone',
  stillListed: 'the control plane still lists the key',
  listWouldEmpty: 'the key is the only one its issuer lists',
  stillTrusted: 'it still trusts the key',
  lacksKeyInUse: 'it does not carry every key its issuer lists now',
} as const;

const R = WIRE_READINESS_REASONS;

/** The walk row's fields the report reads; any other shape is a row it cannot read. */
const walkRow = z.object({
  apply: z.boolean(),
  confirm: z.boolean(),
  startedAt: instant.optional(),
  from: z.string().nullable(),
  next: z.string().nullable(),
  error: z.string().optional(),
  refused: z.string().optional(),
});

/**
 * What the last confirming walk proves, from the walk's admin rows, newest first (at most
 * `WIRE_CONFIRM_ROWS_MAX`, plus one more to tell a full read from a cut one). Fails closed: confirmed
 * only when the newest APPLIED pass is a confirming one that reached the end of the fleet, and the
 * applied passes before it, one after another with no other applied pass between, are confirming ones
 * chained back to the start of the fleet (each pass's `from` the `next` of the pass before), none of
 * them refused or ended in an error, each with its start time. Anything else is `unknown`, with why:
 * no such walk, a gap in the chain, a refused or failed pass in it, a row it cannot read, or a chain
 * that runs past the rows read.
 */
export function wireConfirmation(rows: readonly Pick<AdminLogEntry, 'after'>[]): WireConfirmation {
  const unknown = (reason: string): WireConfirmation => ({ status: 'unknown', reason });
  const read = rows.slice(0, WIRE_CONFIRM_ROWS_MAX);
  const parsed: z.infer<typeof walkRow>[] = [];
  for (const row of read) {
    const p = walkRow.safeParse(row.after);
    if (!p.success) return unknown('a fleet walk row could not be read');
    parsed.push(p.data);
  }
  const applied = parsed.filter((p) => p.apply);
  if (applied.length === 0) {
    return unknown(rows.length > read.length ? 'no applied walk is among the rows read' : 'no applied confirming walk is recorded');
  }
  let expected: string | null = null;
  for (let i = 0; i < applied.length; i++) {
    const p = applied[i]!;
    if (!p.confirm) {
      return unknown(i === 0 ? 'the last applied walk was not a confirming one' : 'an applied walk that was not confirming ran inside the last confirming walk');
    }
    if (p.refused !== undefined || p.error !== undefined) return unknown('a pass of the last confirming walk was refused or ended in an error');
    if (p.next !== expected) return unknown(i === 0 ? 'the last confirming walk did not reach the end of the fleet' : 'the last confirming walk has a gap between its passes');
    if (p.startedAt === undefined) return unknown('a pass of the last confirming walk does not record when it began');
    if (p.from === null) return { status: 'confirmed', startedAt: p.startedAt, passes: i + 1 };
    expected = p.from;
  }
  return unknown(rows.length > read.length ? 'the last confirming walk runs past the rows read' : 'the last confirming walk does not reach back to the start of the fleet');
}

/** `since` as a person gives it: an instant, not in the future. A fixed sentence when it is not. */
export function wireKeyDropSince(since: unknown, now: Date): string | { readonly refused: string } {
  if (since === undefined || since === null || since === '') return { refused: 'a key drop names since: when the control plane’s list stopped naming the key' };
  const parsed = instant.safeParse(since);
  if (!parsed.success) return { refused: 'since is an ISO 8601 instant' };
  if (Date.parse(parsed.data) > now.getTime()) return { refused: 'since is not in the future' };
  return parsed.data;
}

/** The key ids each issuer's list names now, or `null` when the lists do not load. */
async function listedKids(settings: WireUploadSettings | undefined): Promise<{ router: readonly string[]; platform: readonly string[] } | null> {
  try {
    const given = await wireUploadSettings({ routerKeys: settings?.routerKeys ?? '', platformKeys: settings?.platformKeys ?? '', audience: 'wire-settings-check' });
    return { router: given.routerKids, platform: given.platformKids };
  } catch {
    return null;
  }
}

const unknownReason = (record: DeploymentWireAuth | undefined): string | null =>
  !record ? R.noRecord : record.record.walkHold !== undefined ? R.held : record.record.withheld === 'unverified' ? R.unverified : null;

/** One page of the report. Reads only; never throws for one script, only for a directory read that fails. */
export async function wireReadinessReport(
  deps: { readonly admin: HostAdmin; readonly actor: PlatformActorId; readonly settings: WireUploadSettings | undefined },
  input: { readonly cursor: WireWalkCursor | null; readonly from: string | null; readonly limit: number; readonly keyDrop?: WireKeyDrop },
): Promise<WireReadinessReport> {
  const { admin, actor, settings } = deps;
  const rows = await admin.auditLog(actor, { action: 'walkWireAuth', order: 'desc', limit: WIRE_CONFIRM_ROWS_MAX + 1 });
  const confirmation = wireConfirmation(rows);
  const refused = await wireSettingsRefusal(settings);
  const rollout = wireKeysRolloutOf(settings?.rollout);
  const kids = await listedKids(settings);

  const signedOnly: WireBlocker[] = [
    ...WIRE_UNSIGNED_ROUTES.map((r) => ({ kind: 'standing' as const, reason: `${r.method} ${r.path}: ${r.reason}` })),
    { kind: 'standing', reason: R.counters },
  ];
  const drop: WireBlocker[] | undefined = input.keyDrop ? [] : undefined;
  const settingsBlocker: WireBlocker | null = refused ? { kind: 'settings', reason: `the control plane’s wire settings are refused (${refused.withheld}): ${refused.reason}` } : null;
  if (settingsBlocker) {
    signedOnly.push(settingsBlocker);
    drop?.push(settingsBlocker);
  } else if ('refused' in rollout || rollout.kind !== 'fleet') {
    // Only while the settings are usable: a refusal hides the rollout state, and is the fix to make first.
    signedOnly.push({ kind: 'settings', reason: R.rolloutNotFleet });
  }
  if (confirmation.status === 'unknown') {
    const blocker: WireBlocker = { kind: 'confirmation', reason: `${R.confirmationUnknown}: ${confirmation.reason}` };
    signedOnly.push(blocker);
    drop?.push(blocker);
  }
  const keyDrop = input.keyDrop;
  if (keyDrop && drop) {
    const listed = kids?.[keyDrop.issuer] ?? null;
    if (listed === null) {
      if (!settingsBlocker) drop.push({ kind: 'settings', reason: 'the control plane’s key lists do not load' });
    } else {
      if (listed.includes(keyDrop.kid)) drop.push({ kind: 'settings', reason: R.stillListed });
      if (listed.every((k) => k === keyDrop.kid)) drop.push({ kind: 'settings', reason: R.listWouldEmpty });
    }
    if (confirmation.status === 'confirmed' && Date.parse(confirmation.startedAt) < Date.parse(keyDrop.since)) {
      drop.push({ kind: 'confirmation', reason: R.confirmedBeforeSince });
    }
  }

  let records: { vertical: string; held: Map<string, DeploymentWireAuth> } | null = null;
  const recordOf = async (script: InventoryScript) => {
    if (records?.vertical !== script.vertical) records = { vertical: script.vertical, held: await wireAuthRecordsOf(admin, actor, script.vertical) };
    return records.held.get(script.deploymentRef);
  };

  const judge = async (script: InventoryScript): Promise<WireReadinessScript> => {
    const stored = await recordOf(script);
    const named = (reason: string): WireBlocker => ({ kind: 'script', deploymentRef: script.deploymentRef, vertical: script.vertical, reason });
    const base = { deploymentRef: script.deploymentRef, vertical: script.vertical, versionId: script.versionId, kind: script.kind };
    const unknown = unknownReason(stored);
    if (unknown !== null || !stored) {
      const blocker = named(unknown ?? R.noRecord);
      signedOnly.push(blocker);
      drop?.push(blocker);
      return { ...base, status: 'unknown', ...(stored ? { state: stored.record.state } : {}), confirmed: null };
    }
    const record = stored.record;
    const confirmed = confirmation.status === 'confirmed' ? Date.parse(stored.recordedAt) >= Date.parse(confirmation.startedAt) : null;
    const verifies = record.envelope !== null && record.withheld === null;
    if (record.envelope === null) {
      signedOnly.push(named(R.noEntry));
    } else if (record.withheld !== null) {
      signedOnly.push(named(`${R.noLists} (${record.withheld})`));
    }
    const given = await wireUploadGiven(settings, { vertical: script.vertical, deploymentRef: script.deploymentRef, entry: { envelope: record.envelope, entrySkipped: record.entrySkipped } });
    if (verifies) {
      if (!carriesAlready(record, given.record)) signedOnly.push(named(R.stale));
      if (record.routerKids.length < 2) signedOnly.push(named(R.noRouterStandby));
      if (record.platformKids.length < 2) signedOnly.push(named(R.noPlatformStandby));
    }
    if (confirmed === false) {
      signedOnly.push(named(R.unconfirmed));
      drop?.push(named(R.unconfirmed));
    }
    if (keyDrop && drop) {
      const trusted = keyDrop.issuer === 'router' ? record.routerKids : record.platformKids;
      if (trusted.includes(keyDrop.kid)) drop.push(named(R.stillTrusted));
      const listed = kids?.[keyDrop.issuer];
      if (trusted.length > 0 && listed && listed.some((k) => k !== keyDrop.kid && !trusted.includes(k))) drop.push(named(R.lacksKeyInUse));
    }
    return { ...base, status: verifies ? 'verifies' : 'not-verifying', state: record.state, confirmed };
  };

  const scripts: WireReadinessScript[] = [];
  const next = await wireInventoryPass(wireInventory(admin, actor, input.cursor), input.limit, judge, scripts);
  // Everything that blocks signed-only but its standing blockers blocks the withdrawal too: a script
  // that does not carry and verify signed calls still needs the shared credential. Signed-only's
  // standing blockers are covered by the withdrawal's own first one (no environment is signed-only).
  const withdrawal: WireBlocker[] = [
    { kind: 'standing', reason: R.notSignedOnly },
    { kind: 'standing', reason: R.upChannel },
    { kind: 'standing', reason: R.perDeployment },
    ...signedOnly.filter((b) => b.kind !== 'standing'),
  ];
  return {
    advisory: WIRE_READINESS_ADVISORY,
    asOf: WIRE_READINESS_AS_OF,
    from: input.from,
    next,
    confirmation,
    ...(keyDrop ? { keyDrop: { issuer: keyDrop.issuer, since: keyDrop.since } } : {}),
    scripts,
    blockers: { signedOnly, ...(drop ? { keyDrop: drop } : {}), credentialWithdrawal: withdrawal },
  };
}
