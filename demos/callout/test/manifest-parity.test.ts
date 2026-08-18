/**
 * Does the derived manifest fragment reproduce the hand-written one?
 *
 * The manifest's `permissions` list and `events.emits` are two descriptions of
 * what the operations already declare. This is the check that decides whether
 * they can stop being written by hand — the same question `emit-parity.test.ts`
 * asks of the migration journal.
 */
import { describe, expect, it } from 'vitest';
import { manifestOperations } from '@substrat-run/contracts';
import { calloutManifest } from '../src/manifest.js';
import { calloutOperations } from '../src/operations.js';

const derived = manifestOperations(calloutOperations, {
  permissions: {
    'customer:manage': 'Manage customers and the price list',
    'facility:manage': 'Manage facilities',
  },
});

describe('derived manifest fragment vs the hand-written manifest', () => {
  it('derives the same permission keys the manifest declares', () => {
    expect(derived.permissions.map((p) => p.key).sort()).toEqual(
      calloutManifest.permissions.map((p) => p.key).sort(),
    );
  });

  it('derives the same descriptions', () => {
    expect([...derived.permissions].sort((a, b) => a.key.localeCompare(b.key))).toEqual(
      [...calloutManifest.permissions].sort((a, b) => a.key.localeCompare(b.key)),
    );
  });

  it('derives the same emitted event types', () => {
    expect(derived.events.emits).toEqual(calloutManifest.events.emits);
  });

  // The type already refuses an incomplete map — this proves the RUNTIME check
  // behind it, which is what a JS caller or a non-literal object would hit.
  it('bites: a permission an operation checks but nobody described is an error', () => {
    expect(() =>
      manifestOperations(calloutOperations, {
        // @ts-expect-error deliberately incomplete: 'facility:manage' undescribed
        permissions: { 'customer:manage': 'Manage customers and the price list' },
      }),
    ).toThrow(/no description for permission\(s\) facility:manage/);
  });
});
