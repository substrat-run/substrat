/**
 * The shape the HTTP surface sees of the relay's storage — the seam that keeps
 * `routes.ts` free of `cloudflare:workers` and therefore testable in a plain node
 * process, exactly as the auth-server's `do-contract.ts` does for its issuer.
 *
 * What is stored here is deliberately small and deliberately short-lived. The relay holds
 * no users, no sessions and no accounts (#1544): a person who signs in through it leaves
 * nothing behind. What survives a request is the client registry — one row per installed
 * issuer, written by the platform — and the signing key. Everything else is in-flight
 * state with a minute or ten on its life.
 */
import type { SigningKey } from './jwt.js';

/** A tenant issuer registered at the relay. The secret is stored hashed and never read back. */
export interface ClientRecord {
  clientId: string;
  name: string;
  /** Exact-match list. A redirect URI that is not character-for-character here is refused. */
  redirectUris: string[];
  /** The per-install kill switch: one abusive install must not cost everyone sign-in. */
  disabled: boolean;
  createdAt: number;
}

/** An authorization round in flight: minted at `/authorize`, consumed at the callback. */
export interface FlowRecord {
  provider: string;
  clientId: string;
  redirectUri: string;
  /** The tenant's own `state`, handed back untouched — this relay never inspects it. */
  state: string;
  nonce?: string;
  codeChallenge: string;
}

/** An issued authorization code: minted at the callback, consumed at `/token`. */
export interface CodeRecord {
  provider: string;
  clientId: string;
  redirectUri: string;
  nonce?: string;
  codeChallenge: string;
  sub: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
}

export interface RegisterClientInput {
  name: string;
  redirectUris: string[];
}

/**
 * The store, as RPC. Every method that consumes something is a TAKE rather than a read
 * plus a delete: an authorization code is single-use, and single-use is a property of the
 * statement that deletes it, not of the caller remembering to.
 */
export interface RelayStore {
  /** The relay's ES256 key, generated on first call and persisted thereafter. */
  signingKey(): Promise<SigningKey>;
  registerClient(input: RegisterClientInput, now: number): Promise<{ clientId: string; clientSecret: string }>;
  getClient(clientId: string): Promise<ClientRecord | null>;
  /** Compares inside the DO so the stored hash never crosses this seam. */
  verifyClientSecret(clientId: string, secret: string): Promise<boolean>;
  setClientDisabled(clientId: string, disabled: boolean): Promise<boolean>;
  deleteClient(clientId: string): Promise<boolean>;
  listClients(): Promise<ClientRecord[]>;
  putFlow(id: string, flow: FlowRecord, expiresAt: number): Promise<void>;
  takeFlow(id: string, now: number): Promise<FlowRecord | null>;
  putCode(id: string, code: CodeRecord, expiresAt: number): Promise<void>;
  takeCode(id: string, now: number): Promise<CodeRecord | null>;
  /** Count this authorization against the client's window; returns the new count. */
  countAuthorize(clientId: string, now: number): Promise<number>;
}
