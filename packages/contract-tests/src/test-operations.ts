import { undeclaredOperations, type OperationHandler } from '@substrat-run/kernel';

/**
 * A fixture's handler map, registered without a declaration (#1835).
 *
 * The suites drive the host with modules built for one assertion each, so there is no declared
 * operation surface to bind to. `undeclaredOperations` with the reason stated once, here,
 * rather than at every fixture.
 */
export const testOperations = (handlers: Readonly<Record<string, OperationHandler<never, unknown>>>) =>
  undeclaredOperations('a contract-test fixture, built to drive the host rather than declared', handlers);
