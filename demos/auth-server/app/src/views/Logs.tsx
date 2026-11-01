import { PageHeader } from '@substrat-run/ui';

/** PLACEHOLDER — filled in by its Phase 2 slice (spec/console-redesign.md §3). */
export function LogsView() {
  return (
    <>
      <PageHeader title="Logs" />
    </>
  );
}

/**
 * PLACEHOLDER — the log table narrowed to one application or one user, for the detail screens'
 * Logs tabs. Filled in with the Logs slice; its props are the contract those tabs code against.
 */
export function LogTable(_: { clientId?: string; userId?: string; limit?: number }) {
  return null;
}
