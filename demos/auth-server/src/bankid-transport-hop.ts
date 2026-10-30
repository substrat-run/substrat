import { BANKID_ROOT_CA, BANKID_TIMEOUT_MS, type BankIdConfig, type BankIdTransport } from './bankid.js';

/**
 * The hosted half of the BankID seam (docs/rfc/mtls-hop.md): every RP call goes to the platform's
 * sign-in relay, which opens the socket and presents the certificate this install sends with the
 * call. A hosted instance cannot do either itself — its `fetch` takes no client certificate, and
 * a dispatched script has no `connect()` — so the relay is the hop, and nothing more: the orders,
 * the QR, `collect` and the sign-in all stay here, and the relay keeps nothing once a call ends.
 *
 * Authenticated with the relay client the platform gave this install for social sign-in
 * (`relayHop` in `social-relay.ts`), so the relay knows which install is calling even though
 * the call is made from inside this Durable Object.
 *
 * A declared network boundary in the same class as `bankid-transport-node.ts` and `cimd-fetch.ts`:
 * the issuer IS the relying party here, with no `ctx` and no connector to delegate to.
 */

/** A call the relay could not complete, at the stage it stopped. `probeBankId` reports it as is. */
export class BankIdHopError extends Error {
  constructor(
    readonly stage: string,
    message: string,
    readonly stages: { stage: string; ms: number }[] = [],
  ) {
    super(message);
    this.name = 'BankIdHopError';
  }
}

/** How long the relay is given beyond its own deadline for the same call, before we stop waiting. */
const HOP_GRACE_MS = 2_000;

export interface BankIdHop {
  /** The relay's origin, e.g. `https://id.substrat.net`. */
  origin: string;
  clientId: string;
  clientSecret: string;
}

export function hopBankIdTransport(
  hop: BankIdHop,
  cfg: Pick<BankIdConfig, 'environment' | 'clientCert' | 'clientKey' | 'caCert'>,
  // Structural, like `fetchBankIdTransport`'s: the worker's `fetch` and a test's both fit.
  fetchImpl: (
    input: string,
    init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
  ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
): BankIdTransport {
  // RFC 6749 §2.3.1: each half form-encoded before the Basic pair, which is how the relay reads it.
  const authorization = `Basic ${btoa(`${encodeURIComponent(hop.clientId)}:${encodeURIComponent(hop.clientSecret)}`)}`;
  return async (url, body) => {
    // `url` is BankID's own (`bankIdApiUrl` + the call); the relay is told the environment and the
    // path, and chooses the host itself.
    const { pathname } = new URL(url);
    const res = await fetchImpl(`${hop.origin}/mtls/bankid/${cfg.environment}${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify({
        certPem: cfg.clientCert,
        keyPem: cfg.clientKey,
        caPem: cfg.caCert ?? BANKID_ROOT_CA[cfg.environment],
        body,
      }),
      signal: AbortSignal.timeout(BANKID_TIMEOUT_MS + HOP_GRACE_MS),
    });
    const answer = (await res.json().catch(() => undefined)) as
      | { status?: number; body?: unknown; stage?: string; detail?: string; stages?: { stage: string; ms: number }[] }
      | undefined;
    if (res.ok && typeof answer?.status === 'number') return { status: answer.status, body: answer.body };
    throw new BankIdHopError(
      answer?.stage ?? 'relay',
      answer?.detail ?? `the sign-in relay answered ${res.status}`,
      Array.isArray(answer?.stages) ? answer.stages : [],
    );
  };
}
