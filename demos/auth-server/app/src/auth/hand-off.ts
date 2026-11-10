/** Every phase but these draws a screen for someone signing in, not the operator's console. */
export function drawsForRelyingParty(phase: string): boolean {
  return phase !== 'loading' && phase !== 'dashboard' && phase !== 'not-admin';
}
