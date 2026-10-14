import { IMPORT_BATCH_LIMIT, type ImportEntry, type ImportResult } from '../../src/user-import-wire.js';

export type { ImportEntry };

/**
 * A dropped file → the entries `POST /api/admin/users/import` takes (`src/user-import.ts`).
 *
 * Parsed in the browser, so the server keeps exactly one shape and one set of rules: every
 * check that decides what is stored (a bcrypt hash, a valid address, a credential smuggled in
 * as an upstream) still happens there. This only has to turn two everyday exports into that
 * shape, and say which line it could not read.
 *
 *  - **JSON**: the import body itself (`{ users: [...] }`), a bare array of entries, or an
 *    array of such arrays — what the offline converter writes as batches.
 *  - **CSV** with a header row. Columns are matched case-insensitively, under the names an
 *    operator is likely to have in an export:
 *      id | user_id                       → id (kept verbatim: it is the person's `sub`)
 *      email
 *      name
 *      email_verified | emailVerified     → true for 1/true/yes
 *      password_hash | password | passwordHash
 *      created_at | createdAt
 *      github | google | apple | microsoft → an upstream identity, the cell its subject
 *    Unknown columns are ignored and listed, so a misspelt header is visible rather than silent.
 */

export interface ParsedImportFile {
  users: ImportEntry[];
  /** Header names nothing here reads — a CSV only. */
  ignoredColumns: string[];
}

const UPSTREAMS = ['github', 'google', 'apple', 'microsoft'];

const COLUMN: Record<string, keyof ImportEntry | 'upstream'> = {
  id: 'id',
  user_id: 'id',
  userid: 'id',
  email: 'email',
  name: 'name',
  email_verified: 'emailVerified',
  emailverified: 'emailVerified',
  password_hash: 'passwordHash',
  passwordhash: 'passwordHash',
  password: 'passwordHash',
  created_at: 'createdAt',
  createdat: 'createdAt',
  ...Object.fromEntries(UPSTREAMS.map((p) => [p, 'upstream' as const])),
};

export function parseImportFile(fileName: string, text: string): ParsedImportFile {
  const trimmed = text.replace(/^﻿/, '').trim();
  if (!trimmed) throw new Error(`${fileName} is empty`);
  if (/\.json$/i.test(fileName) || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return { users: fromJson(trimmed), ignoredColumns: [] };
  }
  return fromCsv(trimmed);
}

function fromJson(text: string): ImportEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const list =
    data && typeof data === 'object' && !Array.isArray(data) && Array.isArray((data as { users?: unknown }).users)
      ? (data as { users: unknown[] }).users
      : data;
  if (!Array.isArray(list)) throw new Error('expected an array of users, or { "users": [...] }');
  // Batches from the converter: an array of arrays.
  const flat = list.every(Array.isArray) ? (list as unknown[][]).flat() : list;
  return flat as ImportEntry[];
}

/** RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field.trim() === '') {
      // Whitespace before the opening quote is not RFC 4180, but hand-edited exports have it
      // (`id, "Lovelace, Ada"`); without this the comma in the name would split the field.
      quoted = true;
      field = '';
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error('a quoted field is never closed');
  row.push(field);
  rows.push(row);
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function fromCsv(text: string): ParsedImportFile {
  const [header, ...body] = csvRows(text);
  if (!header) throw new Error('no header row');
  const columns = header.map((h) => h.trim());
  const roles = columns.map((h) => COLUMN[h.toLowerCase()]);
  const ignoredColumns = columns.filter((_, i) => roles[i] === undefined);
  if (!roles.includes('id')) throw new Error('no id column (`id` or `user_id`) — it is the person’s sub, and cannot be invented');
  if (!roles.includes('email')) throw new Error('no email column');

  const users = body.map((cells, line) => {
    if (cells.length !== columns.length) {
      throw new Error(`line ${line + 2}: ${cells.length} fields, the header has ${columns.length}`);
    }
    const entry: ImportEntry = { id: '', email: '' };
    const accounts: { providerId: string; accountId: string }[] = [];
    cells.forEach((raw, i) => {
      const value = raw.trim();
      const role = roles[i];
      if (!role || value === '') return;
      if (role === 'upstream') accounts.push({ providerId: columns[i]!.toLowerCase(), accountId: value });
      else if (role === 'emailVerified') entry.emailVerified = /^(1|true|yes)$/i.test(value);
      else if (role === 'createdAt') entry.createdAt = isoOf(value, line + 2);
      else if (role === 'id' || role === 'email' || role === 'name' || role === 'passwordHash') entry[role] = value;
    });
    if (accounts.length) entry.accounts = accounts;
    return entry;
  });
  return { users, ignoredColumns };
}

/**
 * A date, or an epoch of exactly 10 (seconds) or 13 (milliseconds) digits → the ISO 8601 the
 * server parses. The digit count is what tells them apart: `20250102` is a compact date, and
 * reading every number as seconds would put it in August 1970 without a word.
 */
function isoOf(value: string, line: number): string {
  const date = /^\d{10}$/.test(value)
    ? new Date(Number(value) * 1000)
    : /^\d{13}$/.test(value)
      ? new Date(Number(value))
      : /^\d{8}$/.test(value)
        ? new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`)
        : /^\d+$/.test(value)
          ? new Date(Number.NaN)
          : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`line ${line}: created_at '${value}' is not a date`);
  return date.toISOString();
}

/**
 * What the run says about new people whose address arrives unverified (#1359) — empty when
 * there are none. The import still stores them unverified; this only makes an export that
 * dropped the `email_verified` column visible before it locks them out of whatever identifies
 * them by address.
 */
export function unverifiedNotice(result: Pick<ImportResult, 'dryRun' | 'counts' | 'unverified'>): string[] {
  const { created } = result.counts;
  const { unasserted, unverified } = result.unverified;
  const of = (n: number): string => `${n} of the ${created} new ${created === 1 ? 'person' : 'people'}`;
  const lines: string[] = [];
  if (unasserted > 0) {
    lines.push(
      `${of(unasserted)} ${unasserted === 1 ? 'has' : 'have'} no email_verified in the file, so ` +
        `they ${result.dryRun ? 'will be' : 'were'} imported as unverified. ` +
        'A relying party that identifies someone by address (a staff roster, an invite) refuses an unverified one ' +
        'until they verify it. If the old issuer had verified them, add an email_verified column to the export and ' +
        'drop the file again.',
    );
  }
  if (unverified > 0) {
    lines.push(
      `${of(unverified)} ${unverified === 1 ? 'is' : 'are'} marked not verified in the file and ` +
        `${result.dryRun ? 'will be' : 'were'} imported that way.`,
    );
  }
  return lines;
}

/** Split into the server's write batch size (`IMPORT_BATCH_LIMIT`). */
export function batchesOf<T>(items: T[], size = IMPORT_BATCH_LIMIT): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The server names a bad row by its index in the CALL (`users.233.passwordHash: …`). A batch
 * starts mid-file, so that index is rewritten to the person's position in the FILE — person
 * 734, not 234 — before anybody goes looking for it.
 */
export async function inFileRows<T>(offset: number, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(message.replace(/\busers\.(\d+)\./g, (_, n: string) => `person ${offset + Number(n) + 1} in the file, `));
  }
}
