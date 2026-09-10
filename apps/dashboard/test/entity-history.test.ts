import { describe, expect, it } from 'vitest';
import type { EmittedEntity, HistoryEntry } from '@substrat-run/contracts';
import {
  actorLabel,
  authorizationLabel,
  impersonationLabel,
  operationLabel,
  payloadText,
  timelineTargets,
} from '../web/src/lib/history.js';

/**
 * How a record's history reads (#1235). Every case here is one the first cut got
 * wrong or silently dropped, and every one of them is a value the CONTRACT says is
 * possible — a union member, or a null that is a fact. The screen is the only
 * place these are ever read by a person, so "renders as something true" is the
 * property worth pinning.
 */

/** Permission keys are branded; a test writing one still writes a string. */
type Authorization = NonNullable<HistoryEntry['authorization']>;
const auth = (...keys: string[]): Authorization => keys.map((permission) => ({ permission })) as Authorization;
const granted = (permission: string, grant: string): Authorization => [{ permission, grant }] as Authorization;

const entry = (over: Partial<HistoryEntry>): HistoryEntry =>
  ({
    id: '01J0000000000000000000000A',
    type: 'workorder.completed',
    occurredAt: '2026-09-10T09:00:00.000Z',
    actor: 'prin_01J000000000000000000000',
    payload: { status: 'done' },
    authorization: [{ permission: 'workorder:complete' }],
    impersonation: null,
    piiClass: 'none',
    subjectId: null,
    operation: 'workorder/complete',
    version: null,
    ...over,
  }) as HistoryEntry;

describe('actorLabel', () => {
  it('names a principal as itself', () => {
    expect(actorLabel('prin_01J000000000000000000000' as HistoryEntry['actor'])).toBe(
      'prin_01J000000000000000000000',
    );
  });

  // The crash. `{ system }` and `{ connection }` are objects, and React throws
  // "Objects are not valid as a React child" on one — with no error boundary in the
  // dashboard, that unmounts the whole SPA. A consumer-emitted event is ordinary,
  // not exotic: the view's own copy says so.
  it('names a consumer-emitted event as the system, never as [object Object]', () => {
    const label = actorLabel({ system: 'invoicing' } as HistoryEntry['actor']);
    expect(label).toBe('system · invoicing');
    expect(label).not.toContain('object');
  });

  it('names a connector as the connection, so it cannot read as a person', () => {
    expect(actorLabel({ connection: 'scrive-prod' } as HistoryEntry['actor'])).toBe('connector · scrive-prod');
  });
});

describe('impersonationLabel', () => {
  // #1004: the stamp is captured everywhere and surfaced nowhere a human reads.
  // Reading the wrong field surfaces it as a blank, which is the same as not
  // surfacing it — a customer's own name against their support engineer's change.
  it('names the platform actor behind the principal', () => {
    const label = impersonationLabel(
      entry({
        actor: 'prin_01J000000000000000000000' as HistoryEntry['actor'],
        impersonation: { session: 'imp_01J0000000000000000000AA', by: 'staff_anna' },
      } as Partial<HistoryEntry>),
    );
    expect(label).toBe('as prin_01J000000000000000000000 · by staff_anna');
    expect(label).not.toContain('undefined');
  });

  it('shows nothing when nobody was impersonating — the ordinary case, not an absence', () => {
    expect(impersonationLabel(entry({ impersonation: null }))).toBeNull();
  });
});

