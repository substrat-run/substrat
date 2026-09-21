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

  it('a nullable scalar that breaks the contract comes back null, named — not as stored', () => {
    const decoded = platformRequestOf(
      stored({ last_error: 42 as unknown as string, settled_at: 'yesterday' }),
    );
    expect(decoded.lastError).toBeNull();
    expect(decoded.settledAt).toBeNull();
    expect(decoded.decodeError).toMatch(/^last_error: .*; settled_at: /);
  });

  /**
   * The type does not lie (#1634 review). `PlatformRequest` is the published schema's output,
   * so everything this decoder hands back — tolerated or not — must be something that schema
   * accepts. Parsed rather than asserted field by field, so a future fallback that slips a
   * refused value through is caught without anyone remembering to add its line here.
   */
  it('every row it returns satisfies the published schema, however broken the row it read', () => {
    const broken: Partial<PlatformRequestRawRow>[] = [
      { payload: '{"not json' },
      { requested_by: JSON.stringify(42) },
      { requested_by: '{' },
      { impersonation: JSON.stringify({ nope: true }) },
      { last_failure: JSON.stringify({ origin: 'martian' }) },
      { result: '{' },
      { last_error: 7 as unknown as string },
      { settled_at: 'yesterday' },
      { payload: 'x', requested_by: 'y', impersonation: 'z', last_failure: 'w', result: 'v', settled_at: 'u' },
    ];
    for (const over of broken) {
      const decoded = platformRequestOf(stored(over));
      expect(decoded.decodeError).toBeDefined();
      expect(() => platformRequest.parse(decoded)).not.toThrow();
    }
  });

  it('a row whose REQUIRED scalars break the contract is never returned as a PlatformRequest', () => {
    // id, kind, status, attempts and requested_at have no empty value, so the only honest
    // answers are a different type or a refusal — never `id: "not-a-ulid"` typed as a branded id.
    const read = () => platformRequestOf(stored({ id: 'not-a-ulid', status: 'queued', payload: 'nope' }));
    expect(read).toThrow(/platform request row "not-a-ulid" cannot be read as a PlatformRequest/);
    // Every column it broke is named, required ones first — including the JSON column beside them.
    expect(read).toThrow(/id: .*; status: .*; payload: /);
    for (const over of [{ kind: '' }, { attempts: -1 }, { requested_at: 'yesterday' }]) {
      expect(() => platformRequestOf(stored(over))).toThrow(/cannot be read as a PlatformRequest/);
    }
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
