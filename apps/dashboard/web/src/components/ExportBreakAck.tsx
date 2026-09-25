import { Checkbox } from '@substrat-run/ui';
import type { ExportBreakSection } from '../lib/promote-review';
import { MonoTag, Pill } from './ui';

/**
 * The promote dialog's export-break section (#1705 PR 3), kept to itself so the dialog's other
 * sections can grow without touching it.
 *
 * The version being promoted drops, or changes the version of, an event type that installed
 * apps import. Their edges then stop delivering it. Nothing is lost, and nothing arrives either.
 * This tenant's own apps are named. Another tenant's are only counted, because the plane never
 * tells a tenant who else runs what.
 */
export function ExportBreakAck({
  section,
  outstanding,
  ticked,
  onTick,
}: {
  section: ExportBreakSection;
  outstanding: boolean;
  ticked: boolean;
  onTick: (v: boolean) => void;
}) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Apps that import these events</div>
      {section.kind === 'listing' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {section.listing.affected.map((b) => (
            <div key={`${b.scopeId}:${b.type}`} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Pill kind="danger">{b.incoming === null ? 'no longer exported' : `now v${b.incoming}`}</Pill>
              <MonoTag>{b.vertical}</MonoTag>
              <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                imports <span style={{ fontFamily: 'var(--font-mono)' }}>{b.type}</span> v{b.schemaVersion}
              </span>
            </div>
          ))}
          {section.listing.otherTenants ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
              …and apps in {section.listing.otherTenants} other team(s).
            </div>
          ) : null}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{section.summary}</div>
      )}
      {outstanding ? (
        <Checkbox
          label="I understand these apps stop receiving these events until they are updated"
          checked={ticked}
          onChange={onTick}
        />
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--status-success-fg)' }}>Acknowledged.</div>
      )}
    </section>
  );
}
