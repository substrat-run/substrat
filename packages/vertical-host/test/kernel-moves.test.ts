/**
 * #1978: the request log, the router assertion, the platform-call check and the upgrade
 * test are moving here from the kernel. For one release the kernel still exports them, and
 * an import from either package must be the ONE binding — not a copy that could drift,
 * and not a second `RouterAssertionError` class that an `instanceof` from the other import
 * would miss.
 *
 * Which names moved is read from the kernel's own index: every export it tags
 * `@deprecated Import from \`@substrat-run/vertical-host\`` must be exported here, as that
 * binding. A name tagged there and forgotten here fails, with no list to keep in step.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as kernel from '@substrat-run/kernel';
import * as host from '../src/index.js';
import * as invocationLogModule from '../src/invocation-log.js';
import * as routedNodeModule from '../src/routed-node.js';
import * as platformCallModule from '../src/platform-call.js';

/** The kernel index's exports tagged as moving to `pkg`. */
function movingTo(pkg: string): string[] {
  const index = readFileSync(join(import.meta.dirname, '../../kernel/src/index.ts'), 'utf8');
  const tagged = /@deprecated Import from `([^`]+)`[^*]*\*\/\s*(?:type\s+)?(\w+)/g;
  return [...index.matchAll(tagged)].filter(([, to]) => to === pkg).map(([, , name]) => name!);
}

const MOVED = movingTo('@substrat-run/vertical-host');
const kernelExports = kernel as Record<string, unknown>;
// A type has no runtime binding; the type half is checked by `expectTypeOf` below.
const VALUES = MOVED.filter((name) => kernelExports[name] !== undefined);
const TYPES = MOVED.filter((name) => kernelExports[name] === undefined);

describe('exports moving here from the kernel (#1978)', () => {
  it('the kernel tags the names this package takes', () => {
    expect(VALUES).toContain('readRoutedNode');
    expect(TYPES).toContain('RoutedNode');
  });

  it.each(VALUES)("exposes %s as the kernel's binding", (name) => {
    expect((host as Record<string, unknown>)[name]).toBe(kernelExports[name]);
  });

  it.each([
    ['invocation-log', invocationLogModule],
    ['routed-node', routedNodeModule],
    ['platform-call', platformCallModule],
  ] as const)('%s forwards only kernel bindings, each one tagged as moving here', (_, module) => {
    for (const [name, binding] of Object.entries(module)) {
      expect(VALUES, name).toContain(name);
      expect(binding, name).toBe(kernelExports[name]);
    }
  });

  it('an error thrown through one import is an instance of the other', () => {
    const headers = { get: (name: string) => (name === 'x-substrat-tenant' ? 'not-a-ulid' : null) };
    expect(() => kernel.readRoutedNode(headers, { allowUnsigned: true })).toThrow(host.RouterAssertionError);
    expect(() => host.assertPlatformCall(headers)).toThrow(kernel.PlatformCallError);
  });

  it('every moved type is checked below', () => {
    expect([...TYPES].sort()).toEqual(
      [
        'HeaderReader',
        'IncomingRequest',
        'InvocationLogContext',
        'InvocationLogLine',
        'InvocationRecord',
        'InvocationStamp',
        'ModuleWorker',
        'OutputFieldsReport',
        'ReadRoutedNodeOptions',
        'RoutedNode',
      ],
    );
    expectTypeOf<host.InvocationLogLine>().toEqualTypeOf<kernel.InvocationLogLine>();
    expectTypeOf<host.InvocationLogContext>().toEqualTypeOf<kernel.InvocationLogContext>();
    expectTypeOf<host.InvocationRecord>().toEqualTypeOf<kernel.InvocationRecord>();
    expectTypeOf<host.OutputFieldsReport>().toEqualTypeOf<kernel.OutputFieldsReport>();
    expectTypeOf<host.InvocationStamp>().toEqualTypeOf<kernel.InvocationStamp>();
    expectTypeOf<host.ModuleWorker>().toEqualTypeOf<kernel.ModuleWorker>();
    expectTypeOf<host.IncomingRequest>().toEqualTypeOf<kernel.IncomingRequest>();
    expectTypeOf<host.RoutedNode>().toEqualTypeOf<kernel.RoutedNode>();
    expectTypeOf<host.HeaderReader>().toEqualTypeOf<kernel.HeaderReader>();
    expectTypeOf<host.ReadRoutedNodeOptions>().toEqualTypeOf<kernel.ReadRoutedNodeOptions>();
  });
});
