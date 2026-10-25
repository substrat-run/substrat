/**
 * The uploader's half of RFC wire-signing step 2 (follow-on 3): what one upload gives the deployment
 * it goes to, and the capability record of it (§5, §6, §7, Q8).
 *
 * A deployment is given both issuers' public key lists, its own dispatch name for the audience
 * check and the state `dual`, all plain configuration, rewritten on every upload. Nothing is given
 * until the control plane's `WIRE_KEYS_ROLLOUT` says so: unset or `off` gives no deployment lists,
 * `canary:<vertical>` gives them to that one vertical's deployments only (the single canary the RFC
 * puts first in each environment), and `fleet` to every deployment. A setting that cannot be read
 * gives nothing. So with the setting unset, every upload is what it was before this existed.
 *
 * The lists are judged before they are given, by the function the platform's entry loads them with
 * (`wireUploadSettings`), so a deployment is never given lists its verifier would refuse: the upload
 * gives nothing instead, and says why. No code here can give a state other than `dual`: moving a
 * deployment to `signed-only` is the flip, a later and separate step.
 *
 * Every upload has a record, given lists or not, written from what the uploader built: whether the
 * bundle carries the platform's entry (which holds the verifier), the state, the audience and the key
 * ids, or why nothing was given. The vertical never declares any of it.
 */
import { verticalSlug, type WireAuthRecord } from '@substrat-run/contracts';
import { wireUploadSettings, wireVerificationKeys, WIRE_ENVELOPE_VERSION, WIRE_UPLOAD_STATE } from '@substrat-run/contracts/wire-signing';
import { platformEntrySkipReason } from './platform-entry.js';
import type { VerticalBundle } from './deploy.js';

/** The control plane's own settings for what its uploads give, as its env holds them. */
export interface WireUploadSettings {
  /** `WIRE_KEYS_ROLLOUT`: unset or `off`, `canary:<vertical>`, or `fleet`. */
  readonly rollout?: string;
  /** `WIRE_ROUTER_PUBLIC_KEYS`: the router's public keys, comma-separated. */
  readonly routerKeys?: string;
  /** `WIRE_PLATFORM_PUBLIC_KEYS`: the control plane's public keys, comma-separated. */
  readonly platformKeys?: string;
}

/** Which deployments an upload gives lists to. */
export type WireKeysRollout =
  | { readonly kind: 'off' }
  | { readonly kind: 'canary'; readonly vertical: string }
  | { readonly kind: 'fleet' };

const CANARY = 'canary:';

/**
 * The rollout setting's one reading. Unset, empty or `off` is off; `fleet` is every deployment;
 * `canary:<vertical>` is one vertical, named as the registry names it. Anything else is refused
 * with the reason, a second vertical in a canary included: the RFC's canary is one, before the rest.
 */
export function wireKeysRolloutOf(value: unknown): WireKeysRollout | { readonly refused: string } {
  if (value === undefined || value === null) return { kind: 'off' };
  if (typeof value !== 'string') return { refused: 'the rollout setting is not text' };
  const text = value.trim();
  if (text === '' || text === 'off') return { kind: 'off' };
  if (text === 'fleet') return { kind: 'fleet' };
  if (!text.startsWith(CANARY)) return { refused: 'the rollout setting is `off`, `canary:<vertical>` or `fleet`' };
  const vertical = text.slice(CANARY.length).trim();
  if (/[,\s]/.test(vertical)) return { refused: 'a canary names one vertical' };
  if (!verticalSlug.safeParse(vertical).success) return { refused: 'a canary names a vertical by its registry slug' };
  return { kind: 'canary', vertical };
}

/** What one upload gives its deployment, and the record of it. */
export interface WireUpload {
  /** The vertical and the script the upload goes to. */
  readonly vertical: string;
  readonly deploymentRef: string;
  /** Plain configuration for the upload: both lists, the audience and the state, or nothing. */
  readonly bindings: readonly { readonly type: 'plain_text'; readonly name: string; readonly text: string }[];
  readonly record: WireAuthRecord;
  /** Why the setting or the lists were refused, when they were. Never a key. */
  readonly refusal: string | null;
}

/**
 * What the upload of `bundle` to the script `deploymentRef`, a deployment of `vertical`, gives it
 * under `settings`, and the record of it. Gives nothing while the rollout is off or leaves the
 * vertical out, while the setting cannot be read, or while the lists would not load.
 */
export async function wireUploadFor(
  settings: WireUploadSettings | undefined,
  upload: { readonly vertical: string; readonly deploymentRef: string; readonly bundle: Pick<VerticalBundle, 'entry' | 'modules'> },
): Promise<WireUpload> {
  return wireUploadGiven(settings, { vertical: upload.vertical, deploymentRef: upload.deploymentRef, entry: wireEntryOf(upload.bundle) });
}

