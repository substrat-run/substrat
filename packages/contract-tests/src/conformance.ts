/**
 * What a package CLAIMS about its entity checks, in one importable object (#866).
 *
 * The conformance kit next door proves a handler honours the check its operation
 * declared. That proof runs inside vitest and vanishes with the process. The
 * trust page kernel-design §11.2 committed to — *"the §10 table above, run
 * adversarially; results published"* — needs the same facts at emit time, and a
 * tool cannot import a test file: its top-level `describe` throws outside a
 * runner.
 *
 * So the claim moves out of the test and into `test/conformance.ts`, which the
 * test file and `tools/conformance-emit.mts` both import. That is the whole
 * design, and the reason for it is the one PERMISSIONS.md is built on: an
 * artifact rendered from a SECOND copy of the facts is an artifact that can
 * disagree with what runs. Here it cannot — `planEntityCheckCoverage` is handed
 * the same `inputs` and `refEntityType` the suite is driven with, so the
 * covered/uncovered partition in `CONFORMANCE.md` is the partition the suite
 * asserts, by construction.
 *
 * ## Three kinds, because there are three strengths of evidence
 *
 * A report that renders all three as "assessed" would be the overclaim this
 * whole thread exists to avoid. They are not equal:
 *
 *  - `driven` — the operation set is declared AND the pair runs against the
 *    handler. A wrong implementation fails. This is evidence.
 *  - `declared` — the operation set is declared and its plan is empty: nothing
 *    narrows, and the declaration is what says so. Nothing is driven because
 *    there is nothing to drive, and the day an operation narrows, the plan stops
 *    being empty and the assertion goes red.
 *  - `asserted` — there is no declared operation set, so the claim is a lexical
 *    tripwire over the module's own source (`nodeOnlySuite`). It proves an
 *    absence on the obvious path and nothing more. Weakest of the three, and the
 *    report says so rather than letting a reader assume otherwise.
 *
 * The kind is stamped by the helper rather than written by the caller: a package
 * cannot label itself `driven` without handing over an operation registry.
 */
import type { EntityCheckSuiteOptions } from './entity-check-plan.js';

/** Common to all three: who is claiming, and the prose a reviewer reads. */
interface ConformanceBase {
  /** The name the suite registers under — `'meridian'`, `'engine-booking'`. */
  readonly subject: string;
  /**
   * Why this claim is the right one, in the author's own words.
   *
   * Required on the two node-only kinds and optional on `driven`, for the same
   * reason `alsoGrant.because` is required: an assessment with no reasoning is
   * indistinguishable from nobody having thought about it. The emitter prints it
   * verbatim, so it is written for a reader outside the repo.
   */
  readonly because?: string;
}

/** A package whose declared entity checks are driven by the conformance kit. */
export interface DrivenConformance extends ConformanceBase, EntityCheckSuiteOptions {
  readonly kind: 'driven';
  /** The declared operation set — the same object the suite and the host read. */
  readonly operations: Readonly<Record<string, object>>;
}

/** A package with a declared operation set that narrows nowhere. */
export interface DeclaredNodeOnlyConformance extends ConformanceBase {
  readonly kind: 'declared';
  readonly operations: Readonly<Record<string, object>>;
  readonly because: string;
}

/** A package with no declared operation set, claiming node-only lexically. */
export interface AssertedNodeOnlyConformance extends ConformanceBase {
  readonly kind: 'asserted';
  /** Absolute paths to the module source the claim covers. */
  readonly sources: readonly string[];
  readonly because: string;
}

export type ConformanceDeclaration =
  | DrivenConformance
  | DeclaredNodeOnlyConformance
  | AssertedNodeOnlyConformance;

/**
 * Declare a driven surface. The result IS an `EntityCheckSuiteOptions`, so the
 * test passes this same object straight through as the suite's options — there
 * is no second place for `inputs` or `uncovered` to live and drift.
 */
export function declareEntityChecks(
  d: Omit<DrivenConformance, 'kind'>,
): DrivenConformance {
  return { ...d, kind: 'driven' };
}

/** Declare a node-only surface whose emptiness the DECLARATION establishes. */
export function declareNodeOnly(
  d: Omit<DeclaredNodeOnlyConformance, 'kind'>,
): DeclaredNodeOnlyConformance {
  return { ...d, kind: 'declared' };
}

/** Declare a node-only surface established only by a tripwire over source. */
export function assertNodeOnly(
  d: Omit<AssertedNodeOnlyConformance, 'kind'>,
): AssertedNodeOnlyConformance {
  return { ...d, kind: 'asserted' };
}
