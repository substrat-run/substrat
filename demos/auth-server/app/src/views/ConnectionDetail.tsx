import { PageHeader } from '@substrat-run/ui';
import type { ConnectionTab } from '../console/paths';
/** PLACEHOLDER — filled in by its Phase 2 slice (spec/console-redesign.md §3). */
export function ConnectionDetailView({ id }: { id: string; tab: ConnectionTab; issuer: string | null }) {
  return (
    <>
      <PageHeader title={id} />
    </>
  );
}
