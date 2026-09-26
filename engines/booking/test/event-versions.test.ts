/**
 * #1597 — one home for each event's `schemaVersion`.
 *
 * `bookingEventVersions` is what `emitBookingEvent` stamps and what the manifest's
 * `emits` is read from. The pinned list below is the manifest as it shipped
 * before that move: a version bumped by accident (or a type dropped) fails here
 * instead of quietly changing what a deployed consumer parses.
 */
import { describe, expect, it } from 'vitest';
import type { OperationContext } from '@substrat-run/kernel';
import { bookingEventVersions, emitBookingEvent, type BookingEventType } from '../src/events.js';
import { bookingManifest } from '../src/index.js';

const SHIPPED = [
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
];

describe('booking: event schemaVersion has one home', () => {
  it('the manifest emits exactly what shipped, in the same order', () => {
    expect(bookingManifest.events.emits).toEqual(SHIPPED);
  });

  it('every emission carries the version the manifest declares for its type', () => {
    const seen: { type: string; schemaVersion: number }[] = [];
    const ctx = { emit: (e: { type: string; schemaVersion: number }) => seen.push(e) } as unknown as OperationContext;
    for (const type of Object.keys(bookingEventVersions) as BookingEventType[]) {
      // The payload is irrelevant to the stamp; the cast is this test's, not the engine's.
      emitBookingEvent(ctx, { type, entity: { entityType: 'x', entityId: 'y' }, piiClass: 'none', payload: {} } as never);
    }
    expect(seen.map((e) => ({ type: e.type, schemaVersion: e.schemaVersion }))).toEqual(
      bookingManifest.events.emits.map((d) => ({ type: d.type, schemaVersion: d.schemaVersion })),
    );
  });
});
