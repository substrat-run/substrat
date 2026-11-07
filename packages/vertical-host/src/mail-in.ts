import { PLATFORM_SECRET_HEADER, mailInRelayResult, problemCodeOf, problemDetail } from '@substrat-run/contracts';
import type { ErrorCode, MailInAddress, MailInRelayRequest } from '@substrat-run/contracts';

/**
 * This scope's inbound mail address, from a VERTICAL's worker (#2611).
 *
 * A scope that declares a mail-in landing can have an address on the platform's receiving
 * subdomain — mail sent to it lands through the declared operation, attachment bytes included.
 * This is how the vertical asks for one, reads it to show its users, rotates it when it leaks, and
 * gives it up. The same shape as {@link requestConnectUrl}: the operation decides, the harness
 * effects.
 *
 * ```ts
 * // module.ts — the authorizing act
 * const manageMailIn: OperationHandler = async (ctx) => {
 *   assertAllowed(await ctx.check(PERM.manageMailIn));
 *   return { principal: ctx.principal };
 * };
 *
 * // worker.ts — the effect
 * const { principal } = await scope.invoke('docs/manage-mail-in', {});
 * const address = await mailInAddress({
 *   controlPlaneUrl: env.CONTROL_PLANE_URL,
 *   platformSecret: env.PLATFORM_SECRET,
 *   tenantId, scopeId,
 *   action: 'request',
 *   createdBy: principal,
 *   allowlist: ['me@example.com'],
 * });
 * ```
 *
 * Call it from the worker, never from inside a Durable Object: the platform requires a PROVEN
 * caller for every action, since an address delivers into the scope it names. Which operation and
 * key the address lands through is read from the manifest the scope runs, never from this call.
 */
export type MailInAddressRequest = MailInRelayRequest & {
  /** The control plane's origin, injected into the vertical as `CONTROL_PLANE_URL`. */
  controlPlaneUrl: string;
  /** The `PLATFORM_SECRET` injected into this dispatch script. */
  platformSecret: string;
  /** `fetch` seam for tests; defaults to the runtime's, bound (see `lint:bound-fetch`). */
  fetchImpl?: typeof fetch;
};

/** The relay refused, or could not be reached. Carries the status so a caller can map it. */
export class MailInAddressError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * The taxonomy code the platform's refusal declared (#113), or `undefined` for one that named
     * none: an `about:blank` refusal, a control plane older than the codes, a body that is not
     * JSON. Never `code`: `errorCodeOf` reads that, and this refusal is the platform's answer
     * relayed, not a throw that declared itself here, so a vertical's own `onError` keeps
     * answering it as it did.
     */
    readonly problemCode?: ErrorCode,
  ) {
    super(message);
    this.name = 'MailInAddressError';
  }
}

/** The scope's address after the action — `null` when it has none (or just gave it up). */
export async function mailInAddress(request: MailInAddressRequest): Promise<MailInAddress | null> {
  const fetchImpl = request.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = request.controlPlaneUrl.replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/internal/mail-in/address`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [PLATFORM_SECRET_HEADER]: request.platformSecret },
    body: JSON.stringify({
      tenantId: request.tenantId,
      scopeId: request.scopeId,
      action: request.action,
      ...(request.createdBy ? { createdBy: request.createdBy } : {}),
      ...(request.allowlist ? { allowlist: request.allowlist } : {}),
    }),
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new MailInAddressError(
      `the platform refused the mail-in ${request.action} (${res.status}): ${problemDetail(body) ?? 'unknown error'}`,
      res.status,
      problemCodeOf(body),
    );
  }
  return mailInRelayResult.parse(body).address;
}
