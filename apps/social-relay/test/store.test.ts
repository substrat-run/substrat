import { describe, expect, it } from 'vitest';
import {
  applySchema,
  countInWindow,
  ensureClientRow,
  insertClient,
  putEphemeral,
  releaseRotationLease,
  rotateClientSecretRow,
  ROTATION_LEASE_MS,
  selectSecretGeneration,
  selectClient,
  selectClientSecretHash,
  sweepExpired,
  takeEphemeral,
} from '../src/store.js';
import { sqlExecOf } from './support.js';
import Database from 'better-sqlite3';
import { sha256b64url } from '../src/jwt.js';

/**
 * The store's two load-bearing properties are properties of its SQL, so they are asserted
 * against a real database. A code that can be redeemed twice is a replay; a row that
 * outlives its expiry is a longer TTL than anyone agreed to.
 */
const freshSql = () => {
  const sql = sqlExecOf(new Database(':memory:'));
  applySchema(sql);
  return sql;
};

describe('in-flight state', () => {
  it('hands a payload back exactly once', () => {
    const sql = freshSql();
    putEphemeral(sql, 'code', 'abc', '{"sub":"1"}', 2_000);
    expect(takeEphemeral(sql, 'code', 'abc', 1_000)).toBe('{"sub":"1"}');
    expect(takeEphemeral(sql, 'code', 'abc', 1_000)).toBeNull();
  });

  it('refuses an expired row, and does not leave it behind', () => {
    const sql = freshSql();
    putEphemeral(sql, 'flow', 'abc', '{}', 1_000);
    expect(takeEphemeral(sql, 'flow', 'abc', 1_001)).toBeNull();
    expect(sql.exec('SELECT count(*) AS c FROM relay_ephemeral').toArray()[0]).toEqual({ c: 0 });
  });

  it('leaves every other round in flight alone when a new one starts', () => {
    // The regression: the sweep used to run on every write, against the expiry of the row
    // being WRITTEN rather than the current time — so the second of two sign-ins a second
    // apart deleted the first one's flow, and its callback answered "already completed".
    const sql = freshSql();
    putEphemeral(sql, 'flow:google', 'first', 'first-payload', 10_000);
    putEphemeral(sql, 'flow:google', 'second', 'second-payload', 11_500);
    expect(takeEphemeral(sql, 'flow:google', 'first', 9_000)).toBe('first-payload');
    expect(takeEphemeral(sql, 'flow:google', 'second', 9_000)).toBe('second-payload');
  });

  it('sweeps what has expired and nothing else', () => {
    const sql = freshSql();
    putEphemeral(sql, 'flow:google', 'gone', 'x', 1_000);
    putEphemeral(sql, 'flow:google', 'alive', 'y', 5_000);
    sweepExpired(sql, 2_000);
    expect(takeEphemeral(sql, 'flow:google', 'gone', 2_000)).toBeNull();
    expect(takeEphemeral(sql, 'flow:google', 'alive', 2_000)).toBe('y');
  });

  it('keeps the two kinds apart', () => {
    const sql = freshSql();
    putEphemeral(sql, 'flow', 'same-id', 'flow-payload', 2_000);
    putEphemeral(sql, 'code', 'same-id', 'code-payload', 2_000);
    expect(takeEphemeral(sql, 'flow', 'same-id', 1_000)).toBe('flow-payload');
    expect(takeEphemeral(sql, 'code', 'same-id', 1_000)).toBe('code-payload');
  });
});

describe('the rate window', () => {
  it('counts per client and resets on the next window', () => {
    const sql = freshSql();
    expect(countInWindow(sql, 'client-a', 60_000)).toBe(1);
    expect(countInWindow(sql, 'client-a', 60_000)).toBe(2);
    expect(countInWindow(sql, 'client-b', 60_000)).toBe(1);
    expect(countInWindow(sql, 'client-a', 120_000)).toBe(1);
  });
});

