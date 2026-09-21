import { describe, expect, it } from 'vitest';
import { platformRequest } from '@substrat-run/contracts';
import {
  platformRequestOf,
  UNDECODED_REQUESTER,
  ulid,
  type PlatformRequestRawRow,
} from '../src/index.js';

/**
 * The journal's row decoder (#1588), column by column.
 *
 * The adapters are held to the BEHAVIOUR — a list survives its bad row — by the shared
 * contract suite. This holds the decoder to what each column does when it will not decode,
 * which a restored dump can only show a column at a time.
 */
describe('platformRequestOf — tolerant where evidence is read', () => {
  /** A row exactly as `ctx.requestPlatform` and a settle leave it: every JSON column set. */
  const stored = (over: Partial<PlatformRequestRawRow> = {}): PlatformRequestRawRow => ({
    id: ulid(),
    kind: 'connector:test',
    payload: JSON.stringify({ doc: 1 }),
    requested_by: JSON.stringify({ system: 'connector-dispatch' }),
    impersonation: null,
    status: 'failed',
    attempts: 2,
    last_error: 'HTTP 409',
    last_failure: JSON.stringify({ origin: 'provider', code: null, permission: null }),
    result: JSON.stringify({ scopeId: 'MINTED' }),
    requested_at: '2026-09-01T00:00:00.000Z',
    settled_at: '2026-09-01T00:05:00.000Z',
    ...over,
  });

  /** The strict decode this replaced, verbatim — what a healthy row must still read as. */
  const strict = (r: PlatformRequestRawRow) =>
    platformRequest.parse({
      id: r.id,
      kind: r.kind,
      payload: JSON.parse(r.payload),
      requestedBy: JSON.parse(r.requested_by),
      impersonation: r.impersonation == null ? null : JSON.parse(r.impersonation),
      status: r.status,
      attempts: r.attempts,
      lastError: r.last_error,
      failure: r.last_failure == null ? null : JSON.parse(r.last_failure),
      result: r.result === null ? null : JSON.parse(r.result),
      requestedAt: r.requested_at,
      settledAt: r.settled_at,
    });

  it('reads a healthy row exactly as the strict decode did, and carries no decodeError at all', () => {
    const row = stored();
    const decoded = platformRequestOf(row);
    expect(decoded).toStrictEqual(strict(row));
    // ABSENT, not null: a healthy list is byte-for-byte what it was before the field existed.
    expect(decoded).not.toHaveProperty('decodeError');
  });

  it('reads a principal requester and a pending row the same way the strict decode did', () => {
    const row = stored({
      requested_by: JSON.stringify(ulid()),
      status: 'pending',
      last_error: null,
      last_failure: null,
      result: null,
      settled_at: null,
    });
    expect(platformRequestOf(row)).toStrictEqual(strict(row));
  });

  // Each JSON column, with the empty value it falls back to. `requested_by` cannot be null, so
  // its empty is the marker; every other one is null.
  const jsonColumns = [
    ['payload', 'payload', null],
    ['requested_by', 'requestedBy', UNDECODED_REQUESTER],
    ['impersonation', 'impersonation', null],
    ['last_failure', 'failure', null],
    ['result', 'result', null],
  ] as const;

  for (const [column, field, empty] of jsonColumns) {
    it(`an unparseable ${column} comes back empty, named, and the rest of the row intact`, () => {
      const row = stored({ [column]: '{"not json' });
      const decoded = platformRequestOf(row);
      expect(decoded[field]).toEqual(empty);
      expect(decoded.decodeError).toMatch(new RegExp(`^${column}: .*JSON`));
      // Everything that DID decode is still there — the point is not losing the row.
      expect(decoded.id).toBe(row.id);
      expect(decoded.lastError).toBe('HTTP 409');
      expect(decoded.status).toBe('failed');
    });
  }

  it('JSON that parses but is not the contract shape is refused too, with the path it broke at', () => {
    const decoded = platformRequestOf(stored({ last_failure: JSON.stringify({ origin: 'martian' }) }));
    // A null `failure` alone would read as "nobody classified this" — a fact. With the reason
    // beside it, it reads as what it is.
    expect(decoded.failure).toBeNull();
    expect(decoded.decodeError).toMatch(/^last_failure\.origin: /);
  });

  it('an actor that is not an actor becomes the marker, never a guessed principal', () => {
    const decoded = platformRequestOf(stored({ requested_by: JSON.stringify(42) }));
    expect(decoded.requestedBy).toEqual({ system: 'undecodable' });
    expect(decoded.decodeError).toMatch(/^requested_by: /);
  });

  it('keeps a scalar AS STORED when it breaks the contract — the id is the only handle on the row', () => {
    const decoded = platformRequestOf(stored({ id: 'not-a-ulid', status: 'queued' }));
    expect(decoded.id).toBe('not-a-ulid');
    expect(decoded.status).toBe('queued');
    expect(decoded.decodeError).toMatch(/^id: .*; status: /);
    // Scalars kept as stored do not empty the JSON columns beside them.
    expect(decoded.payload).toEqual({ doc: 1 });
  });

  it('names every column that failed, in column order, not only the first one reached', () => {
    const decoded = platformRequestOf(stored({ payload: 'nope', result: '{', settled_at: 'yesterday' }));
    expect(decoded.decodeError?.split('; ').map((part) => part.split(':')[0])).toEqual([
      'payload',
      'result',
      'settled_at',
    ]);
  });
});
