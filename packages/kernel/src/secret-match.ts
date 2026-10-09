/**
 * Constant-time compare, so a wrong secret leaks nothing through timing.
 *
 * The one copy, shared by the kernel's platform-call check and vertical-host's router
 * assertion (`readRoutedNode`). Its own module, importing nothing, because the router
 * assertion is bundled into the platform's entry in front of every deployed vertical
 * (#1893) and reaches this through the zero-import `./secret-match` subpath: the kernel
 * root would bring contracts, and zod, with it.
 */
export function secretMatches(presented: string | null, expected: string): boolean {
  if (!presented || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
