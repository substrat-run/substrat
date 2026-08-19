import { z } from 'zod';
import {
  dataSubjectId,
  moduleManifest,
  money,
  permissionKey,
  type EntityRef,
  type Money,
  substratError,
} from '@substrat-run/contracts';

// The entity registry is PUBLIC: a vertical composing this engine needs the
// entity-type constants its relation edges name, and the row schema to declare
// an operation's output against without retyping this engine's shape.
export { bookingEntities, reservationRow, resourceRow } from './entities.js';
import {
  assertAllowed,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';

// ============================================================================
// The reservation engine (docs/engines/booking.md). Owns exactly one
// invariant: concurrent allocations against a resource never exceed its
// capacity over any overlapping interval.
//
// It knows NOTHING about pricing, opening hours, recurrence, cancellation
// windows, skill levels, or timezones — all vertical policy. It takes absolute
// instants and compares them (D-B); it never does calendar arithmetic.
// ============================================================================

export const PERM = {
  create: permissionKey.parse('booking:create'),
  read: permissionKey.parse('booking:read'),
  hold: permissionKey.parse('booking:hold'),
  confirm: permissionKey.parse('booking:confirm'),
  cancel: permissionKey.parse('booking:cancel'),
  move: permissionKey.parse('booking:move'),
  complete: permissionKey.parse('booking:complete'),
  manageResources: permissionKey.parse('booking:manage-resources'),
};

export const bookingManifest = moduleManifest.parse({
  id: '@substrat-run/engine-booking',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'booking:create', description: 'Create reservations' },
    { key: 'booking:read', description: 'Read resources, reservations and availability' },
    { key: 'booking:hold', description: 'Place a tentative hold on a slot' },
    { key: 'booking:confirm', description: 'Confirm a held reservation' },
    { key: 'booking:cancel', description: 'Cancel a reservation or leave one' },
    { key: 'booking:move', description: 'Reschedule a reservation to another slot or resource' },
    { key: 'booking:complete', description: 'Start service, complete, or mark a no-show' },
    { key: 'booking:manage-resources', description: 'Create, edit and deactivate bookable resources' },
  ],
  events: {
    emits: [
      { type: 'booking.held', schemaVersion: 1 },
      { type: 'booking.confirmed', schemaVersion: 1 },
      { type: 'booking.expired', schemaVersion: 1 },
      { type: 'booking.cancelled', schemaVersion: 1 },
      { type: 'booking.moved', schemaVersion: 1 },
      { type: 'booking.started', schemaVersion: 1 },
      { type: 'booking.completed', schemaVersion: 1 },
      { type: 'booking.no-show', schemaVersion: 1 },
      { type: 'booking.participant-joined', schemaVersion: 1 },
      { type: 'booking.participant-left', schemaVersion: 1 },
      { type: 'booking.opened', schemaVersion: 1 },
      { type: 'booking.resource-created', schemaVersion: 1 },
    ],
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [{ entityType: 'reservation', readPermission: 'booking:read' }],
  entityRelations: [{ entityType: 'reservation', parentType: 'resource' }],
  entitlementKey: 'booking',
  ui: {
    routes: [
      { path: 'calendar', screen: './ui/Calendar', permission: 'booking:read' },
      { path: 'reservations/:id', screen: './ui/ReservationDetail', permission: 'booking:read' },
    ],
    nav: [{ label: 'booking.nav', icon: 'calendar', to: 'calendar', permission: 'booking:read' }],
    entityViews: [{ entityType: 'reservation', view: './ui/ReservationCard' }],
  },
});