describe('the client registry', () => {
  it('round-trips a client, redirect URIs included', () => {
    const sql = freshSql();
    insertClient(sql, {
      clientId: 'cid',
      name: 'An install',
      secretHash: 'hash',
      redirectUris: ['https://a.example/cb', 'https://b.example/cb'],
      createdAt: 7,
    });
    expect(selectClient(sql, 'cid')).toEqual({
      clientId: 'cid',
      name: 'An install',
      redirectUris: ['https://a.example/cb', 'https://b.example/cb'],
      disabled: false,
      createdAt: 7,
      ref: null,
    });
  });

  it('adds the ref and generation columns to a registry created before they existed, keeping its clients', () => {
    // Production registered clients before `ref` existed; the DO re-applies the schema on
    // start, so that table must gain the column in place rather than fail or be re-created.
    const database = new Database(':memory:');
    const sql = sqlExecOf(database);
    sql.exec(`CREATE TABLE relay_client (
      client_id TEXT PRIMARY KEY, name TEXT NOT NULL, secret_hash TEXT NOT NULL,
      redirect_uris TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
    sql.exec(
      `INSERT INTO relay_client (client_id, name, secret_hash, redirect_uris, created_at) VALUES ('old', 'Old', 'h', '[]', 1)`,
    );
    applySchema(sql);
    applySchema(sql);
    expect(selectClient(sql, 'old')).toMatchObject({ clientId: 'old', ref: null });
    expect(selectSecretGeneration(sql, 'old')).toBe(1);
  });
});

describe('ensuring a client by ref', () => {
  const input = { name: 'An install', redirectUris: ['https://a.example/api/auth/callback/github-relay'] };

  it('creates once, with a secret that matches the stored hash', async () => {
    const sql = freshSql();
    const first = await ensureClientRow(sql, 'scope:01', input, 5);
    expect(first).toMatchObject({ created: true, disabled: false });
    expect(first.clientSecret).toBeTruthy();
    expect(selectClientSecretHash(sql, first.clientId)).toBe(await sha256b64url(first.clientSecret!));
  });

  it('finds the same client again, replaces its URIs and name, and never re-issues the secret', async () => {
    const sql = freshSql();
    const first = await ensureClientRow(sql, 'scope:01', input, 5);
    const hash = selectClientSecretHash(sql, first.clientId);
    const second = await ensureClientRow(
      sql,
      'scope:01',
      { name: 'Renamed', redirectUris: ['https://b.example/api/auth/callback/google-relay'] },
      9,
    );
    expect(second).toEqual({ clientId: first.clientId, clientSecret: null, created: false, disabled: false, generation: 1 });
    expect(selectClient(sql, first.clientId)).toMatchObject({
      name: 'Renamed',
      redirectUris: ['https://b.example/api/auth/callback/google-relay'],
      createdAt: 5,
    });
    expect(selectClientSecretHash(sql, first.clientId)).toBe(hash);
  });

  it('keeps two installs apart', async () => {
    const sql = freshSql();
    const a = await ensureClientRow(sql, 'scope:a', input, 5);
    const b = await ensureClientRow(sql, 'scope:b', input, 5);
    expect(a.clientId).not.toBe(b.clientId);
  });

  it('leaves a disabled client disabled — the kill switch is not the reconciler’s to lift', async () => {
    const sql = freshSql();
    const first = await ensureClientRow(sql, 'scope:01', input, 5);
    sql.exec('UPDATE relay_client SET disabled = 1 WHERE client_id = ?', first.clientId);
    expect(await ensureClientRow(sql, 'scope:01', input, 6)).toMatchObject({ created: false, disabled: true });
    expect(selectClient(sql, first.clientId)?.disabled).toBe(true);
  });

});

describe('rotating a secret (#3275)', () => {
  const input = { name: 'An install', redirectUris: ['https://a.example/api/auth/callback/github-relay'] };
  /** A client whose creation lease has been given back, as a creating run that delivered leaves it. */
  const created = async (sql: ReturnType<typeof freshSql>) => {
    const first = await ensureClientRow(sql, 'scope:01', input, 5);
    expect(first).toMatchObject({ created: true, generation: 1, lease: expect.any(String) });
    expect(releaseRotationLease(sql, first.clientId, first.lease!)).toBe(true);
    return first;
  };

  it('rotates at the generation it was told, so only the new secret matches, and answers null for no client', async () => {
    const sql = freshSql();
    const first = await created(sql);
    const rotated = await rotateClientSecretRow(sql, first.clientId, 1, 10);
    expect(rotated).toMatchObject({ status: 'rotated', generation: 2, lease: expect.any(String) });
    if (rotated?.status !== 'rotated') throw new Error('unreachable');
    expect(rotated.clientSecret).not.toBe(first.clientSecret);
    expect(selectClientSecretHash(sql, first.clientId)).toBe(await sha256b64url(rotated.clientSecret));
    expect(selectSecretGeneration(sql, first.clientId)).toBe(2);
    expect(await ensureClientRow(sql, 'scope:01', input, 11)).toMatchObject({ created: false, generation: 2 });
    expect(await rotateClientSecretRow(sql, 'nobody', 1, 10)).toBeNull();
  });

  it('refuses a second rotation while the first one’s lease is held, and one from a generation that moved on', async () => {
    const sql = freshSql();
    const first = await created(sql);
    const a = await rotateClientSecretRow(sql, first.clientId, 1, 10);
    expect(a).toMatchObject({ status: 'rotated', generation: 2 });
    const hash = selectClientSecretHash(sql, first.clientId);
    // The lease alone refuses, even naming the generation that is now current.
    expect(await rotateClientSecretRow(sql, first.clientId, 2, 11)).toEqual({ status: 'busy' });
    // The compare-and-set alone refuses, once the lease is given back: B saw generation 1.
    expect(releaseRotationLease(sql, first.clientId, (a as { lease: string }).lease)).toBe(true);
    expect(await rotateClientSecretRow(sql, first.clientId, 1, 12)).toEqual({ status: 'moved', generation: 2 });
    expect(selectClientSecretHash(sql, first.clientId)).toBe(hash);
    expect(selectSecretGeneration(sql, first.clientId)).toBe(2);
  });

  it('holds the creation’s secret too, until it is given back or the lease runs out', async () => {
    const sql = freshSql();
    const first = await ensureClientRow(sql, 'scope:01', input, 5);
    expect(await rotateClientSecretRow(sql, first.clientId, 1, 6)).toEqual({ status: 'busy' });
    expect(await rotateClientSecretRow(sql, first.clientId, 1, 5 + ROTATION_LEASE_MS)).toMatchObject({ status: 'rotated' });
  });

  it('gives back only the holder’s own lease', async () => {
    const sql = freshSql();
    const first = await ensureClientRow(sql, 'scope:01', input, 5);
    expect(releaseRotationLease(sql, first.clientId, 'not-the-lease')).toBe(false);
    expect(await rotateClientSecretRow(sql, first.clientId, 1, 6)).toEqual({ status: 'busy' });
    expect(releaseRotationLease(sql, first.clientId, first.lease!)).toBe(true);
    expect(await rotateClientSecretRow(sql, first.clientId, 1, 7)).toMatchObject({ status: 'rotated' });
  });
});
