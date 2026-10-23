import type { RoleDefinition } from '@substrat-run/contracts';

/**
 * #2447: the ControlPlaneDO's `defineRole` answer, read whichever build of the DO gave it. Since
 * #2447 it answers `{ before }` or `{ refused }`; a DO from before that, still running in a
 * deploy's restart window, answers the previous definition itself, or `null` for a key's first
 * definition. That older DO judged nothing, so its answer is never a refusal.
 */
export function definedRoleOf(
  reply: { before: RoleDefinition | null } | { refused: string } | RoleDefinition | null | undefined,
): { before: RoleDefinition | null } | { refused: string } {
  if (reply && typeof reply === 'object' && 'refused' in reply && typeof reply.refused === 'string') return { refused: reply.refused };
  if (reply && typeof reply === 'object' && 'before' in reply) return { before: reply.before };
  return { before: (reply as RoleDefinition | null | undefined) ?? null };
}