export const bookingMigrations = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE booking_resources (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        name       TEXT NOT NULL,
        capacity   INTEGER NOT NULL DEFAULT 1 CHECK (capacity >= 1),
        active     INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
      CREATE TABLE booking_reservations (
        id          TEXT PRIMARY KEY,
        resource_id TEXT NOT NULL REFERENCES booking_resources(id),
        starts_at   TEXT NOT NULL,
        ends_at     TEXT NOT NULL,
        state       TEXT NOT NULL CHECK (state IN
                      ('held','confirmed','in_service','completed','expired','cancelled','no_show')),
        quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
        expires_at  TEXT,
        fill_target INTEGER,
        note        TEXT,
        created_by  TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        CHECK (starts_at < ends_at),
        CHECK (state != 'held' OR expires_at IS NOT NULL)
      );
      CREATE INDEX booking_reservations_slot
        ON booking_reservations (resource_id, starts_at, ends_at);
      CREATE TABLE booking_participants (
        id             TEXT PRIMARY KEY,
        reservation_id TEXT NOT NULL REFERENCES booking_reservations(id),
        party_ref      TEXT NOT NULL,
        share_amount   TEXT,
        share_currency TEXT,
        joined_at      TEXT NOT NULL,
        left_at        TEXT
      );
      CREATE INDEX booking_participants_reservation
        ON booking_participants (reservation_id);
    `,
  },
];

// ---------------------------------------------------------------------------
// Instants
// ---------------------------------------------------------------------------

/**
 * Canonicalise to UTC before storing or comparing.
 *
 * This is load-bearing, not hygiene. The overlap check compares instants as
 * **strings** in SQL, and `contracts.instant` permits any offset — so
 * `2026-07-18T19:00:00+02:00` and `2026-07-18T17:00:00Z` are the same moment but
 * sort differently as text. Normalising every instant to `…Z` on the way in makes
 * lexicographic comparison equal chronological comparison, which is the only
 * reason the SQL in `allocatedOver` is correct.
 */
function toInstant(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw substratError('validation_failed', `invalid instant: ${value}`);
  return new Date(ms).toISOString();
}

const instantIn = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'invalid instant' })
  .transform(toInstant);

/** `now` is injectable so hold expiry is testable and replayable; it defaults to wall clock. */
const nowOr = (now?: string): string => (now ? toInstant(now) : new Date().toISOString());

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The typed rejection a vertical surfaces as "that slot was just taken". */
export class SlotUnavailable extends Error {
  readonly code = 'SLOT_UNAVAILABLE';
  constructor(
    readonly resourceId: string,
    readonly startsAt: string,
    readonly endsAt: string,
  ) {
    super(`slot unavailable on resource ${resourceId} for ${startsAt}/${endsAt}`);
    this.name = 'SlotUnavailable';
  }
}

// ---------------------------------------------------------------------------
// Schemas & shapes
// ---------------------------------------------------------------------------

export const reservationState = z.enum([
  'held',
  'confirmed',
  'in_service',
  'completed',
  'expired',
  'cancelled',
  'no_show',
]);
export type ReservationState = z.infer<typeof reservationState>;

/** States that consume capacity. `held` additionally requires an unexpired `expires_at`. */
const LIVE_STATES: ReservationState[] = ['held', 'confirmed', 'in_service'];

export const createResourceInput = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
  capacity: z.number().int().min(1).optional(),
});
export type CreateResourceInput = z.infer<typeof createResourceInput>;

export const holdReservationInput = z.object({
  resourceId: z.string().min(1),
  startsAt: instantIn,
  endsAt: instantIn,
  expiresAt: instantIn,
  quantity: z.number().int().min(1).optional(),
  fillTarget: z.number().int().min(1).optional(),
  note: z.string().optional(),
  now: z.string().optional(),
});
export type HoldReservationInput = z.infer<typeof holdReservationInput>;

export const joinReservationInput = z.object({
  reservationId: z.string().min(1),
  /**
   * The participant, as an opaque **data-subject** id — never a `PrincipalId`.
   * A participant is a person, so this must be shreddable: it keys the erasure
   * of the `participant-joined` / `participant-left` events below.
   */
  partyRef: dataSubjectId,
  share: money.optional(),
  now: z.string().optional(),
});
export type JoinReservationInput = z.infer<typeof joinReservationInput>;

export const moveReservationInput = z.object({
  reservationId: z.string().min(1),
  /** Target resource. Omitted = stay on the current one. */
  resourceId: z.string().min(1).optional(),
  /** New start. Given alone, the booking is *shifted* — its duration is preserved. */
  startsAt: instantIn.optional(),
  /** New end. Given alone, the booking is re-sized from its existing start. */
  endsAt: instantIn.optional(),
  now: z.string().optional(),
});
export type MoveReservationInput = z.infer<typeof moveReservationInput>;

interface ResourceRow {
  id: string;
  kind: string;
  name: string;
  capacity: number;
  active: number;
  created_at: string;
}

interface ReservationRow {
  id: string;
  resource_id: string;
  starts_at: string;
  ends_at: string;
  state: ReservationState;
  quantity: number;
  expires_at: string | null;
  fill_target: number | null;
  note: string | null;
  created_by: string;
  created_at: string;
}

interface ParticipantRow {
  id: string;
  reservation_id: string;
  party_ref: string;
  share_amount: string | null;
  share_currency: string | null;
  joined_at: string;
  left_at: string | null;
}

export interface Resource {
  id: string;
  kind: string;
  name: string;
  capacity: number;
  active: boolean;
  createdAt: string;
}

export interface Participant {
  id: string;
  partyRef: string;
  share: Money | null;
  joinedAt: string;
  leftAt: string | null;
}

export interface Reservation {
  id: string;
  resourceId: string;
  startsAt: string;
  endsAt: string;
  /** The state as stored. A `held` row keeps saying `held` until someone sweeps it. */
  state: ReservationState;
  /**
   * What the row actually means *now* — `expired` once a hold's deadline has passed,
   * whether or not anyone has swept it.
   *
   * Expiry is lazy, so `state` alone would render a dead hold as a live one: the
   * console calendar would show a HELD cell counting down past 0:00 forever. Read
   * paths render this; the transition guards use the stored `state`.
   */
  effectiveState: ReservationState;
  quantity: number;
  expiresAt: string | null;
  fillTarget: number | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export interface FreeInterval {
  startsAt: string;
  endsAt: string;
  available: number;
}

const toResource = (r: ResourceRow): Resource => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  capacity: r.capacity,
  active: r.active === 1,
  createdAt: r.created_at,
});

/** The one definition of "a hold past its deadline is expired". */
export function effectiveStateOf(
  state: ReservationState,
  expiresAt: string | null,
  now: string,
): ReservationState {
  return state === 'held' && expiresAt !== null && expiresAt <= now ? 'expired' : state;
}

/**
 * `now` is REQUIRED, deliberately.
 *
 * It defaulted to `new Date().toISOString()`, so `effectiveState` was computed against
 * wall clock even when the operation had been handed an explicit `now` — the injected
 * clock existed and was silently ignored by every caller that forgot to pass it. That
 * is invisible until real time crosses a boundary the test data assumed, and then it
 * looks like flakiness rather than a bug: this engine's suite began failing hours after
 * it was last green, with nothing changed.
 *
 * Required, the compiler finds every caller. A default here cannot.
 */
const toReservation = (r: ReservationRow, now: string): Reservation => ({
  id: r.id,
  resourceId: r.resource_id,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  state: r.state,
  effectiveState: effectiveStateOf(r.state, r.expires_at, now),
  quantity: r.quantity,
  expiresAt: r.expires_at,
  fillTarget: r.fill_target,
  note: r.note,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

const toParticipant = (r: ParticipantRow): Participant => ({
  id: r.id,
  partyRef: r.party_ref,
  share:
    r.share_amount && r.share_currency
      ? ({ amount: r.share_amount, currency: r.share_currency } as Money)
      : null,
  joinedAt: r.joined_at,
  leftAt: r.left_at,
});

const reservationRef = (id: string): EntityRef => ({ entityType: 'reservation', entityId: id });
const resourceRef = (id: string): EntityRef => ({ entityType: 'resource', entityId: id });

function getResourceRow(ctx: OperationContext, id: string): ResourceRow {
  const row = ctx.sql.query<ResourceRow>('SELECT * FROM booking_resources WHERE id = ?', [id])[0];
  if (!row) throw substratError('not_found', `resource not found: ${id}`);
  return row;
}

function getRow(ctx: OperationContext, id: string): ReservationRow {
  const row = ctx.sql.query<ReservationRow>('SELECT * FROM booking_reservations WHERE id = ?', [
    id,
  ])[0];
  if (!row) throw substratError('not_found', `reservation not found: ${id}`);
  return row;
}

function requireState(row: ReservationRow, ...allowed: ReservationState[]): void {
  if (!allowed.includes(row.state)) {
    throw substratError('conflict', 
      `invalid transition: reservation ${row.id} is '${row.state}', requires ${allowed.join('|')}`,
    );
  }
}

/** Participants who have not left — the count the fill target is measured against. */
function activeParticipants(ctx: OperationContext, reservationId: string): ParticipantRow[] {
  return ctx.sql.query<ParticipantRow>(
    'SELECT * FROM booking_participants WHERE reservation_id = ? AND left_at IS NULL ORDER BY id',
    [reservationId],
  );
}

function allParticipants(ctx: OperationContext, reservationId: string): Participant[] {
  return ctx.sql
    .query<ParticipantRow>(
      'SELECT * FROM booking_participants WHERE reservation_id = ? ORDER BY id',
      [reservationId],
    )
    .map(toParticipant);
}

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

/**
 * How much of `resourceId` is already allocated over `[startsAt, endsAt)`.
 *
 * Intervals are **half-open**: a reservation ending at 19:00 and one starting at
 * 19:00 do not overlap. Expiry is **lazy** — a `held` row past `expires_at` stops
 * counting without anyone sweeping it.
 *
 * There is no lock here, and none is needed: the scope is a single Durable
 * Object, so this read and the write that follows it never interleave with
 * another transaction. That guarantee is why a resource's whole calendar must
 * live in one scope (docs/rfc/booking-social.md §3).
 */
function allocatedOver(
  ctx: OperationContext,
  resourceId: string,
  startsAt: string,
  endsAt: string,
  now: string,
  excludeReservationId?: string,
): number {
  const row = ctx.sql.query<{ allocated: number | null }>(
    `SELECT COALESCE(SUM(quantity), 0) AS allocated
       FROM booking_reservations
      WHERE resource_id = ?
        AND starts_at < ?
        AND ends_at   > ?
        AND ( state IN ('confirmed','in_service')
           OR (state = 'held' AND expires_at > ?) )
        AND id != ?`,
    [resourceId, endsAt, startsAt, now, excludeReservationId ?? ''],
  )[0];
  return row?.allocated ?? 0;
}

// ---------------------------------------------------------------------------
// In-scope functions (K-16) — composable from vertical operations, same
// transaction. The CALLER is responsible for the permission check.
// ---------------------------------------------------------------------------

export function createResource(ctx: OperationContext, rawInput: CreateResourceInput): Resource {
  const input = createResourceInput.parse(rawInput);
  const id = ulid();
  const createdAt = new Date().toISOString();
  ctx.sql.exec(
    `INSERT INTO booking_resources (id, kind, name, capacity, active, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
    [id, input.kind, input.name, input.capacity ?? 1, createdAt],
  );
  ctx.emit({
    type: 'booking.resource-created',
    schemaVersion: 1,
    entity: resourceRef(id),
    piiClass: 'none',
    payload: { resourceId: id, kind: input.kind, name: input.name, capacity: input.capacity ?? 1 },
  });
  return toResource(getResourceRow(ctx, id));
}

