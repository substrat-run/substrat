import { describe, it, expect } from 'vitest';
import { batchesOf, csvRows, inFileRows, mergeBatchResults, parseImportFile, unverifiedNotice } from '../app/src/user-import-file.js';
import type { ImportOutcome } from '../src/user-import-wire.js';

/**
 * The browser half of "Import users": a dropped file → the import body. The server holds
 * every rule about what is stored (`test/user-import.test.ts`); what is pinned here is that
 * an ordinary export arrives in that shape with nothing lost or invented — above all the id,
 * which is the person's `sub` and must come through verbatim.
 */

const HASH = `$2a$10$${'a'.repeat(53)}`;

describe('CSV', () => {
  it('reads the columns an export is likely to have, case-insensitively', () => {
    const csv = [
      'User_ID,Email,Name,email_verified,password,GitHub,google,created_at,last_login',
      `auth2|abc,ada@example.test,"Lovelace, Ada",1,${HASH},123,,2025-01-02T03:04:05Z,whenever`,
      'google-oauth2|9,g@example.test,,false,,,987,1735787045,',
    ].join('\r\n');
    const { users, ignoredColumns } = parseImportFile('export.csv', csv);
    expect(ignoredColumns).toEqual(['last_login']);
    expect(users).toEqual([
      {
        id: 'auth2|abc',
        email: 'ada@example.test',
        name: 'Lovelace, Ada',
        emailVerified: true,
        passwordHash: HASH,
        accounts: [{ providerId: 'github', accountId: '123' }],
        createdAt: '2025-01-02T03:04:05.000Z',
      },
      {
        id: 'google-oauth2|9',
        email: 'g@example.test',
        emailVerified: false,
        accounts: [{ providerId: 'google', accountId: '987' }],
        createdAt: '2025-01-02T03:04:05.000Z',
      },
    ]);
  });

  it('handles quotes, doubled quotes and newlines inside a field', () => {
    expect(csvRows('a,b\n"x ""y""","line\nbreak"\n')).toEqual([['a', 'b'], ['x "y"', 'line\nbreak']]);
  });

  it('opens a quote after leading whitespace, as hand-edited exports write it', () => {
    expect(parseImportFile('x.csv', 'id, name, email\n1, "Lovelace, Ada", a@example.test').users).toEqual([
      { id: '1', name: 'Lovelace, Ada', email: 'a@example.test' },
    ]);
  });

  it('tells a compact date from an epoch by its digit count', () => {
    const at = (v: string) => parseImportFile('x.csv', `id,email,created_at\n1,a@example.test,${v}`).users[0]!.createdAt;
    expect(at('20250102')).toBe('2025-01-02T00:00:00.000Z');
    expect(at('1735787045')).toBe('2025-01-02T03:04:05.000Z');
    expect(at('1735787045000')).toBe('2025-01-02T03:04:05.000Z');
    expect(() => at('12345')).toThrow(/line 2: created_at '12345' is not a date/);
  });

  it('refuses a file with no id column — the id is the sub and cannot be invented', () => {
    expect(() => parseImportFile('x.csv', 'email,name\na@example.test,A')).toThrow(/no id column/);
  });

  it('names the line whose field count is off', () => {
    expect(() => parseImportFile('x.csv', 'id,email\n1,a@example.test\n2,b@example.test,extra')).toThrow(/line 3/);
  });

  it('strips a byte-order mark, which Excel writes', () => {
    expect(parseImportFile('x.csv', '﻿id,email\n1,a@example.test').users).toEqual([{ id: '1', email: 'a@example.test' }]);
  });
});

describe('JSON', () => {
  const entry = { id: 'auth2|abc', email: 'ada@example.test', passwordHash: HASH };

  it('takes the import body, a bare array, or the converter’s batches', () => {
    expect(parseImportFile('a.json', JSON.stringify({ users: [entry] })).users).toEqual([entry]);
    expect(parseImportFile('b.json', JSON.stringify([entry])).users).toEqual([entry]);
    expect(parseImportFile('c.json', JSON.stringify([[entry], [entry]])).users).toEqual([entry, entry]);
  });

  it('says so when it is not JSON at all', () => {
    expect(() => parseImportFile('a.json', '{nope')).toThrow(/not valid JSON/);
  });
});

