import { describe, expect, it } from 'vitest';
import {
  applySchema,
  countInWindow,
  ensureClientRow,
  insertClient,
  putEphemeral,
  rotateClientSecretRow,
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

  it('adds the ref column to a registry created before it existed, keeping its clients', () => {
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
    expect(second).toEqual({ clientId: first.clientId, clientSecret: null, created: false, disabled: false });
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

  it('rotates a secret so only the new one matches, and answers null for an unknown client', async () => {
    const sql = freshSql();
    const first = await ensureClientRow(sql, 'scope:01', input, 5);
    const rotated = await rotateClientSecretRow(sql, first.clientId);
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(first.clientSecret);
    expect(selectClientSecretHash(sql, first.clientId)).toBe(await sha256b64url(rotated!));
    expect(await rotateClientSecretRow(sql, 'nobody')).toBeNull();
  });
});
