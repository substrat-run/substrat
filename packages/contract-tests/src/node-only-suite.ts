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

/** A two-argument `ctx.check(...)` — the narrowed form, spelled the usual way. */
const NARROWED_CHECK = /\bctx\.check\(\s*[^()]*\([^()]*\)[^()]*,|\bctx\.check\(\s*[^(),]+\s*,/g;

export interface NodeOnlyOptions {
  /** Absolute paths to the module source this claim covers. */
  readonly sources: readonly string[];
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
  describe(`checks at the node only: ${subjectName}`, () => {
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
