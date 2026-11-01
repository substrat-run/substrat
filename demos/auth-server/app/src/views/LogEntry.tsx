import { PageHeader } from '@substrat-run/ui';

/** PLACEHOLDER — filled in by its Phase 2 slice (spec/console-redesign.md §3). */
export function LogEntryView({ id }: { id: number }) {
  return (
    <>
      <PageHeader title={String(id)} />
    </>
  );
}
