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
import { wireUploadSettings, WIRE_ENVELOPE_VERSION, WIRE_UPLOAD_STATE } from '@substrat-run/contracts/wire-signing';
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
  const { vertical, deploymentRef } = upload;
  const skipped = platformEntrySkipReason(upload.bundle) ?? null;
  const entry: Pick<WireAuthRecord, 'envelope' | 'entrySkipped'> = { envelope: skipped === null ? WIRE_ENVELOPE_VERSION : null, entrySkipped: skipped };
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
    // The list parser's messages are fixed text naming a problem, never a key.
    return nothing('lists-refused', error instanceof Error ? error.message : 'the lists did not load');
  }
}
