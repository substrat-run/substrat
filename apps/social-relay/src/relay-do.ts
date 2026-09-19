/**
 * The relay's store, as one Durable Object.
 *
 * ONE instance, named `relay`: the client registry is global to this worker, and an
 * authorization round has to find the same state on the way back that it left on the way
 * out. That is a deliberate bottleneck with a known exit — every method here is keyed by
 * either a client id or a random flow id, so sharding on the first character of that key
 * is a change to `storeOf` and nothing else. It is not worth doing before a number says
 * so: a sign-in costs two round trips to this object, and a Durable Object serves those
 * at a rate no realistic install fleet approaches.
 *
 * The signing key is generated HERE on first use and persisted, so there is no shared
 * `wrangler secret` to provision and no way for two deployments to accidentally share
 * one — the same argument the auth-server makes for its per-issuer Better Auth secret.
 */
import { DurableObject } from 'cloudflare:workers';
import type { ClientRecord, FlowRecord, CodeRecord, RegisterClientInput, RelayStore } from './do-contract.js';
import { generateSigningKey, randomToken, sha256b64url, timingSafeEqual, type SigningKey } from './jwt.js';
import {
  applySchema,
  countInWindow,
  insertClient,
  insertKey,
  putEphemeral,
  removeClient,
  selectClient,
  selectClients,
  selectClientSecretHash,
  selectKey,
  sweepExpired,
  takeEphemeral,
  updateClientDisabled,
  type SqlExec,
} from './store.js';

/** The rate window: one minute, fixed. See `countInWindow` for why fixed rather than sliding. */
const RATE_WINDOW_MS = 60_000;

export class RelayDO extends DurableObject implements RelayStore {
  private readonly sql: SqlExec;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx as never, env as never);
    this.sql = ctx.storage.sql as unknown as SqlExec;
    ctx.blockConcurrencyWhile(async () => {
      applySchema(this.sql);
    });
  }

  async signingKey(): Promise<SigningKey> {
    const stored = selectKey(this.sql);
    if (stored) {
      return {
        kid: stored.kid,
        privateJwk: JSON.parse(stored.privateJwk) as JsonWebKey,
        publicJwk: JSON.parse(stored.publicJwk) as JsonWebKey,
      };
    }
    const key = await generateSigningKey();
    insertKey(this.sql, {
      kid: key.kid,
      privateJwk: JSON.stringify(key.privateJwk),
      publicJwk: JSON.stringify(key.publicJwk),
    });
    // Re-read rather than return what was just built: if two cold requests raced into
    // this method, the loser's INSERT did nothing and its key must not be the one used.
    const winner = selectKey(this.sql);
    return winner
      ? {
          kid: winner.kid,
          privateJwk: JSON.parse(winner.privateJwk) as JsonWebKey,
          publicJwk: JSON.parse(winner.publicJwk) as JsonWebKey,
        }
      : key;
  }

  async registerClient(input: RegisterClientInput, now: number): Promise<{ clientId: string; clientSecret: string }> {
    const clientId = randomToken(16);
    const clientSecret = randomToken(32);
    insertClient(this.sql, {
      clientId,
      name: input.name,
      secretHash: await sha256b64url(clientSecret),
      redirectUris: input.redirectUris,
      createdAt: now,
    });
    // The only time the secret exists outside a hash. The caller stores it or loses it.
    return { clientId, clientSecret };
  }

  async getClient(clientId: string): Promise<ClientRecord | null> {
    return selectClient(this.sql, clientId);
  }

  async verifyClientSecret(clientId: string, secret: string): Promise<boolean> {
    const stored = selectClientSecretHash(this.sql, clientId);
    if (!stored) return false;
    return timingSafeEqual(stored, await sha256b64url(secret));
  }

  async setClientDisabled(clientId: string, disabled: boolean): Promise<boolean> {
    return updateClientDisabled(this.sql, clientId, disabled);
  }

  async deleteClient(clientId: string): Promise<boolean> {
    return removeClient(this.sql, clientId);
  }

  async listClients(): Promise<ClientRecord[]> {
    return selectClients(this.sql);
  }

  async putFlow(id: string, flow: FlowRecord, expiresAt: number): Promise<void> {
    putEphemeral(this.sql, `flow:${flow.provider}`, id, JSON.stringify(flow), expiresAt);
  }

  async takeFlow(id: string, provider: string, now: number): Promise<FlowRecord | null> {
    const payload = takeEphemeral(this.sql, `flow:${provider}`, id, now);
    return payload ? (JSON.parse(payload) as FlowRecord) : null;
  }

  async putCode(id: string, code: CodeRecord, expiresAt: number): Promise<void> {
    putEphemeral(this.sql, `code:${code.provider}`, id, JSON.stringify(code), expiresAt);
  }

  async takeCode(id: string, provider: string, now: number): Promise<CodeRecord | null> {
    const payload = takeEphemeral(this.sql, `code:${provider}`, id, now);
    return payload ? (JSON.parse(payload) as CodeRecord) : null;
  }

  /**
   * Every round starts here, which makes it the one place guaranteed to run often enough
   * to be worth sweeping from — and it is the only method that is handed the current time
   * without also being asked to enforce something with it.
   */
  async countAuthorize(clientId: string, now: number): Promise<number> {
    sweepExpired(this.sql, now);
    return countInWindow(this.sql, clientId, Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS);
  }
}
