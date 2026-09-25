import type { ExportBreak, PromotionAcknowledgement } from '@substrat-run/contracts';

/**
 * What the promote dialog knows about whom a promotion breaks (#1705 PR 3): the impact read,
 * or why it could not be read, or that it is still loading.
 */
export type ImpactState =
  | { kind: 'loading' }
  | { kind: 'ready'; affected: ExportBreak[]; otherTenants: number }
  | { kind: 'error'; message: string };

/**
 * Whether the export-break acknowledgement is required before Promote is enabled: exactly when
 * the read names an app. An impact that could not be read does not block the button. The
 * registry's own gate still refuses a breaking promote, and its refusal is what the operator
 * then reads.
 */
export function exportBreakAckNeeded(impact: ImpactState): boolean {
  return impact.kind === 'ready' && (impact.affected.length > 0 || impact.otherTenants > 0);
}

/** Every acknowledgement the dialog shows is satisfied. */
export function promoteAckSatisfied(
  needs: { permission: boolean; migration: boolean; exportBreak: boolean },
  ack: PromotionAcknowledgement,
): boolean {
  return (
    (!needs.permission || !!ack.permissionChange) &&
    (!needs.migration || !!ack.migrationChange) &&
    (!needs.exportBreak || !!ack.exportBreak)
  );
}