describe('authorizationLabel', () => {
  // The three answers stay three. Collapsing the first two is exactly what the
  // nullable column exists to prevent (K-34).
  it('tells unrecorded from checked-nothing from checked-something', () => {
    expect(authorizationLabel(null)).toBe('authorization unrecorded');
    expect(authorizationLabel([])).toBe('no permission checked');
    expect(authorizationLabel(auth('workorder:complete'))).toBe('workorder:complete');
    expect(authorizationLabel(auth('a:b', 'c:d'))).toBe('a:b, c:d');
  });

  // #1398. `grant` is present exactly when the allow came through a `granted:<perm>`
  // tuple, and it names WHICH grant. Dropped, "somebody shared this one record with
  // me" and "I hold the role" render identically — on the screen whose pitch is
  // "under what authority".
  it('names which grant authorized a check, so a share does not read as a role', () => {
    const shared = authorizationLabel(granted('list:read', 'list:01J0000000000000000000000B'));
    expect(shared).toBe('list:read via grant list:01J0000000000000000000000B');
    expect(shared).not.toBe(authorizationLabel(auth('list:read')));
  });

  // Absence is not missing data — it already means "by a role" — so that case's
  // wording is unchanged and must stay free of grant vocabulary.
  it('says nothing about a grant when a role is what allowed it', () => {
    expect(authorizationLabel(auth('list:read'))).toBe('list:read');
  });

  it('keeps the two apart entry by entry, not per label', () => {
    const mixed = [{ permission: 'a:b' }, { permission: 'c:d', grant: 'c:01J0000000000000000000000C' }] as Authorization;
    expect(authorizationLabel(mixed)).toBe('a:b, c:d via grant c:01J0000000000000000000000C');
  });
});

/**
 * The way INTO a record's story (#1398). The first cut keyed the affordance off a
 * column literally named `id`, so an entity keyed on anything else silently had no
 * way into its own history — while the model declares `primaryKey` in the very map
 * the table→entity mapping is read from.
 */
describe('timelineTargets', () => {
  const entity = (over: Partial<EmittedEntity> & { table: string }): EmittedEntity =>
    ({ fields: {}, ...over }) as EmittedEntity;

  // An emitted model omits `primaryKey` exactly when it is the `['id']` default, so
  // absence resolves rather than disqualifies — every id-keyed table keeps working.
  it('resolves an omitted primaryKey to id, which is what the omission means', () => {
    expect(timelineTargets({ item: entity({ table: 'todo_item' }) })).toEqual({
      todo_item: { entityType: 'item', idColumn: 'id' },
    });
  });

  // The bug. A side table keyed by an engine's id has a history like any other
  // record, and got no link because its key column is not spelled `id`.
  it('opens on the declared key column, whatever it is called', () => {
    expect(timelineTargets({ extra: entity({ table: 'wo_extra', primaryKey: ['workorder_id'] }) })).toEqual({
      wo_extra: { entityType: 'extra', idColumn: 'workorder_id' },
    });
  });

  // A history read addresses one EntityRef, so a multi-column identity has no single
  // cell that names the record — the same fact `PointableName` encodes in the types.
  // A missing link is the better failure; a link that answers "nothing ever happened"
  // about a record with a history is the worse one.
  it('offers nothing for a composite key rather than a cell that cannot name the row', () => {
    expect(
      timelineTargets({ day: entity({ table: 'tock_field_history', primaryKey: ['source_key', 'field', 'day'] }) }),
    ).toEqual({});
  });

  // An empty array is not a declaration; `primaryKeyOf` falls through it to `id` and
  // so does this, or a table whose model says nothing loses a link it should keep.
  it('reads an empty primaryKey as no declaration, not as a keyless table', () => {
    expect(timelineTargets({ item: entity({ table: 'todo_item', primaryKey: [] }) })).toEqual({
      todo_item: { entityType: 'item', idColumn: 'id' },
    });
  });

  it('skips an entity the model gives no table — nothing to browse, nothing to open', () => {
    expect(timelineTargets({ ghost: { fields: {} } as unknown as EmittedEntity })).toEqual({});
  });
});

describe('payloadText', () => {
  it('says an erased payload is erased — a shred keeps the row and drops the content', () => {
    expect(payloadText(null)).toBe('payload erased');
  });

  it('renders what the event said', () => {
    expect(payloadText({ status: 'done' })).toBe('{"status":"done"}');
  });

  // A payload that is legitimately empty is not an erasure, and must not read as one.
  it('tells an empty payload from a missing one', () => {
    expect(payloadText({})).toBe('{}');
  });
});

describe('operationLabel', () => {
  it('names the emitting operation', () => {
    expect(operationLabel('workorder/complete')).toBe('workorder/complete');
  });

  // This null carries both meanings and the spine cannot separate them, so the
  // copy must not pick one.
  it('does not guess which meaning a null carries', () => {
    expect(operationLabel(null)).toBe('no operation — a consumer, or unrecorded');
  });
});
