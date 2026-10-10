/**
 * The kernel's published value surface, pinned (#1978). Most of the index once grew by
 * accretion: 140 of its value exports had no importer outside the kernel, and each was a
 * promise the additive-only rule froze. This holds the index to a checked-in list, so a new
 * export appears in the PR that adds it, beside a reason.
 */
import { describe, expect, it } from 'vitest';
import * as kernel from '../src/index.js';
import { INDEX_VALUE_EXPORTS } from './index-surface.js';

const WIDENED =
  "widening the kernel's surface is a deliberate act: update the snapshot in this PR and say why";
const NARROWED =
  "narrowing the kernel's surface is a breaking change: update the snapshot in this PR and say why";

describe("the kernel index's value exports (#1978)", () => {
  const actual = Object.keys(kernel).sort();
  const pinned: readonly string[] = INDEX_VALUE_EXPORTS;

  it('adds nothing the snapshot does not list', () => {
    expect(actual.filter((name) => !pinned.includes(name)), WIDENED).toEqual([]);
  });

  it('drops nothing the snapshot lists', () => {
    expect(pinned.filter((name) => !actual.includes(name)), NARROWED).toEqual([]);
  });

  it('keeps the snapshot sorted and free of repeats, so its diff reads as a list', () => {
    expect([...new Set(pinned)].sort()).toEqual(pinned);
  });
});
