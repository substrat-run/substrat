/**
 * Authenticating a call from the platform to a vertical (K-31, #1978).
 *
 * Moving here from the kernel, beside `readRoutedNode`. For one release the definition
 * still lives in `@substrat-run/kernel` and this module re-exports that same binding, so an
 * import from either package is the one function. Import it from here. The header names
 * it reads are wire vocabulary and live in `@substrat-run/contracts`.
 */
export { assertPlatformCall, PlatformCallError, kickFlags } from '@substrat-run/kernel';
