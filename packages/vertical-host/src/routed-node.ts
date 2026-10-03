/**
 * Reading the node the router asserted (K-26, #1978).
 *
 * Moving here from the kernel: every vertical reads it, and nothing in it needs a kernel
 * guarantee. For one release the definition still lives in `@substrat-run/kernel` and this
 * module re-exports that same binding, so an import from either package is the one
 * function. Import it from here.
 */
export { readRoutedNode, RouterAssertionError } from '@substrat-run/kernel';
export type { RoutedNode, HeaderReader, ReadRoutedNodeOptions } from '@substrat-run/kernel';
