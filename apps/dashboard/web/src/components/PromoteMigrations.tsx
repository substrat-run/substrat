import { useState, type CSSProperties } from 'react';
import { clipReviewText, discardTally, reviewText, type MigrationEntry } from '@substrat-run/contracts';
import type { MigrationSection } from '../lib/promote-review';
import { Pill } from './ui';

/**
 * The schema half of the promote dialog (#1677): each migration the promotion would run,
 * with its id and SQL, one collapsible entry each so a long set stays readable. What a
 * migration declares it moves or discards (#2322) is shown under its id, outside the
 * collapsed SQL, because it is what a person approving a promote against live data most needs.
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
          <DiscardCallout tally={discardTally(sql)} />
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
          {sql.changed.some((e) => e.edited !== 'declarations') && (
            <MigrationGroup
              label="Edited after shipping"
              kind="danger"
              note="Same id as a migration the serving version already has, different SQL. A scope that already ran it will not run it again."
              entries={sql.changed.filter((e) => e.edited !== 'declarations')}
            />
          )}
          {sql.changed.some((e) => e.edited === 'declarations') && (
            <MigrationGroup
              label="Declarations edited after shipping"
              kind="warning"
              note="Same SQL as the serving version’s migration, with other moves or discards. A scope that already ran it is unaffected; one that has not is held to these."
              entries={sql.changed.filter((e) => e.edited === 'declarations')}
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
          : 'This acknowledgement is asked for by this dialog. The registry refuses a migration change too, unless both versions were pushed by a CLI older than 0.38.0, whose digest covered only the Durable-Object classes: then a promote from the CLI or the API is not stopped by a change to SQL alone.'}
      </div>
    </div>
  );
}

const muted: CSSProperties = { fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 };
const mono: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 12 };

function DiscardCallout({ tally: { count, atLeast } }: { tally: { count: number; atLeast: boolean } }) {
  if (count === 0) {
    // A cut answer may hold its discards in the entries it left out: it says so rather than nothing.
    return atLeast ? (
      <div style={muted}>This list is cut, so it cannot show whether a migration left out of it discards data. Read the rest in the repository.</div>
    ) : null;
  }
  return (
    <div
      role="note"
      style={{ ...muted, color: 'var(--text-primary)', padding: '8px 10px', borderRadius: 6, background: 'var(--surface-inset)' }}
    >
      <Pill kind="danger">Discards data</Pill> This promote deliberately discards data in {atLeast ? 'at least ' : ''}{count} place{count === 1 ? '' : 's'}. Each reason
      below is the migration author’s own; read it before you acknowledge.
    </div>
  );
}

/**
 * What one migration declares (#2322). Every string here is the pusher's: rendered as React
 * text (never markup), with every control, format and bidi character made visible (`reviewText`),
 * and a long or many-line reason cut with an expander so it cannot push the rest of the review
 * out of sight. The migration's id and SQL below go through `reviewText` too.
 */
function MigrationDeclarations({ entry }: { entry: MigrationEntry }) {
  if (entry.declarationsLeftOut) {
    return (
      <div style={{ ...muted, fontSize: 12 }}>
        Declares moves or discards that are left out: past the size bound of this answer. Read them in the repository before you acknowledge.
      </div>
    );
  }
  const discards = Object.entries(entry.discards ?? {});
  const moves = Object.entries(entry.moves ?? {});
  if (discards.length === 0 && moves.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 0 2px 2px' }}>
      {discards.map(([target, why]) => (
        <div key={`d${target}`} style={{ ...muted, display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <Pill kind="danger">Discards</Pill>
          <span style={mono}>{reviewText(target)}</span>
          <Reason text={why} />
        </div>
      ))}
      {moves.map(([from, to]) => (
        <div key={`m${from}`} style={{ ...muted, display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <Pill kind="info">Moves</Pill>
          <span style={mono}>
            {reviewText(from)} → {reviewText(to)}
          </span>
          <span>verified when it runs</span>
        </div>
      ))}
    </div>
  );
}

function Reason({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const { full, shown, clipped } = clipReviewText(text);
  return (
    <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      — {open || !clipped ? full : `${shown}…`}
      {clipped && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={{ marginLeft: 6, border: 'none', background: 'none', padding: 0, color: 'var(--text-link)', cursor: 'pointer', font: 'inherit' }}
        >
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </span>
  );
}

function MigrationGroup({
  label,
  kind,
  note,
  entries,
}: {
  label: string;
  kind: 'info' | 'danger' | 'warning';
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
          // The declarations sit outside the collapsed SQL, so they are read without opening it.
          <div key={`${e.moduleId}\u001f${e.version}`}>
            <details>
              <summary style={{ ...mono, cursor: 'pointer' }}>
                {reviewText(e.moduleId)} · {reviewText(e.version)}
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
                  {reviewText(e.sql)}
                </pre>
              )}
            </details>
            <MigrationDeclarations entry={e} />
          </div>
        ))}
      </div>
    </div>
  );
}
