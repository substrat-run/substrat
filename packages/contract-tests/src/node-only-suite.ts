/**
 * "This module narrows nowhere" — stated so it can stop being true loudly (#865).
 *
 * The conformance kit next door reads an operation's DECLARATION and drives the
 * pair that proves the handler honours it. Seven packages in this repo have no
 * declared operation surface for it to read: their operations are a map of
 * handlers, and the only description of what each one checks is the handler
 * itself. Building that surface is real work and is filed separately.
 *
 * Meanwhile those packages carry the failure mode #865 named — **absence reading
 * as coverage**. Zero narrowed declarations is indistinguishable from nobody
 * having looked, and the packages where nobody looked are exactly the ones worth
 * looking at. So a module that genuinely checks only at the node says so here,
 * and the statement is wired to something that can go red.
 *
 * ## What this actually checks, and what it cannot
 *
 * It reads the module's own source and asserts no two-argument `ctx.check(perm,
 * entityRef)` appears in it. That is a weaker instrument than the conformance
 * kit by a wide margin, and the difference is worth stating plainly rather than
 * leaving for someone to discover:
 *
 *  - It proves an absence, never a behaviour. The kit generates a case that
 *    FAILS on a wrong implementation; this one only notices a new call site.
 *  - It is lexical. A check assembled indirectly — a helper taking the ref, a
 *    call built across lines — is invisible to it. It is a tripwire on the
 *    obvious path, not a proof.
 *  - It says nothing about whether node-only is *right*. That judgement is the
 *    prose each caller writes above it, which is the part a reviewer reads.
 *
 * What it does buy: the day someone narrows an operation in one of these
 * packages, this goes red and the change has to either declare the check and
 * wire the real kit, or rewrite the assessment. Which is the whole point — the
 * assessment stops being a comment that was true once.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { planEntityCheckCoverage } from './entity-check-plan.js';

/** A two-argument `ctx.check(...)` — the narrowed form, spelled the usual way. */
const NARROWED_CHECK = /\bctx\.check\(\s*[^()]*\([^()]*\)[^()]*,|\bctx\.check\(\s*[^(),]+\s*,/g;

export interface NodeOnlyOptions {
  /** Absolute paths to the module source this claim covers. */
  readonly sources: readonly string[];
  /**
   * Why node-only is the right answer here (#866).
   *
   * Optional to the suite — the assertion below works without it — and required
   * by `assertNodeOnly`, which is what the trust page renders from. It appears
   * in the test name so a reader of a CI log sees the claim, not just its
   * subject.
   */
  readonly because?: string;
}

/**
 * Assert a module checks permissions only at the node.
 *
 * ```ts
 * nodeOnlySuite('engine-metering', {
 *   sources: [new URL('../src/index.ts', import.meta.url).pathname],
 * });
 * ```
 */
export function nodeOnlySuite(subjectName: string, options: NodeOnlyOptions): void {
  const claim = options.because ? `${subjectName} — ${options.because}` : subjectName;
  describe(`checks at the node only: ${claim}`, () => {
    it('reads the source it claims to cover', () => {
      // The zero guard, same one the conformance kit has: a suite that read
      // nothing would pass every assertion below it.
      expect(options.sources.length).toBeGreaterThan(0);
      for (const path of options.sources) {
        expect(readFileSync(path, 'utf8').length, `${path} is empty`).toBeGreaterThan(0);
      }
    });

    it('has no operation narrowing a check to an entity', () => {
      const found: string[] = [];
      for (const path of options.sources) {
        const lines = readFileSync(path, 'utf8').split('\n');
        lines.forEach((line, i) => {
          NARROWED_CHECK.lastIndex = 0;
          if (NARROWED_CHECK.test(line)) found.push(`${path}:${i + 1}: ${line.trim()}`);
        });
      }
      expect(
        found,
        `${subjectName} is declared node-only, but these narrow to an entity. Either the ` +
          'assessment is stale, or the new check needs a declaration and the conformance ' +
          'kit rather than this tripwire.',
      ).toEqual([]);
    });
  });
}

/**
 * "This module's DECLARATION narrows nowhere" — the stronger node-only claim (#866).
 *
 * `nodeOnlySuite` above is a tripwire over source text, for a module with no
 * declared operation set to read. A module that HAS one needs no tripwire: the
 * declaration is the statement, and `planEntityCheckCoverage` reads it the same
 * way the conformance kit does. So the claim becomes "the plan is empty", which
 * is exact rather than lexical, and goes red the moment an operation declares a
 * narrowed check.
 *
 * Generalised out of `engines/invoicing`, which wrote this by hand and was the
 * only package doing it — so the fleet census read it as unassessed twice, once
 * in #865's table and once while building the report that renders it.
 *
 * The second assertion is the one that is easy to leave out. An operation with
 * NO check at all also produces an empty plan, so emptiness alone cannot tell
 * "checks at the node" from "checks nothing".
 */
export function declaredNodeOnlySuite(
  subjectName: string,
  operations: Readonly<Record<string, object>>,
  because?: string,
): void {
  const claim = because ? `${subjectName} — ${because}` : subjectName;
  describe(`entity checks: ${claim} declares none, deliberately`, () => {
    it('declares at least one operation, so the empty plan below means something', () => {
      // The zero guard: an empty registry satisfies every assertion under it.
      expect(Object.keys(operations).length).toBeGreaterThan(0);
    });

    it('has no operation narrowing to an entity, so there is no pair to generate', () => {
      const { covered, uncovered } = planEntityCheckCoverage(operations);
      expect({ covered: covered.map((c) => c.name), uncovered }).toEqual({
        covered: [],
        uncovered: {},
      });
    });

    it('still checks a permission on every operation — node-only is not un-gated', () => {
      const ungated = Object.entries(operations)
        .filter(([, op]) => !('permission' in op) && !('narrows' in op))
        .map(([name]) => name);
      expect(ungated).toEqual([]);
    });
  });
}
