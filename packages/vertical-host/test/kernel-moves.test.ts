/**
 * #1978: the request log, the router assertion, the platform-call check and the upgrade
 * test are moving here from the kernel. For one release the kernel still exports them, and
 * an import from either package must be the ONE binding — not a copy that could drift,
 * and not a second `RouterAssertionError` class that an `instanceof` from the other import
 * would miss.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as kernel from '@substrat-run/kernel';
import * as host from '../src/index.js';
import * as invocationLogModule from '../src/invocation-log.js';
import * as routedNodeModule from '../src/routed-node.js';
import * as platformCallModule from '../src/platform-call.js';

const MOVED = {
  'invocation-log': {
    module: invocationLogModule,
    names: ['invocationLog', 'INVOCATION_RECORD_KEY', 'invocationStampOf', 'withInvocationLog'],
  },
  'routed-node': { module: routedNodeModule, names: ['readRoutedNode', 'RouterAssertionError'] },
  'platform-call': { module: platformCallModule, names: ['assertPlatformCall', 'PlatformCallError', 'kickFlags'] },
} as const;

describe('exports moving here from the kernel (#1978)', () => {
  for (const [file, { module, names }] of Object.entries(MOVED)) {
    it(`${file}: forwards exactly the moved names`, () => {
      expect(Object.keys(module).sort()).toEqual([...names].sort());
    });

    it(`${file}: each one is the kernel's binding, from the module and from the package index`, () => {
      for (const name of names) {
        const kernelBinding = (kernel as Record<string, unknown>)[name];
        expect(kernelBinding, name).toBeDefined();
        expect((module as Record<string, unknown>)[name], name).toBe(kernelBinding);
        expect((host as Record<string, unknown>)[name], name).toBe(kernelBinding);
      }
    });
  }

  it("isUpgradeRequest is the kernel's binding", () => {
    expect(host.isUpgradeRequest).toBe(kernel.isUpgradeRequest);
  });

  it('an error thrown through one import is an instance of the other', () => {
    const headers = { get: (name: string) => (name === 'x-substrat-tenant' ? 'not-a-ulid' : null) };
    expect(() => kernel.readRoutedNode(headers, { allowUnsigned: true })).toThrow(host.RouterAssertionError);
    expect(() => host.assertPlatformCall(headers)).toThrow(kernel.PlatformCallError);
  });

  it('the moved types are the kernel types', () => {
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