export function setResourceActive(
  ctx: OperationContext,
  input: { resourceId: string; active: boolean },
): Resource {
  const row = getResourceRow(ctx, input.resourceId);
  ctx.sql.exec('UPDATE booking_resources SET active = ? WHERE id = ?', [
    input.active ? 1 : 0,
    row.id,
  ]);
  return toResource(getResourceRow(ctx, row.id));
}

export function listResources(ctx: OperationContext, kind?: string): Resource[] {
  const rows = kind
    ? ctx.sql.query<ResourceRow>(
        'SELECT * FROM booking_resources WHERE kind = ? ORDER BY name',
        [kind],
      )
    : ctx.sql.query<ResourceRow>('SELECT * FROM booking_resources ORDER BY name');
  return rows.map(toResource);
}

/**
 * Place a tentative hold. Throws {@link SlotUnavailable} if the interval would
 * overallocate the resource.
 *
 * A hold is never permanent — `expiresAt` is mandatory. The same mechanism serves
 * a payment hold and an open match awaiting players (`fillTarget`).
 */
export function holdReservation(
  ctx: OperationContext,
  rawInput: HoldReservationInput,
): Reservation {
  const input = holdReservationInput.parse(rawInput);
  const now = nowOr(input.now);
  if (input.startsAt >= input.endsAt) {
    throw substratError('validation_failed', `invalid interval: ${input.startsAt} is not before ${input.endsAt}`);
  }
  if (input.expiresAt <= now) {
    throw substratError('validation_failed', `hold would already be expired: ${input.expiresAt} <= ${now}`);
  }

  const resource = getResourceRow(ctx, input.resourceId);
  if (resource.active !== 1) throw substratError('conflict', `resource is inactive: ${resource.id}`);

  const quantity = input.quantity ?? 1;
  const allocated = allocatedOver(ctx, resource.id, input.startsAt, input.endsAt, now);
  if (allocated + quantity > resource.capacity) {
    throw new SlotUnavailable(resource.id, input.startsAt, input.endsAt);
  }

  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO booking_reservations
       (id, resource_id, starts_at, ends_at, state, quantity, expires_at, fill_target,
        note, created_by, created_at)
     VALUES (?, ?, ?, ?, 'held', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      resource.id,
      input.startsAt,
      input.endsAt,
      quantity,
      input.expiresAt,
      input.fillTarget ?? null,
      input.note ?? null,
      ctx.principal,
      now,
    ],
  );
  ctx.link(reservationRef(id), resourceRef(resource.id));
  ctx.emit({
    type: 'booking.held',
    schemaVersion: 1,
    entity: reservationRef(id),
    piiClass: 'none',
    payload: {
      reservationId: id,
      resource: { id: resource.id, kind: resource.kind, name: resource.name },
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      quantity,
      expiresAt: input.expiresAt,
      fillTarget: input.fillTarget ?? null,
    },
  });
  return toReservation(getRow(ctx, id), now);
}