/** Whether a bundle carries the platform's entry, which holds the verifier, as a record states it. */
export function wireEntryOf(bundle: Pick<VerticalBundle, 'entry' | 'modules'>): WireEntry {
  const skipped = platformEntrySkipReason(bundle) ?? null;
  return { envelope: skipped === null ? WIRE_ENVELOPE_VERSION : null, entrySkipped: skipped };
}

/** The record's half that is a fact about the bundle: its envelope version, or why the entry was left off. */
export type WireEntry = Pick<WireAuthRecord, 'envelope' | 'entrySkipped'>;

/**
 * `wireUploadFor` from a bundle's entry state already known (`wireEntryOf`, or a record of the
 * script's upload): what the settings give the script now, and the record of it. The fleet walk's
 * reading of the same rule, so a walked script and an uploaded one are given the same.
 */
export async function wireUploadGiven(
  settings: WireUploadSettings | undefined,
  upload: { readonly vertical: string; readonly deploymentRef: string; readonly entry: WireEntry },
): Promise<WireUpload> {
  const { vertical, deploymentRef } = upload;
  const entry: WireEntry = { envelope: upload.entry.envelope, entrySkipped: upload.entry.entrySkipped };
  const nothing = (withheld: NonNullable<WireAuthRecord['withheld']>, refusal: string | null = null): WireUpload => ({
    vertical,
    deploymentRef,
    bindings: [],
    record: { ...entry, state: 'legacy-only', audience: null, routerKids: [], platformKids: [], withheld },
    refusal,
  });
  const rollout = wireKeysRolloutOf(settings?.rollout);
  if ('refused' in rollout) return nothing('rollout-refused', rollout.refused);
  if (rollout.kind === 'off') return nothing('unconfigured');
  if (rollout.kind === 'canary' && rollout.vertical !== vertical) return nothing('not-in-rollout');
  try {
    const given = await wireUploadSettings({
      routerKeys: settings?.routerKeys ?? '',
      platformKeys: settings?.platformKeys ?? '',
      audience: deploymentRef,
    });
    return {
      vertical,
      deploymentRef,
      bindings: given.settings.map((setting) => ({ type: 'plain_text', ...setting })),
      record: { ...entry, state: WIRE_UPLOAD_STATE, audience: deploymentRef, routerKids: given.routerKids, platformKids: given.platformKids, withheld: null },
      refusal: null,
    };
  } catch (error) {
    return nothing('lists-refused', await refusedList(settings, error));
  }
}

/**
 * Whether the settings themselves are refused: the rollout setting does not parse, or, where it gives
 * lists to anything, the lists do not load. `null` when they are usable, `off` included. An upload under
 * refused settings gives nothing and says why; the fleet walk refuses the whole pass instead, since
 * giving nothing to every script would withdraw the lists fleet-wide. The reason is the uploader's
 * own, naming the setting, never a key.
 */
export async function wireSettingsRefusal(
  settings: WireUploadSettings | undefined,
): Promise<{ readonly withheld: 'rollout-refused' | 'lists-refused'; readonly reason: string } | null> {
  const rollout = wireKeysRolloutOf(settings?.rollout);
  if ('refused' in rollout) return { withheld: 'rollout-refused', reason: rollout.refused };
  if (rollout.kind === 'off') return null;
  try {
    await wireUploadSettings({ routerKeys: settings?.routerKeys ?? '', platformKeys: settings?.platformKeys ?? '', audience: 'wire-settings-check' });
    return null;
  } catch (error) {
    return { withheld: 'lists-refused', reason: await refusedList(settings, error) };
  }
}

/**
 * Why the lists were refused, naming the setting to fix: each list is loaded alone, and the first
 * that fails is named with its problem. When each loads alone (a key in both, or an audience the
 * encoder would not carry), the refusal is the one given. The parser's messages are fixed text
 * naming a problem, never a key.
 */
async function refusedList(settings: WireUploadSettings | undefined, error: unknown): Promise<string> {
  const problem = (e: unknown) => (e instanceof Error ? e.message : 'the list did not load').replace(/^a store public key/, 'a public key');
  for (const [name, router, platform] of [
    ['WIRE_ROUTER_PUBLIC_KEYS', settings?.routerKeys, undefined],
    ['WIRE_PLATFORM_PUBLIC_KEYS', undefined, settings?.platformKeys],
  ] as const) {
    const list = router ?? platform;
    if (!list?.trim()) return `${name} lists no key`;
    try {
      await wireVerificationKeys({ router, platform });
    } catch (e) {
      return `${name}: ${problem(e)}`;
    }
  }
  return problem(error);
}
