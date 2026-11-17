import {
  PLATFORM_SECRET_HEADER,
  SOCIAL_RELAY_SELF_PATH,
  socialRelayProviders,
  socialRelaySelfOutcome,
} from '@substrat-run/contracts';
import { missingRelayProviders, type HealClaim, type HealResult } from './social-relay-heal.js';

/**
 * The network half of platform sign-in's self-heal (#1544, `social-relay-heal.ts`): reading the
 * relay's public provider list, and asking the control plane to reconcile this install
 * (`SOCIAL_RELAY_SELF_PATH`). Called from the worker (`routes.ts`) and nowhere else.
 *
 * A declared network boundary in the same class as `bankid-transport-hop.ts`: the issuer has no
 * `ctx` and no connector to delegate to, and the file exists separately so what it calls and why
 * is reviewable in one place.
 */

/** Structural, like the BankID hop's: the worker's `fetch` and a test's both fit. */
type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface HealTransport {
  controlPlaneUrl: string;
  platformSecret: string;
  /** Called in an arrow, never handed on bare (`lint:bound-fetch`). */
  fetch: FetchLike;
  /** Per call. */
  timeoutMs?: number;
}

const HEAL_TIMEOUT_MS = 15_000;

/**
 * Make one claimed attempt. An automatic one first checks whether anything is missing: with a
 * client held and a relay to ask, nothing missing is `current` and the platform is not asked. A
 * relay that cannot be read is no reason to leave a missing provider missing, so the platform is
 * asked then too — it reads the relay itself.
 */
export async function runHeal(claim: HealClaim, trigger: 'auto' | 'manual', transport: HealTransport): Promise<HealResult> {
  if (trigger === 'auto' && claim.hasClient && claim.relayOrigin) {
    const served = await readRelayProviders(claim.relayOrigin, transport).catch(() => null);
    if (served && missingRelayProviders(served, claim.providerIds).length === 0) return { status: 'current' };
  }
  return requestSelfHeal({ tenantId: claim.tenantId, scopeId: claim.scopeId, hasClient: claim.hasClient }, transport);
}

async function readRelayProviders(origin: string, transport: HealTransport): Promise<string[]> {
  const res = await transport.fetch(`${origin}/providers`, { signal: timeout(transport) });
  if (!res.ok) throw new Error(`the relay answered ${res.status}`);
  return socialRelayProviders.parse(await res.json()).providers.map((p) => p.id);
}

/** Ask the control plane to reconcile this install's relay client. Never throws: a failure is a result. */
export async function requestSelfHeal(
  request: { tenantId: string; scopeId: string; hasClient: boolean },
  transport: HealTransport,
): Promise<HealResult> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await transport.fetch(`${transport.controlPlaneUrl.replace(/\/+$/, '')}${SOCIAL_RELAY_SELF_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PLATFORM_SECRET_HEADER]: transport.platformSecret },
      body: JSON.stringify(request),
      signal: timeout(transport),
    });
  } catch (e) {
    return { status: 'failed', reason: `the platform could not be reached: ${e instanceof Error ? e.message : String(e)}` };
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const detail = (body as { detail?: unknown } | null)?.detail;
    return { status: 'failed', reason: typeof detail === 'string' ? detail : `the platform answered ${res.status}` };
  }
  const outcome = socialRelaySelfOutcome.safeParse(body);
  if (!outcome.success) return { status: 'failed', reason: 'the platform answered with something unreadable' };
  return outcome.data.status === 'delivered'
    ? { status: 'delivered', providers: outcome.data.providers }
    : { status: 'skipped', reason: outcome.data.reason };
}

function timeout(transport: HealTransport): AbortSignal {
  return AbortSignal.timeout(transport.timeoutMs ?? HEAL_TIMEOUT_MS);
}
