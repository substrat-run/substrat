/**
 * WHO refused a connector delivery — the fact the integration drawer was getting wrong (#841).
 *
 * A `connector:<provider>` dispatch crosses two authorities before it is over. On the way to
 * the bytes it calls back into the VERTICAL — opening the bound attachment, invoking the
 * return-path operation — and that call is checked against the connection's grants. Only once
 * those pass does anything reach the provider. Both ends refuse by throwing, both throws
 * landed in the same `lastError` string, and nothing recorded which was which.
 *
 * So the drain asked `isTerminalProviderError`, which reads a bare numeric `status` — and
 * every `SubstratError` carries one from the problem catalog. A `permission denied:
 * protocol:read` raised inside the vertical answered `true`, and the delivery was journaled
 * as *"a client error the provider will refuse identically on retry"*. Scrive never saw that
 * request. The operator went and audited their Scrive account, pressed **Test connection**
 * (which passes, because the credential is fine), and concluded the platform was broken.
 *
 * The classification is structural, in falling order of confidence. Nothing here parses prose
 * to decide the ORIGIN — only, at the very end, to recover a permission key a vertical too
 * old to send one has already spelled out in its message.
 */
import {
  errorCodeOf,
  permissionKey,
  type ErrorCode,
  type PlatformRequestFailure,
} from '@substrat-run/contracts';
import { providerErrorStatus } from '@substrat-run/kernel';
import { ControlPlaneError } from './client.js';

/**
 * The permission key a refusal names, when the structured field did not survive the hop.
 *
 * `PermissionDenied`'s message is kernel-authored and stable (`permission denied: <key>`), and
 * the key's own grammar (`module:verb`) is narrow enough that a match is the key rather than a
 * guess. Applied ONLY to a failure already attributed to us, so a provider echoing the phrase
 * can never be read as our own refusal.
 */
const PERMISSION_IN_MESSAGE = /permission denied:\s*([a-z0-9-]+:[a-z0-9-]+)/i;

/** The permission key on a throw, however little of it survived the boundary. */
function permissionOf(error: unknown, message: string): string | null {
  const own = (error as { permission?: unknown } | null)?.permission;
  if (typeof own === 'string' && permissionKey.safeParse(own).success) return own;
  const ext = (error as { extensions?: { permission?: unknown } } | null)?.extensions?.permission;
  if (typeof ext === 'string' && permissionKey.safeParse(ext).success) return ext;
  const matched = PERMISSION_IN_MESSAGE.exec(message)?.[1];
  return matched !== undefined && permissionKey.safeParse(matched).success ? matched : null;
}

/**
 * Attribute one failed dispatch.
 *
 * 1. **A `ControlPlaneError` is always ours.** It is constructed in exactly one place — when a
 *    call WE made to the vertical's `/internal` surface came back non-2xx — so whatever status
 *    it carries is the vertical's answer to the platform, never the provider's to us. This is
 *    the rule that fixes the reported bug, and it needs nothing from the vertical: a 403 raised
 *    by a deployment that predates this change is still attributed correctly.
 * 2. **A taxonomy code is ours.** A `SubstratError` thrown in-process by the connector or the
 *    host it runs in — read by shape, so a duplicate package copy or a serialising hop does
 *    not change the answer.
 * 3. **A bare HTTP status is the provider's.** What is left after the two rules above is an
 *    error a connector raised from a real response: `ScriveApiError` and every future
 *    connector's equivalent, recognised structurally rather than by class.
 * 4. **Anything else is `unknown`** — a socket that never opened, a bug, a thrown string. Not
 *    `provider`: "we could not tell" must never be printed as somebody's words.
 */
export function attributeFailure(error: unknown): PlatformRequestFailure {
  const message = error instanceof Error ? error.message : String(error);
  const code: ErrorCode | null = errorCodeOf(error) ?? null;

  if (error instanceof ControlPlaneError || (error as { name?: unknown } | null)?.name === 'ControlPlaneError') {
    return { origin: 'platform', code, permission: permissionOf(error, message) };
  }
  if (code !== null) {
    return { origin: 'platform', code, permission: permissionOf(error, message) };
  }
  if (providerErrorStatus(error) !== undefined) {
    return { origin: 'provider', code: null, permission: null };
  }
  return { origin: 'unknown', code: null, permission: null };
}

/**
 * The sentence journaled beside a terminal failure, in the voice of whoever actually refused.
 *
 * This string is what an operator reads first, and the one it replaces was actively
 * misleading — it named the provider for a refusal the provider never made. Each branch now
 * says who refused and what that implies for a retry, and only the `provider` branch quotes
 * the failure as their answer.
 */
export function terminalFailureNote(failure: PlatformRequestFailure, provider: string): string {
  switch (failure.origin) {
    case 'platform':
      return (
        `refused by this platform before anything was sent — ${provider} never saw this request, ` +
        `so its credential is not implicated; the same call would be refused again, so this ` +
        `delivery was not retried`
      );
    case 'provider':
      return `a client error ${provider} will refuse identically on retry, so this delivery was not retried`;
    case 'unknown':
      return `refused with a status but no attributable origin, so this delivery was not retried`;
  }
}
