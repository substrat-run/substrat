import { describe, it, expect } from 'vitest';
import { batchesOf, csvRows, parseImportFile } from '../app/src/user-import-file.js';

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

it('splits into the server’s batch size', () => {
  expect(batchesOf(Array.from({ length: 1001 }, (_, i) => i)).map((b) => b.length)).toEqual([500, 500, 1]);
});
