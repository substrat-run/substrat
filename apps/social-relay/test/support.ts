import Database from 'better-sqlite3';
import type { ClientRecord, CodeRecord, FlowRecord, RegisterClientInput, RelayStore } from '../src/do-contract.js';
import { generateSigningKey, randomToken, sha256b64url, timingSafeEqual, type SigningKey } from '../src/jwt.js';
import {
  applySchema,
  countInWindow,
  insertClient,
  putEphemeral,
  removeClient,
  selectClient,
  selectClientSecretHash,
  selectClients,
  sweepExpired,
  takeEphemeral,
  updateClientDisabled,
  type SqlExec,
} from '../src/store.js';

/**
 * The store the suite runs against: the SAME functions the Durable Object calls, over a
 * real SQLite database rather than a hand-written fake. A fake store would agree with
 * whatever the routes expect and prove nothing about the statements — and the statements
 * are where single-use and expiry actually live.
 */
export function sqlExecOf(database: Database.Database): SqlExec {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = database.prepare(query);
      if (!stmt.reader) {
        stmt.run(...(bindings as []));
        return { columnNames: [], toArray: () => [], raw: () => [][Symbol.iterator]() };
      }
      const objects = stmt.all(...(bindings as [])) as Record<string, unknown>[];
      return {
        columnNames: stmt.columns().map((c) => c.name),
        toArray: () => objects,
        raw: () => (stmt.raw(true).all(...(bindings as [])) as unknown[][]).values(),
      };
    },
  };
}

export interface TestStore extends RelayStore {
  sql: SqlExec;
}

export function testStore(): TestStore {
  const db = new Database(':memory:');
  const sql = sqlExecOf(db);
  applySchema(sql);
  let key: SigningKey | undefined;
  return {
    sql,
    async signingKey() {
      key ??= await generateSigningKey();
      return key;
    },
    async registerClient(input: RegisterClientInput, now: number) {
      const clientId = randomToken(16);
      const clientSecret = randomToken(32);
      insertClient(sql, {
        clientId,
        name: input.name,
        secretHash: await sha256b64url(clientSecret),
        redirectUris: input.redirectUris,
        createdAt: now,
      });
      return { clientId, clientSecret };
    },
    async getClient(clientId: string): Promise<ClientRecord | null> {
      return selectClient(sql, clientId);
    },
    async verifyClientSecret(clientId: string, secret: string) {
      const stored = selectClientSecretHash(sql, clientId);
      return stored ? timingSafeEqual(stored, await sha256b64url(secret)) : false;
    },
    async setClientDisabled(clientId: string, disabled: boolean) {
      return updateClientDisabled(sql, clientId, disabled);
    },
    async deleteClient(clientId: string) {
      return removeClient(sql, clientId);
    },
    async listClients() {
      return selectClients(sql);
    },
    async putFlow(id: string, flow: FlowRecord, expiresAt: number) {
      putEphemeral(sql, `flow:${flow.provider}`, id, JSON.stringify(flow), expiresAt);
    },
    async takeFlow(id: string, provider: string, now: number) {
      const payload = takeEphemeral(sql, `flow:${provider}`, id, now);
      return payload ? (JSON.parse(payload) as FlowRecord) : null;
    },
    async putCode(id: string, code: CodeRecord, expiresAt: number) {
      putEphemeral(sql, `code:${code.provider}`, id, JSON.stringify(code), expiresAt);
    },
    async takeCode(id: string, provider: string, now: number) {
      const payload = takeEphemeral(sql, `code:${provider}`, id, now);
      return payload ? (JSON.parse(payload) as CodeRecord) : null;
    },
    async countAuthorize(clientId: string, now: number) {
      sweepExpired(sql, now);
      return countInWindow(sql, clientId, Math.floor(now / 60_000) * 60_000);
    },
  };
}

/** The DO namespace shape `routes.ts` expects, answering with one store. */
export function namespaceOf(store: RelayStore) {
  return { idFromName: (name: string) => name, get: () => store };
}

/** An ES256 keypair in PEM form, for the Apple client-secret tests. */
export async function pkcs8Pem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  const base64 = btoa(binary).replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}
