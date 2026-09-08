/**
 * Which consent round a token belongs to, and where its person goes afterwards.
 *
 * Two doors start a provider connect, because two different people connect one:
 *
 * - A **link** round (#1220) is minted in the dashboard by an admin and travels — mailed
 *   to whoever administers the provider, opened days later, sometimes regretted first. So
 *   it is backed by a row: single-use, revocable, and dead the moment the minting admin
 *   loses access.
 * - A **platform** round (connections.md §3.5.3) is started by a VERTICAL's own operation
 *   for the person already sitting in front of it — a bookkeeping bureau's staff
 *   connecting a client company, who have no dashboard account and no reason to have one.
 *   It has no row: minutes of life instead, and its authority is the `ctx.check` that
 *   vertical ran, carried in the state and stamped on the connection as `createdBy`.
 *
 * Everything downstream is deliberately shared — one consent start, one callback, one
 * `redirect_uri` registered with the provider. What differs is only who is asked whether
 * the round still stands, and where the person is sent when it settles.
 *
 * Here rather than in `worker.ts` for the same reason `signed-token.ts` is: that file
 * imports `cloudflare:workers` and cannot be tested in Node, and deciding whether a
 * signature is good is exactly the kind of thing that must be.
 */

import { verifyConnectState, type ConnectStateClaim } from '@substrat-run/kernel';
import { verifyClaim, CONNECT_LINK_PURPOSE } from './signed-token.js';

/** The signed half of a connect link — names the row; the row decides liveness. */
export interface ConnectLinkClaim {
  linkId: string;
  tenantId: string;
  /** The minting tenant's own dashboard scope — where the link row lives. */
  scopeId: string;
  /** The app the connection (and its grants) will land on. */
  appScopeId: string;
  /** The minting admin — the authority every later step runs as. */
  principal: string;
  provider: string;
  exp: number;
}

export type ConnectRound =
  | { kind: 'link'; claim: ConnectLinkClaim }
  | { kind: 'platform'; claim: ConnectStateClaim };

/** The two secrets a round can be signed under. Structural, so tests need no worker `Env`. */
export interface ConnectRoundSecrets {
  /** The dashboard's own signing secret — connect links derive their key from it. */
  SESSION_SECRET: string;
  /**
   * The platform's shared script secret, held by the control plane that mints
   * platform rounds. Absent ⇒ this deployment recognises none of them, and connect
   * links keep working exactly as before. Fails closed, never open.
   */
  PLATFORM_SECRET?: string;
}

/**
 * Which round this token is, or `null` for none.
 *
 * The dashboard's own purpose key is tried first and the platform's second. They are
 * independent HMAC families — different secrets, and HKDF with different `info` labels —
 * so a token can verify under at most one, and the order is cost rather than precedence.
 *
 * `null` covers forged, expired, malformed, and minted-somewhere-else alike. One answer
 * for every failure on purpose: the callers render a single refusal, and an error that
 * distinguished them would be an oracle for which rounds exist.
 */
export async function resolveConnectRound(
  env: ConnectRoundSecrets,
  token: string,
  nowMs: number,
): Promise<ConnectRound | null> {
  if (!token) return null;
  const link = await verifyClaim<ConnectLinkClaim>(env.SESSION_SECRET, CONNECT_LINK_PURPOSE, token, nowMs);
  if (link) return { kind: 'link', claim: link };
  const platform = await verifyConnectState(env.PLATFORM_SECRET, token, nowMs);
  return platform ? { kind: 'platform', claim: platform } : null;
}

/**
 * Which scope the connection lands on for this round.
 *
 * A link round names the app it was minted for; a platform round names the scope whose
 * own operation authorized it. Either way the control plane re-derives the VERTICAL from
 * this scope rather than trusting the state — so neither a forged claim nor a replayed
 * one can land a credential anywhere but that scope's own vertical.
 */
export const connectionScopeOf = (round: ConnectRound): string =>
  round.kind === 'link' ? round.claim.appScopeId : round.claim.scopeId;

/**
 * Where a PLATFORM round sends the browser when it settles, or `null` when there is
 * nowhere to send it (a link round, or a vertical that asked for no return).
 *
 * The URL was checked at mint against the hostname map — it is a surface this very scope
 * answers on — so this only has to add the outcome. Parameters are appended to whatever
 * the vertical already put in its return URL rather than replacing the query, because
 * that URL is typically a deep link back to the client row the round started from.
 *
 * `subjectRef` is echoed unchanged. The platform never parsed it, and this is the whole
 * of what it does with it: hand back the vertical's own name for what just connected, so
 * a bureau with many rounds open attributes this one without matching on org.nr.
 */
export function connectReturn(round: ConnectRound, params: Record<string, string>): string | null {
  if (round.kind !== 'platform' || !round.claim.returnUrl) return null;
  const url = new URL(round.claim.returnUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (round.claim.subjectRef) url.searchParams.set('subjectRef', round.claim.subjectRef);
  return url.toString();
}
