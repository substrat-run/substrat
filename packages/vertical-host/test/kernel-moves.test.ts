/**
 * #1978: the request log and the router assertion moved here from the kernel (#1998). The
 * kernel no longer exports them, so there is one definition and one class: a second
 * `RouterAssertionError` would be one an `instanceof` from the other import misses.
 *
 * What stays a kernel binding re-exported here is held to being that binding: the upgrade
 * test (the hosted adapter's door asks it too) and the invocation line's grammar (the scope
 * host writes the async lines with it). The platform-call check moved to contracts'
 * `./wire-auth` (#1998), because the control plane checks it too; it is re-exported here as
 * that binding, and the kick flags beside it are defined here.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as kernel from '@substrat-run/kernel';
import * as wireAuth from '@substrat-run/contracts/wire-auth';
import * as host from '../src/index.js';

const kernelExports = kernel as Record<string, unknown>;
const hostExports = host as Record<string, unknown>;

const MOVED = [
  'invocationLog',
  'withInvocationLog',
  'invocationStampOf',
  'fieldCoverageArmed',
  'INVOCATION_RECORD_KEY',
  'readRoutedNode',
  'RouterAssertionError',
  'kickFlags',
];

// The moved types: each line is a compile error unless the kernel has stopped exporting it.
// @ts-expect-error moved to vertical-host
export type MovedInvocationLogContext = kernel.InvocationLogContext;
// @ts-expect-error moved to vertical-host
export type MovedInvocationRecord = kernel.InvocationRecord;
// @ts-expect-error moved to vertical-host
export type MovedInvocationStamp = kernel.InvocationStamp;
// @ts-expect-error moved to vertical-host
export type MovedModuleWorker = kernel.ModuleWorker;
// @ts-expect-error moved to vertical-host
export type MovedIncomingRequest = kernel.IncomingRequest;
// @ts-expect-error moved to vertical-host
export type MovedRoutedNode = kernel.RoutedNode;
// @ts-expect-error moved to vertical-host
export type MovedHeaderReader = kernel.HeaderReader;
// @ts-expect-error moved to vertical-host
export type MovedReadRoutedNodeOptions = kernel.ReadRoutedNodeOptions;

describe('exports moved here from the kernel (#1978)', () => {
  it.each(MOVED)('exports %s, and the kernel does not', (name) => {
    expect(hostExports[name], name).toBeDefined();
    expect(kernelExports[name], name).toBeUndefined();
  });

  it('the moved types are exported here', () => {
    expectTypeOf<host.InvocationLogContext>().not.toBeAny();
    expectTypeOf<host.InvocationRecord>().not.toBeAny();
    expectTypeOf<host.InvocationStamp>().not.toBeAny();
    expectTypeOf<host.ModuleWorker>().not.toBeAny();
    expectTypeOf<host.IncomingRequest>().not.toBeAny();
    expectTypeOf<host.RoutedNode>().not.toBeAny();
    expectTypeOf<host.HeaderReader>().not.toBeAny();
    expectTypeOf<host.ReadRoutedNodeOptions>().not.toBeAny();
  });
});

describe('kernel bindings re-exported here', () => {
  it("isUpgradeRequest is the kernel's binding", () => {
    expect(kernelExports.isUpgradeRequest).toBeDefined();
    expect(host.isUpgradeRequest).toBe(kernel.isUpgradeRequest);
  });

  it("the invocation line's types are the kernel's", () => {
    expectTypeOf<host.InvocationLogLine>().toEqualTypeOf<kernel.InvocationLogLine>();
    expectTypeOf<host.OutputFieldsReport>().toEqualTypeOf<kernel.OutputFieldsReport>();
  });

});

describe("contracts' platform-call check, re-exported here (#1998)", () => {
  it.each(['assertPlatformCall', 'PlatformCallError'])("%s is contracts' binding, and the kernel has none", (name) => {
    expect(hostExports[name], name).toBe((wireAuth as Record<string, unknown>)[name]);
    expect(kernelExports[name], name).toBeUndefined();
  });

  it('a platform-call error thrown through one import is an instance of the other', () => {
    expect(() => host.assertPlatformCall({ get: () => null })).toThrow(wireAuth.PlatformCallError);
  });

  it('the constant-time compare is not re-exported here', () => {
    expect(hostExports.secretMatches).toBeUndefined();
  });
});