describe('the unverified-address notice (#1359)', () => {
  const run = (created: number, unasserted: number, unverified: number, dryRun = true) => ({
    dryRun,
    counts: { created, merged: 0, unchanged: 0, conflict: 0 },
    unverified: { unasserted, unverified },
  });

  it('says nothing when every new person is verified', () => {
    expect(unverifiedNotice(run(3, 0, 0))).toEqual([]);
  });

  it('warns about people with no flag, and says how to fix the export', () => {
    expect(unverifiedNotice(run(3, 2, 0))).toEqual([
      '2 of the 3 new people have no email_verified in the file, so they will be imported as unverified. ' +
        'A relying party that identifies someone by address (a staff roster, an invite) refuses an unverified one ' +
        'until they verify it. If the old issuer had verified them, add an email_verified column to the export and ' +
        'drop the file again.',
    ]);
  });

  it('names people read as not verified (false, or a spelling other than 1/true/yes) on a line of their own', () => {
    expect(unverifiedNotice(run(3, 0, 1))).toEqual(['1 of the 3 new people is read as not verified from the file and will be imported that way.']);
  });

  it('agrees in number', () => {
    const [unasserted, unverified] = unverifiedNotice(run(1, 1, 1));
    expect(unasserted).toMatch(/^1 of the 1 new person has no email_verified/);
    expect(unverified).toMatch(/^1 of the 1 new person is read as not verified/);
    expect(unverifiedNotice(run(4, 0, 2))[0]).toMatch(/^2 of the 4 new people are read as not verified/);
  });

  it('speaks in the past once the import has run', () => {
    const [unasserted, unverified] = unverifiedNotice(run(5, 2, 1, false));
    expect(unasserted).toContain('so they were imported as unverified');
    expect(unverified).toContain('were imported that way');
  });
});

it('reads a spelling other than 1/true/yes as not verified — which is why the notice says "read as"', () => {
  expect(parseImportFile('x.csv', 'id,email,email_verified\n1,a@example.test,Y').users[0]!.emailVerified).toBe(false);
});

it('sums every count across the real run’s batches, the unverified ones included', () => {
  const created = (id: string, emailVerified: boolean | null): ImportOutcome =>
    ({ id, outcome: 'created', password: false, accounts: [], skippedAccounts: [], emailVerified });
  const merged = mergeBatchResults([
    {
      dryRun: false,
      results: [created('1', null), created('2', false)],
      counts: { created: 2, merged: 0, unchanged: 0, conflict: 0 },
      unverified: { unasserted: 1, unverified: 1 },
    },
    {
      dryRun: false,
      results: [created('3', null), { id: '4', outcome: 'unchanged', skippedAccounts: [] }],
      counts: { created: 1, merged: 0, unchanged: 1, conflict: 0 },
      unverified: { unasserted: 1, unverified: 0 },
    },
  ]);
  expect(merged.dryRun).toBe(false);
  expect(merged.results.map((r) => r.id)).toEqual(['1', '2', '3', '4']);
  expect(merged.counts).toEqual({ created: 3, merged: 0, unchanged: 1, conflict: 0 });
  expect(merged.unverified).toEqual({ unasserted: 2, unverified: 1 });
});

it('splits into the server’s batch size', () => {
  expect(batchesOf(Array.from({ length: 1001 }, (_, i) => i)).map((b) => b.length)).toEqual([500, 500, 1]);
});

it('rewrites a server row index to the person’s place in the file', async () => {
  const failing = () => Promise.reject(new Error('users.233.passwordHash: not a bcrypt hash'));
  await expect(inFileRows(500, failing)).rejects.toThrow('person 734 in the file, passwordHash: not a bcrypt hash');
});
