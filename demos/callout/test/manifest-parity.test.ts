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
  // `callout/timeline` enforces the work order engine's key. The engine declares
  // it and describes it; Callout only checks it, so it stays out of Callout's own
  // permission list and parity below is unaffected. Before #865 there was no way
  // to say this, and the operation declared `customer:manage` instead — a key it
  // does not check, on an operation a technician could always reach.
  checksDeclaredElsewhere: { 'workorder:read': '@substrat-run/engine-workorder' },
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
        checksDeclaredElsewhere: { 'workorder:read': '@substrat-run/engine-workorder' },
      }),
    ).toThrow(/no description for permission\(s\) facility:manage/);
  });

  // An engine key is exempted by NAME, so the exemption has to keep being true.
  it('bites: an exemption for a key no operation checks is an error', () => {
    expect(() =>
      manifestOperations(calloutOperations, {
        permissions: {
          'customer:manage': 'Manage customers and the price list',
          'facility:manage': 'Manage facilities',
        },
        checksDeclaredElsewhere: {
          'workorder:read': '@substrat-run/engine-workorder',
          'workorder:close': '@substrat-run/engine-workorder',
        },
      }),
    ).toThrow(/names permission\(s\) no operation checks: workorder:close/);
  });

  // And a key cannot be owned twice: describing it here while calling it
  // someone else's is the drift this parameter exists to prevent.
  it('bites: a key both described here and declared elsewhere is an error', () => {
    expect(() =>
      manifestOperations(calloutOperations, {
        permissions: {
          'customer:manage': 'Manage customers and the price list',
          'facility:manage': 'Manage facilities',
          'workorder:read': 'Read work orders, time and material',
        },
        checksDeclaredElsewhere: { 'workorder:read': '@substrat-run/engine-workorder' },
      }),
    ).toThrow(/described here AND declared elsewhere/);
  });
});
