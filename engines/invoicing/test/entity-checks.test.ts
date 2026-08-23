/**
 * This engine declares NO entity check, and that is the assessment, not an omission.
 *
 * #865 found the conformance kit adopted by three of fourteen packages and made
 * the point that eleven packages with zero narrowed declarations are
 * indistinguishable from eleven packages nobody looked at. Absence reading as
 * coverage is the failure mode; so where the answer really is "node-only", it
 * gets written down somewhere that can go red.
 *
 * ## Why node-only is right here
 *
 * Invoicing is composed BY EVENT (CLAUDE.md): the vertical emits, the engine
 * consumes, and the engine is the only writer of its rows. It deliberately
 * exports no in-scope functions, and its three operations — `list`, `get`,
 * `export` — are office reads and an office action over the scope's own invoice
 * bases. There is no per-recipient view of an underlag to narrow to, and no
 * caller who should hold `invoicing:read` for one basis and not another. A
 * portal customer sees work orders, not invoice bases.
 *
 * If that ever stops being true — a customer-visible basis, an accountant
 * granted one export — the operation gains a narrowed declaration, this file
 * goes red, and whoever made the change wires the real suite instead. That is
 * the whole job of the assertion below.
 */
import { describe, expect, it } from 'vitest';
import { planEntityCheckCoverage } from '@substrat-run/contract-tests';
import { invoicingOperations } from '../src/operations.js';

describe('entity checks: engine-invoicing declares none, deliberately', () => {
  it('has no operation narrowing to an entity, so there is no pair to generate', () => {
    const { covered, uncovered } = planEntityCheckCoverage(invoicingOperations);
    expect({ covered: covered.map((c) => c.name), uncovered }).toEqual({
      covered: [],
      uncovered: {},
    });
  });

  it('still checks a permission on every operation — node-only is not un-gated', () => {
    // The other way this could read as coverage: an operation with no check at
    // all would also produce an empty plan above.
    const ungated = Object.entries(invoicingOperations)
      .filter(([, op]) => !('permission' in op) && !('narrows' in op))
      .map(([name]) => name);
    expect(ungated).toEqual([]);
  });
});