/**
 * held → confirmed. Re-runs the allocation check excluding this reservation,
 * because the hold may have expired and the slot been taken in the meantime.
 */
export function confirmReservation(
  ctx: OperationContext,
  input: { reservationId: string; now?: string },
): Reservation {
  const row = getRow(ctx, input.reservationId);
  requireState(row, 'held');
  const now = nowOr(input.now);
  if (row.expires_at && row.expires_at <= now) {
    throw substratError('conflict', `hold expired at ${row.expires_at}`);
  }

  const resource = getResourceRow(ctx, row.resource_id);
  const allocated = allocatedOver(ctx, row.resource_id, row.starts_at, row.ends_at, now, row.id);
  if (allocated + row.quantity > resource.capacity) {
    throw new SlotUnavailable(row.resource_id, row.starts_at, row.ends_at);
  }

  ctx.sql.exec(
    `UPDATE booking_reservations SET state = 'confirmed', expires_at = NULL WHERE id = ?`,
    [row.id],
  );
  ctx.emit({
    type: 'booking.confirmed',
    schemaVersion: 1,
    entity: reservationRef(row.id),
    piiClass: 'none',
    payload: {
      reservationId: row.id,
      resource: { id: resource.id, kind: resource.kind, name: resource.name },
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      quantity: row.quantity,
      participantCount: activeParticipants(ctx, row.id).length,
    },
  });
  return toReservation(getRow(ctx, row.id), nowOr(input.now));
}

