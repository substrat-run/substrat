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
 * - A platform round carrying a `linkId` (§3.5.4) is the vertical's MAILED link — the
 *   bureau sends it to the client company's administrator, who opens it days later. That
 *   one has a row again, held by the platform beside the connections rather than in the
 *   dashboard's scope, and it is asked, spent and restored exactly as a dashboard link is.
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
import { scopeId, type ConnectLink, type ConnectLinkConsume, type ScopeId } from '@substrat-run/contracts';
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
  // The vertical kept the link's id from the mint; this is how it matches the landing to it.
  if (round.claim.linkId) url.searchParams.set('link', round.claim.linkId);
  return url.toString();
}

/** Why a link round refuses — the dashboard's link and the platform's share the vocabulary. */
export type LinkRefusal = 'unknown' | 'used' | 'revoked' | 'expired';

/**
 * Who the refusal and closing copy should send the reader back to. A dashboard link was
 * minted by a Substrat administrator; a vertical's mailed link was sent by a bureau to a
 * client company, whose administrator has no Substrat administrator to ask — only whoever
 * sent them the link.
 */
export const linkSenderOf = (round: ConnectRound): 'dashboard' | 'sender' =>
  round.kind === 'platform' && round.claim.linkId ? 'sender' : 'dashboard';

/**
 * The row behind a round, wherever it lives: in the minting tenant's dashboard scope (a
 * dashboard link) or in the platform's directory (a vertical's mailed link). `null` for an
 * in-session platform round, which has no row to ask and nothing to spend.
 */
export interface RoundLinkRow {
  /** `null` when the row still opens; the reason when it does not. May throw on a platform fault. */
  check(): Promise<LinkRefusal | null>;
  /** Spend it, recording what the consent attached. `null` when this call won. */
  consume(account: { accountRef: string; accountLabel?: string }): Promise<LinkRefusal | null>;
  /** Undo a spend after the store failed. `true` when the link is openable again. */
  restore(): Promise<boolean>;
}

/** The subset of the control-plane seam a vertical's link row is reached through. */
export interface PlatformLinkPlane {
  getConnectLink(scopeId: ScopeId, linkId: string): Promise<ConnectLink | undefined>;
  consumeConnectLink(
    scopeId: ScopeId,
    linkId: string,
    input: { provider: string; accountRef?: string; accountLabel?: string },
  ): Promise<ConnectLinkConsume>;
  restoreConnectLink(scopeId: ScopeId, linkId: string): Promise<boolean>;
}

/**
 * The row of a vertical's mailed link, through the control plane (connections.md §3.5.4) —
 * or `null` for a round that has none. `plane` is asked lazily, so a round with no row never
 * mints a tenant credential just to be told so.
 */
export function platformLinkRow(
  round: ConnectRound,
  plane: () => PlatformLinkPlane,
  nowMs: () => number,
): RoundLinkRow | null {
  if (round.kind !== 'platform' || !round.claim.linkId) return null;
  const { claim } = round;
  const linkId = claim.linkId!;
  const scope = scopeId.parse(claim.scopeId);
  return {
    check: async () => {
      const link = await plane().getConnectLink(scope, linkId);
      if (!link || link.provider !== claim.provider) return 'unknown';
      if (link.status !== 'outstanding') return link.status;
      return Date.parse(link.expiresAt) <= nowMs() ? 'expired' : null;
    },
    consume: async (account) => {
      const result = await plane().consumeConnectLink(scope, linkId, { provider: claim.provider, ...account });
      return result.ok ? null : result.reason;
    },
    restore: () => plane().restoreConnectLink(scope, linkId),
  };
}

/**
 * The landing's question: does the row still stand? Asked, never spent — a mail scanner or
 * a link preview fetching the URL must not burn a link the recipient has not opened yet. A
 * fault reaching the row refuses (logged, because a platform fault wears the same refusal).
 */
export async function linkRefusalAtLanding(row: RoundLinkRow | null): Promise<LinkRefusal | null> {
  if (!row) return null;
  try {
    return await row.check();
  } catch (e) {
    console.error('connect-link liveness check failed', e);
    return 'unknown';
  }
}

export type ConsentSettlement =
  | { ok: true }
  | { ok: false; at: 'consume'; reason: LinkRefusal }
  | { ok: false; at: 'store'; error: unknown; restored: boolean };

/**
 * The callback's order, once the provider has answered: spend the row, THEN store the
 * credential, and un-spend the row if the store fails.
 *
 * Consume first is what makes a link single-use under a race — of two callbacks for one
 * link, exactly one gets past it — and it keeps a revoked link from ever reaching the
 * store. The restore is best effort: the consent's code is spent either way, but the LINK
 * still stands, so a platform hiccup costs a retry rather than a new link mailed out. Only
 * the callback that won the consume holds a `used` row, so the guard is not weakened.
 */
export async function settleConsent(
  row: RoundLinkRow | null,
  account: { accountRef: string; accountLabel?: string },
  store: () => Promise<void>,
): Promise<ConsentSettlement> {
  if (row) {
    let refused: LinkRefusal | null;
    try {
      refused = await row.consume(account);
    } catch (e) {
      console.error('connect-link consume failed', e);
      return { ok: false, at: 'consume', reason: 'unknown' };
    }
    if (refused) return { ok: false, at: 'consume', reason: refused };
  }
  try {
    await store();
    return { ok: true };
  } catch (error) {
    let restored = false;
    if (row) {
      try {
        restored = await row.restore();
      } catch (restoreErr) {
        // The refusal copy falls back to asking for a new link.
        console.error('connect-link restore failed', restoreErr);
      }
    }
    return { ok: false, at: 'store', error, restored };
  }
}
