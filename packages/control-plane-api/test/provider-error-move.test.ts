/**
 * #1978: the delivery-failure classifier is moving here from the kernel. For one release
 * the kernel still exports it, and an import from either package must be the ONE binding.
 *
 * Which names moved is read from the kernel's own index: every export it tags
 * `@deprecated Import from \`@substrat-run/control-plane-api\`` must be exported here, as
 * that binding.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as kernel from '@substrat-run/kernel';
import * as api from '../src/index.js';
import * as providerError from '../src/provider-error.js';

/** The kernel index's exports tagged as moving to `pkg`. */
function movingTo(pkg: string): string[] {
  const index = readFileSync(join(import.meta.dirname, '../../kernel/src/index.ts'), 'utf8');
  const tagged = /@deprecated Import from `([^`]+)`[^*]*\*\/\s*(?:type\s+)?(\w+)/g;
  return [...index.matchAll(tagged)].filter(([, to]) => to === pkg).map(([, , name]) => name!);
}

const MOVED = movingTo('@substrat-run/control-plane-api');
const kernelExports = kernel as Record<string, unknown>;

describe('provider-error, moving here from the kernel (#1978)', () => {
  it('the kernel tags the names this package takes', () => {
    expect(MOVED).toContain('providerErrorStatus');
  });

  it.each(MOVED)("exposes %s as the kernel's binding", (name) => {
    expect(kernelExports[name]).toBeDefined();
    expect((api as Record<string, unknown>)[name]).toBe(kernelExports[name]);
  });

  it('the forwarding module holds only kernel bindings, each one tagged as moving here', () => {
    for (const [name, binding] of Object.entries(providerError)) {
      expect(MOVED, name).toContain(name);
      expect(binding, name).toBe(kernelExports[name]);
    }
  });
});