/**
 * Expire a hold whose deadline has passed. Idempotent-ish: only `held` rows move.
 * Because expiry is lazy, calling this is optional for correctness — it exists so
 * a vertical can surface the transition (and its event) to a UI.
 */
export function expireReservation(
  ctx: OperationContext,
  input: { reservationId: string; now?: string },
): Reservation {
  const row = getRow(ctx, input.reservationId);
  requireState(row, 'held');
  const now = nowOr(input.now);
  if (!row.expires_at || row.expires_at > now) {
    throw substratError('conflict', `reservation ${row.id} has not expired yet`);
  }
  ctx.sql.exec(`UPDATE booking_reservations SET state = 'expired' WHERE id = ?`, [row.id]);
  ctx.emit({
    type: 'booking.expired',
    schemaVersion: 1,
    entity: reservationRef(row.id),
    piiClass: 'none',
    payload: {
      reservationId: row.id,
      resourceId: row.resource_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      participantCount: activeParticipants(ctx, row.id).length,
    },
  });
  return toReservation(getRow(ctx, row.id), now);
}

/**
 * Add a participant. When the reservation is `held` and reaching `fillTarget`,
 * this auto-confirms — the open-match mechanic, built out of the payment hold.
 */
export function joinReservation(
  ctx: OperationContext,
  rawInput: JoinReservationInput,
): { participant: Participant; reservation: Reservation } {
  const input = joinReservationInput.parse(rawInput);
  const row = getRow(ctx, input.reservationId);
  requireState(row, 'held', 'confirmed');
  const now = nowOr(input.now);

  const active = activeParticipants(ctx, row.id);
  if (active.some((p) => p.party_ref === input.partyRef)) {
    throw substratError('conflict', `party ${input.partyRef} has already joined ${row.id}`);
  }
  if (row.fill_target !== null && active.length >= row.fill_target) {
    throw substratError('conflict', `reservation ${row.id} is full (${row.fill_target})`);
  }

  const id = ulid();
  ctx.sql.exec(
    `INSERT INTO booking_participants
       (id, reservation_id, party_ref, share_amount, share_currency, joined_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, row.id, input.partyRef, input.share?.amount ?? null, input.share?.currency ?? null, now],
  );
  ctx.emit({
    type: 'booking.participant-joined',
    schemaVersion: 1,
    entity: reservationRef(row.id),
    piiClass: 'pseudonymous',
    subjectId: input.partyRef,
    payload: {
      reservationId: row.id,
      participantId: id,
      partyRef: input.partyRef,
      share: input.share ?? null,
      joined: active.length + 1,
      fillTarget: row.fill_target,
    },
  });

  const participant = ctx.sql
    .query<ParticipantRow>('SELECT * FROM booking_participants WHERE id = ?', [id])
    .map(toParticipant)[0]!;

  const filled = row.fill_target !== null && active.length + 1 >= row.fill_target;
  const reservation =
    filled && row.state === 'held'
      ? confirmReservation(ctx, { reservationId: row.id, now })
      : toReservation(getRow(ctx, row.id), now);

  return { participant, reservation };
}

/** Soft-leave: the row is never deleted, so the record of who was in stays intact. */
/**
 * Open an existing reservation to others, or change how many places are on offer.
 *
 * `fillTarget` is engine state — it drives the auto-confirm in `joinReservation`
 * — so a booking cannot be opened up by a vertical keeping its own counter
 * beside it and hoping the two agree. Additive: reservations made without a
 * target are unaffected, and a target below the people already on it is refused
 * rather than silently stranding someone.
 *
 * Passing `null` closes it again — a private booking with no places on offer.
 */
export function openReservation(
  ctx: OperationContext,
  input: { reservationId: string; fillTarget: number | null; now?: string },
): Reservation {
  const row = getRow(ctx, input.reservationId);
  requireState(row, 'held', 'confirmed');
  const joined = activeParticipants(ctx, row.id).length;
  if (input.fillTarget !== null && input.fillTarget < joined) {
    throw substratError('conflict', 
      `cannot open ${input.fillTarget} places: ${joined} are already on this reservation`,
    );
  }
  ctx.sql.exec('UPDATE booking_reservations SET fill_target = ? WHERE id = ?', [
    input.fillTarget,
    row.id,
  ]);
  ctx.emit({
    type: 'booking.opened',
    schemaVersion: 1,
    entity: reservationRef(row.id),
    piiClass: 'none',
    payload: {
      reservationId: row.id,
      resourceId: row.resource_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      fillTarget: input.fillTarget,
      participantCount: joined,
    },
  });
  return toReservation(getRow(ctx, row.id), nowOr(input.now));
}

export function leaveReservation(
  ctx: OperationContext,
  input: { reservationId: string; participantId: string; now?: string },
): Reservation {
  const row = getRow(ctx, input.reservationId);
  const now = nowOr(input.now);
  const participant = ctx.sql.query<ParticipantRow>(
    'SELECT * FROM booking_participants WHERE id = ? AND reservation_id = ?',
    [input.participantId, row.id],
  )[0];
  if (!participant) throw substratError('not_found', `participant not found: ${input.participantId}`);
  if (participant.left_at) throw substratError('conflict', `participant already left: ${input.participantId}`);

  ctx.sql.exec('UPDATE booking_participants SET left_at = ? WHERE id = ?', [now, participant.id]);
  ctx.emit({
    type: 'booking.participant-left',
    schemaVersion: 1,
    entity: reservationRef(row.id),
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(participant.party_ref),
    payload: {
      reservationId: row.id,
      participantId: participant.id,
      partyRef: participant.party_ref,
      remaining: activeParticipants(ctx, row.id).length,
      fillTarget: row.fill_target,
    },
  });
  return toReservation(getRow(ctx, row.id), now);
}

export function cancelReservation(
  ctx: OperationContext,
  input: { reservationId: string; reason?: string; now?: string },
): Reservation {
  const row = getRow(ctx, input.reservationId);
  requireState(row, 'held', 'confirmed');
  ctx.sql.exec(`UPDATE booking_reservations SET state = 'cancelled' WHERE id = ?`, [row.id]);
  ctx.emit({
    type: 'booking.cancelled',
    schemaVersion: 1,
    entity: reservationRef(row.id),
    piiClass: 'none',
    payload: {
      reservationId: row.id,
      resourceId: row.resource_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      reason: input.reason ?? null,
      participantCount: activeParticipants(ctx, row.id).length,
    },
  });
  return toReservation(getRow(ctx, row.id), nowOr(input.now));
}

/**
 * Reschedule to another slot and/or resource, keeping the reservation's identity
 * and its participants.
 *
 * Deliberately **not** a general `updateReservation`. Engines model named
 * transitions rather than field patches (cf. `engine-workorder`), participants are
 * an append-only log with per-subject events rather than a patchable field (D-C),
 * and `booking.moved` carrying from/to is worth far more to a consumer than a
 * generic diff — event payloads freeze once shipped.
 *
 * This is not cancel-then-rebook: that would lose the identity, the roster, and
 * any payment already attached.
 */
export function moveReservation(
  ctx: OperationContext,
  rawInput: MoveReservationInput,
): Reservation {
  const input = moveReservationInput.parse(rawInput);
  const row = getRow(ctx, input.reservationId);
  requireState(row, 'held', 'confirmed');
  const now = nowOr(input.now);

  const targetResourceId = input.resourceId ?? row.resource_id;
  let startsAt = input.startsAt ?? row.starts_at;
  let endsAt: string;
  if (input.endsAt) {
    endsAt = input.endsAt;
  } else if (input.startsAt) {
    // Shift: preserve the booked duration, which is what dragging a cell means.
    const duration = Date.parse(row.ends_at) - Date.parse(row.starts_at);
    endsAt = new Date(Date.parse(startsAt) + duration).toISOString();
  } else {
    endsAt = row.ends_at;
  }
  if (startsAt >= endsAt) {
    throw substratError('validation_failed', `invalid interval: ${startsAt} is not before ${endsAt}`);
  }

  const target = getResourceRow(ctx, targetResourceId);
  if (target.active !== 1) throw substratError('conflict', `resource is inactive: ${target.id}`);

  // Excluding self is what makes a small nudge (overlapping its own old slot) legal.
  const allocated = allocatedOver(ctx, target.id, startsAt, endsAt, now, row.id);
  if (allocated + row.quantity > target.capacity) {
    throw new SlotUnavailable(target.id, startsAt, endsAt);
  }

  const from = { resourceId: row.resource_id, startsAt: row.starts_at, endsAt: row.ends_at };
  ctx.sql.exec(
    'UPDATE booking_reservations SET resource_id = ?, starts_at = ?, ends_at = ? WHERE id = ?',
    [target.id, startsAt, endsAt, row.id],
  );
  ctx.emit({
    type: 'booking.moved',
    schemaVersion: 1,
    entity: reservationRef(row.id),
    piiClass: 'none',
    payload: {
      reservationId: row.id,
      from,
      to: { resourceId: target.id, startsAt, endsAt },
      resource: { id: target.id, kind: target.kind, name: target.name },
      participantCount: activeParticipants(ctx, row.id).length,
    },
  });
  return toReservation(getRow(ctx, row.id), nowOr(input.now));
}

export function startReservation(
  ctx: OperationContext,
  input: { reservationId: string; now?: string },
): Reservation {
  const row = getRow(ctx, input.reservationId);
  requireState(row, 'confirmed');
  ctx.sql.exec(`UPDATE booking_reservations SET state = 'in_service' WHERE id = ?`, [row.id]);
  ctx.emit({
    type: 'booking.started',
    schemaVersion: 1,
    entity: reservationRef(row.id),
    piiClass: 'none',
    payload: { reservationId: row.id, resourceId: row.resource_id },
  });
  return toReservation(getRow(ctx, row.id), nowOr(input.now));
}

/**
 * The terminal success transition. The payload is deliberately **fat** — resource,
 * interval and the full participant list — so an invoicing consumer can raise split
 * charges and an out-of-kernel consumer can build cross-club history, neither
 * needing a cross-module read.
 */
export function completeReservation(
  ctx: OperationContext,
  input: { reservationId: string; now?: string },
): Reservation {
  const row = getRow(ctx, input.reservationId);
  requireState(row, 'confirmed', 'in_service');
  const resource = getResourceRow(ctx, row.resource_id);
  ctx.sql.exec(`UPDATE booking_reservations SET state = 'completed' WHERE id = ?`, [row.id]);
  ctx.emit({
    type: 'booking.completed',
    schemaVersion: 1,
    entity: reservationRef(row.id),
    piiClass: 'none',
    payload: {
      reservationId: row.id,
      resource: { id: resource.id, kind: resource.kind, name: resource.name },
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      quantity: row.quantity,
      participantCount: activeParticipants(ctx, row.id).length,
    },
  });
  return toReservation(getRow(ctx, row.id), nowOr(input.now));
}

export function markNoShow(
  ctx: OperationContext,
  input: { reservationId: string; now?: string },
): Reservation {
  const row = getRow(ctx, input.reservationId);
  requireState(row, 'confirmed', 'in_service');
  ctx.sql.exec(`UPDATE booking_reservations SET state = 'no_show' WHERE id = ?`, [row.id]);
  ctx.emit({
    type: 'booking.no-show',
    schemaVersion: 1,
    entity: reservationRef(row.id),
    piiClass: 'none',
    payload: {
      reservationId: row.id,
      resourceId: row.resource_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      participantCount: activeParticipants(ctx, row.id).length,
    },
  });
  return toReservation(getRow(ctx, row.id), nowOr(input.now));
}

export function getReservation(
  ctx: OperationContext,
  reservationId: string,
  now?: string,
): { reservation: Reservation; participants: Participant[] } {
  return {
    reservation: toReservation(getRow(ctx, reservationId), nowOr(now)),
    participants: allParticipants(ctx, reservationId),
  };
}

export function listReservations(
  ctx: OperationContext,
  input: { resourceId?: string; from?: string; to?: string; now?: string },
): Reservation[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (input.resourceId) {
    clauses.push('resource_id = ?');
    params.push(input.resourceId);
  }
  if (input.to) {
    clauses.push('starts_at < ?');
    params.push(toInstant(input.to));
  }
  if (input.from) {
    clauses.push('ends_at > ?');
    params.push(toInstant(input.from));
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const now = nowOr(input.now);
  return ctx.sql
    .query<ReservationRow>(
      `SELECT * FROM booking_reservations${where} ORDER BY starts_at, id`,
      params,
    )
    .map((r) => toReservation(r, now));
}

/**
 * Free capacity over `[from, to)`, as merged intervals.
 *
 * Returns raw gaps between reservations — it knows nothing of opening hours and
 * will happily report 03:00 as free. Intersecting with the venue's bookable
 * window is the **vertical's** job (docs/engines/booking.md §4.1).
 *
 * Implemented as a sweep over interval boundaries rather than a simple gap walk,
 * because capacity may exceed 1 (fungible pools), where "free" is a number and not
 * a boolean.
 */
export function availability(
  ctx: OperationContext,
  input: { resourceId: string; from: string; to: string; now?: string },
): FreeInterval[] {
  const from = toInstant(input.from);
  const to = toInstant(input.to);
  if (from >= to) return [];
  const now = nowOr(input.now);
  const resource = getResourceRow(ctx, input.resourceId);
  if (resource.active !== 1) return [];

  const live = ctx.sql.query<ReservationRow>(
    `SELECT * FROM booking_reservations
      WHERE resource_id = ?
        AND starts_at < ? AND ends_at > ?
        AND ( state IN ('confirmed','in_service')
           OR (state = 'held' AND expires_at > ?) )`,
    [resource.id, to, from, now],
  );

  const edges = new Set<string>([from, to]);
  for (const r of live) {
    if (r.starts_at > from && r.starts_at < to) edges.add(r.starts_at);
    if (r.ends_at > from && r.ends_at < to) edges.add(r.ends_at);
  }
  const points = [...edges].sort();

  const segments: FreeInterval[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const segStart = points[i]!;
    const segEnd = points[i + 1]!;
    const allocated = live
      .filter((r) => r.starts_at < segEnd && r.ends_at > segStart)
      .reduce((sum, r) => sum + r.quantity, 0);
    const free = resource.capacity - allocated;
    if (free <= 0) continue;
    const prev = segments[segments.length - 1];
    if (prev && prev.endsAt === segStart && prev.available === free) {
      prev.endsAt = segEnd; // merge adjacent equal-availability segments
    } else {
      segments.push({ startsAt: segStart, endsAt: segEnd, available: free });
    }
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Default operation bindings — each starts with the permission check.
// ---------------------------------------------------------------------------

const createResourceOp: OperationHandler<CreateResourceInput, Resource> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.manageResources));
  return createResource(ctx, input);
};

const setResourceActiveOp: OperationHandler<
  { resourceId: string; active: boolean },
  Resource
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.manageResources));
  return setResourceActive(ctx, input);
};

const listResourcesOp: OperationHandler<{ kind?: string } | undefined, Resource[]> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(PERM.read));
  return listResources(ctx, input?.kind);
};

const holdOp: OperationHandler<HoldReservationInput, Reservation> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.hold));
  return holdReservation(ctx, input);
};

const confirmOp: OperationHandler<{ reservationId: string; now?: string }, Reservation> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(PERM.confirm, reservationRef(input.reservationId)));
  return confirmReservation(ctx, input);
};

const expireOp: OperationHandler<{ reservationId: string; now?: string }, Reservation> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(PERM.confirm));
  return expireReservation(ctx, input);
};

const joinOp: OperationHandler<
  JoinReservationInput,
  { participant: Participant; reservation: Reservation }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.create, reservationRef(input.reservationId)));
  return joinReservation(ctx, input);
};

const leaveOp: OperationHandler<
  { reservationId: string; participantId: string; now?: string },
  Reservation
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.cancel, reservationRef(input.reservationId)));
  return leaveReservation(ctx, input);
};

const cancelOp: OperationHandler<{ reservationId: string; reason?: string }, Reservation> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(PERM.cancel, reservationRef(input.reservationId)));
  return cancelReservation(ctx, input);
};

const moveOp: OperationHandler<MoveReservationInput, Reservation> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.move, reservationRef(input.reservationId)));
  return moveReservation(ctx, input);
};

const openOp: OperationHandler<
  { reservationId: string; fillTarget: number | null; now?: string },
  Reservation
> = async (ctx, input) => {
  // Whoever may confirm a reservation may decide whether it is on offer.
  assertAllowed(await ctx.check(PERM.confirm, reservationRef(input.reservationId)));
  return openReservation(ctx, input);
};

const startOp: OperationHandler<{ reservationId: string }, Reservation> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.complete));
  return startReservation(ctx, input);
};

const completeOp: OperationHandler<{ reservationId: string }, Reservation> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.complete));
  return completeReservation(ctx, input);
};

const noShowOp: OperationHandler<{ reservationId: string }, Reservation> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.complete));
  return markNoShow(ctx, input);
};

const getOp: OperationHandler<
  { reservationId: string; now?: string },
  { reservation: Reservation; participants: Participant[] }
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.read, reservationRef(input.reservationId)));
  return getReservation(ctx, input.reservationId, input.now);
};

const listOp: OperationHandler<
  { resourceId?: string; from?: string; to?: string; now?: string } | undefined,
  Reservation[]
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.read));
  return listReservations(ctx, input ?? {});
};

const availabilityOp: OperationHandler<
  { resourceId: string; from: string; to: string; now?: string },
  FreeInterval[]
> = async (ctx, input) => {
  assertAllowed(await ctx.check(PERM.read));
  return availability(ctx, input);
};

export const bookingModule: ModuleRegistration = {
  manifest: bookingManifest,
  migrations: bookingMigrations,
  operations: {
    'booking/create-resource': createResourceOp as OperationHandler<never, unknown>,
    'booking/set-resource-active': setResourceActiveOp as OperationHandler<never, unknown>,
    'booking/list-resources': listResourcesOp as OperationHandler<never, unknown>,
    'booking/hold': holdOp as OperationHandler<never, unknown>,
    'booking/confirm': confirmOp as OperationHandler<never, unknown>,
    'booking/expire': expireOp as OperationHandler<never, unknown>,
    'booking/join': joinOp as OperationHandler<never, unknown>,
    'booking/leave': leaveOp as OperationHandler<never, unknown>,
    'booking/cancel': cancelOp as OperationHandler<never, unknown>,
    'booking/move': moveOp as OperationHandler<never, unknown>,
    'booking/open': openOp as OperationHandler<never, unknown>,
    'booking/start': startOp as OperationHandler<never, unknown>,
    'booking/complete': completeOp as OperationHandler<never, unknown>,
    'booking/no-show': noShowOp as OperationHandler<never, unknown>,
    'booking/get': getOp as OperationHandler<never, unknown>,
    'booking/list': listOp as OperationHandler<never, unknown>,
    'booking/availability': availabilityOp as OperationHandler<never, unknown>,
  },
};
