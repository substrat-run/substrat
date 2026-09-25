import type { CSSProperties } from 'react';
import type { MigrationEntry } from '@substrat-run/contracts';
import type { MigrationSection } from '../lib/promote-review';
import { Pill } from './ui';

/**
 * The schema half of the promote dialog (#1677): each migration the promotion would run,
 * with its id and SQL, one collapsible entry each so a long set stays readable.
 *
 * Draws a `MigrationSection` and nothing else. The acknowledgement box stays in
 * `PromoteDialog`, beside the permission one, so there is still exactly one control per kind.
 */
export function PromoteMigrations({ section }: { section: MigrationSection }) {
  const { sql } = section;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {sql === null ? (
        <div style={muted}>
          SQL not available for this version
          {section.enforced ? (
            <>
              {' '}
              — the migration digest changed
              {section.digests ? (
                <>
                  {' '}
                  (<span style={mono}>{section.digests}</span>)
                </>
              ) : null}
            </>
          ) : null}
          . It was pushed by a CLI older than migrations in the manifest, or its migrations were over the size a manifest
          carries, so this dialog cannot show what they do{section.enforced ? '' : ', or whether they changed'}. Read the migrations
          in the repository before you acknowledge.
        </div>
      ) : (
        <>
          {sql.baseline === 'unavailable' && (
            <div style={muted}>
              The version prod serves was pushed before versions carried their migrations, so every migration this version ships is
              listed. A scope runs only the ones it has not already recorded.
            </div>
          )}
          {sql.total === 0 && (
            <div style={muted}>
              No SQL migration is added or edited. The migration digest also covers the app’s Durable-Object classes, and that is what
              moved.
            </div>
          )}
          {sql.changed.length > 0 && (
            <MigrationGroup
              label="Edited after shipping"
              kind="danger"
              note="Same id as a migration the serving version already has, different SQL. A scope that already ran it will not run it again."
              entries={sql.changed}
            />
          )}
          {sql.added.length > 0 && <MigrationGroup label="New migrations, in the order they run" kind="info" entries={sql.added} />}
          {sql.truncated && (
            <div style={muted}>
              This list is cut to a readable size ({sql.added.length + sql.changed.length} of {sql.total} shown, and an entry past the size
              bound shows no SQL). Read the full set in the repository before you acknowledge.
            </div>
          )}
        </>
      )}
      <div style={{ ...muted, fontSize: 12 }}>
        {section.enforced
          ? 'The registry refuses this promotion until the migration change is acknowledged.'
          : 'This acknowledgement is asked for by this dialog. The registry does not yet require it for a change to SQL migrations alone (#1754), so a promote from the CLI or the API is not stopped by it.'}
      </div>
    </div>
  );
}

const muted: CSSProperties = { fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 };
const mono: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 12 };

function MigrationGroup({
  label,
  kind,
  note,
  entries,
}: {
  label: string;
  kind: 'info' | 'danger';
  note?: string;
  entries: MigrationEntry[];
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div>
        <Pill kind={kind}>{label}</Pill>
      </div>
      {note && <div style={muted}>{note}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 4 }}>
        {entries.map((e) => (
          <details key={`${e.moduleId}\u001f${e.version}`}>
            <summary style={{ ...mono, cursor: 'pointer' }}>
              {e.moduleId} · {e.version}
            </summary>
            {e.sql === null ? (
              <div style={{ ...muted, fontSize: 12, padding: '6px 0' }}>SQL left out: past the size bound of this answer.</div>
            ) : (
              <pre
                style={{
                  ...mono,
                  margin: '6px 0',
                  padding: 8,
                  maxHeight: 240,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  background: 'var(--surface-inset)',
                  borderRadius: 6,
                }}
              >
                {e.sql}
              </pre>
            )}
          </details>
        ))}
      </div>
    </div>
  );
}
