import { tenantId as tenantIdSchema } from '@substrat-run/contracts';
import { settleConnectionUse, type FetchLike, type HostAdmin } from '@substrat-run/kernel';
import { acquireToken, microsoft365Secret, type Microsoft365Secret } from './credential.js';
import type { GraphClient } from './graph.js';

export const MICROSOFT365_PROVIDER = 'microsoft365';

export interface Microsoft365Options {
  fetch: FetchLike;
  /** Overrides for a test deployment pointed at a stub. Unset = the real hosts. */
  loginBase?: string;
  graphBase?: string;
  now?: () => Date;
  timeoutMs?: number;
}

/** Which connection: a row, or the ids a binding recorded. The tenant id is parsed on open. */
export type ConnectionRef = { id: string; tenantId: string; vertical: string };

export const nowOf = (o: Pick<Microsoft365Options, 'now'>) => (o.now ? o.now() : new Date());
export const loginOf = (o: Microsoft365Options) => (o.loginBase ? { loginBase: o.loginBase } : {});

export function graph(fetchImpl: FetchLike, accessToken: string, options: Microsoft365Options): GraphClient {
  return { fetch: fetchImpl, accessToken, ...(options.graphBase ? { graphBase: options.graphBase } : {}) };
}

export async function openSecret(admin: HostAdmin, connection: ConnectionRef) {
  const open = await admin.openConnection(
    tenantIdSchema.parse(connection.tenantId),
    connection.vertical,
    MICROSOFT365_PROVIDER,
  );
  if (!open) {
    throw new Error(
      `no live '${MICROSOFT365_PROVIDER}' connection for tenant ${connection.tenantId} / vertical '${connection.vertical}'`,
    );
  }
  // The row the caller named and the credential opened must be the same connection.
  if (open.id !== connection.id) {
    throw new Error(
      `connection ${connection.id} is not the live '${MICROSOFT365_PROVIDER}' connection (${open.id}) for this tenant`,
    );
  }
  return { open, secret: microsoft365Secret.parse(open.secret) };
}

/** The live connection, its parsed secret, and egress that records health against it. */
export async function openMicrosoft365Connection(
  admin: HostAdmin,
  options: Microsoft365Options,
  connection: ConnectionRef,
) {
  const { open, secret } = await openSecret(admin, connection);
  const timeoutMs = options.timeoutMs ?? 15_000;
  type Settled = Parameters<typeof settleConnectionUse>[2];
  const record = (durationMs: number, settled: Settled) =>
    admin.recordConnectionUse(open.id, settleConnectionUse(MICROSOFT365_PROVIDER, durationMs, settled));
  /** The fetch, timed out, reporting each settlement (with its duration) to `settle`. */
  const timed =
    (settle: (durationMs: number, settled: Settled) => Promise<void> | void): FetchLike =>
    async (input, init) => {
      const started = Date.now();
      try {
        const res = await options.fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        await settle(Date.now() - started, { response: res });
        return res;
      } catch (err) {
        await settle(Date.now() - started, { error: err });
        throw err;
      }
    };
  /** A fetch for one sign-in: every attempt is held, and `record` writes only the last. */
  const signInFetch = () => {
    let last: [number, Settled] | undefined;
    return {
      fetch: timed((ms, settled) => void (last = [ms, settled])),
      record: async () => {
        if (last) await record(...last);
      },
    };
  };
  return { id: open.id, secret, fetch: timed(record), signInFetch };
}

export type OpenedMicrosoft365 = Awaited<ReturnType<typeof openMicrosoft365Connection>>;

/**
 * Sign in as the connection and hand back a Graph client on its recorded egress. One sign-in is
 * one use: mid-rotation it may take two requests (the current certificate, then its successor),
 * and only the attempt that decided the answer is recorded.
 */
export async function signedInGraph(conn: OpenedMicrosoft365, options: Microsoft365Options): Promise<GraphClient> {
  const signIn = conn.signInFetch();
  const token = await acquireToken(signIn.fetch, conn.secret, { now: nowOf(options), ...loginOf(options) }).finally(
    signIn.record,
  );
  if (!token.ok) throw new Error(`Microsoft 365 sign-in failed: ${token.error}`);
  return graph(conn.fetch, token.accessToken, options);
}

/** Sign in with a fetch the caller already bound to a connection (a dispatch's `conn.fetch`). */
export async function signedInGraphWith(
  fetchImpl: FetchLike,
  secret: Microsoft365Secret,
  options: Microsoft365Options,
): Promise<GraphClient> {
  const token = await acquireToken(fetchImpl, secret, { now: nowOf(options), ...loginOf(options) });
  if (!token.ok) throw new Error(`Microsoft 365 sign-in failed: ${token.error}`);
  return graph(fetchImpl, token.accessToken, options);
}
