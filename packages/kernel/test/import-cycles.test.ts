/**
 * The kernel's runtime import cycles, pinned (#1978). `lint:cycles` judges the workspace's
 * package edges only; inside a package a value cycle is the same coin flip one level down —
 * which module's top level runs first decides whether a `const` is still undefined when the
 * other reads it. `peer.ts` ↔ `platform-sweep.ts` was one until the sweep's per-scope halves
 * (schedule state, scope identity, install receipts, the export-break gate) left it for
 * modules of their own. This holds the list to what is left, so a new cycle appears in the
 * PR that adds it, and removing the last one shows up here too.
 *
 * Type-only imports are erased at compile time and cannot cycle at run time, so they are
 * not edges (`import type`, or a braced list whose every name is `type`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../src');

/** The value cycles that predate this test. Fix one, and take it off. */
const KNOWN_CYCLES: string[][] = [['capability', 'entity-binding', 'entity-grant-shape', 'permission-eval']];

/** `module → modules it imports at run time`, from each source's relative imports. */
function valueEdges(sources: ReadonlyMap<string, string>): Map<string, Set<string>> {
  // `[^;]*?` keeps a match inside one statement, so a type-only import is never read
  // together with the relative import after it.
  const statement = /^(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+'\.\/([\w.-]+)\.js';/gm;
  const edges = new Map<string, Set<string>>();
  for (const [name, source] of sources) {
    const to = new Set<string>();
    for (const [, typeOnly, clause, target] of source.matchAll(statement)) {
      if (typeOnly) continue;
      const braced = clause!.trim().match(/^\{([\s\S]*)\}$/);
      const names = braced ? braced[1]!.split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (names.length > 0 && names.every((n) => n.startsWith('type '))) continue;
      to.add(target!);
    }
    edges.set(name, to);
  }
  return edges;
}

/** Every strongly connected set of more than one module, each sorted, the list sorted. */
function cyclesOf(edges: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string): void => {
    index.set(v, next);
    low.set(v, next);
    next++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) !== index.get(v)) return;
    const component: string[] = [];
    let w: string;
    do {
      w = stack.pop()!;
      onStack.delete(w);
      component.push(w);
    } while (w !== v);
    if (component.length > 1) out.push(component.sort());
  };
  for (const v of edges.keys()) if (!index.has(v)) visit(v);
  return out.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

function kernelSources(): Map<string, string> {
  return new Map(
    readdirSync(SRC)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => [f.slice(0, -'.ts'.length), readFileSync(join(SRC, f), 'utf8')]),
  );
}

describe("the kernel's runtime import cycles (#1978)", () => {
  const sources = kernelSources();

  it('are exactly the known ones', () => {
    expect(cyclesOf(valueEdges(sources))).toEqual(KNOWN_CYCLES);
  });

  it('do not reach back into the platform sweep from anything split out of it', () => {
    for (const split of ['schedule-state', 'scope-identity', 'install-receipts', 'export-break', 'map-bounded']) {
      // Any import at all, a type-only one included: these sit below the sweep.
      expect(sources.get(split), split).not.toMatch(/from '\.\/platform-sweep\.js'/);
    }
  });

  it('finds a cycle through a value import, and none through a type-only one', () => {
    const value = new Map([
      ['a', "import type { T } from '@substrat-run/contracts';\nimport { b } from './b.js';"],
      ['b', "import {\n  type T,\n  a,\n} from './a.js';"],
    ]);
    expect(cyclesOf(valueEdges(value))).toEqual([['a', 'b']]);

    const typeOnly = new Map([
      ['a', "import { b } from './b.js';"],
      ['b', "import type { A } from './a.js';\nexport { type A2 } from './a.js';"],
    ]);
    expect(cyclesOf(valueEdges(typeOnly))).toEqual([]);
  });
});
