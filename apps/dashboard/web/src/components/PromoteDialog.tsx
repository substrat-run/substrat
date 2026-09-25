import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Checkbox, Dialog } from '@substrat-run/ui';
import { registryDirection, type RegistryDirection, type RegistryLike } from '../lib/registry-diff';
import { outstanding, type Acks, type Checkpoint, type MigrationSection, type PermissionSection, type Unverifiable } from '../lib/promote-review';
import { ExportBreakAck } from './ExportBreakAck';
import { MonoTag, Pill } from './ui';

/**
 * The promote checkpoint (#1677): what a promotion changes, and one acknowledgement per
 * kind of change, ticked by the person on its own.
 *
 * It replaces `window.confirm`, which could show only two digests and then acknowledged
 * BOTH kinds on one OK whichever of them had moved. The decisions live in
 * `lib/promote-review.ts`; this file only draws a `Checkpoint` and hands back the boxes
 * that were ticked. It is mounted per round (keyed), so a new checkpoint never inherits
 * a tick from the last one.
 *
 * A box exists only for a kind the checkpoint carries and has not already had acknowledged,
 * so there is no control by which an acknowledgement could be given for a change that was
 * not shown.
 */
export function PromoteDialog({
  slug,
  servingLabel,
  incomingLabel,
  checkpoint,
  onAnswer,
}: {
  slug: string;
  /** The version `prod` serves now, or null when nothing does. */
  servingLabel: string | null;
  incomingLabel: string;
  checkpoint: Checkpoint;
  /** The boxes ticked, or null if the person backed out. */
  onAnswer: (answer: Acks | null) => void;
}) {
  const [permissionTicked, setPermissionTicked] = useState(false);
  const [migrationTicked, setMigrationTicked] = useState(false);
  const [exportBreakTicked, setExportBreakTicked] = useState(false);
  const left = outstanding(checkpoint);
  const ready =
    (!left.permission || permissionTicked) && (!left.migration || migrationTicked) && (!left.exportBreak || exportBreakTicked);

  const answer = (): Acks => ({
    ...(left.permission && permissionTicked ? { permissionChange: true as const } : {}),
    ...(left.migration && migrationTicked ? { migrationChange: true as const } : {}),
    ...(left.exportBreak && exportBreakTicked ? { exportBreak: true as const } : {}),
  });

  return (
    <Dialog
      open
      width={640}
      title={`Promote ${incomingLabel} to prod`}
      description={`${slug} serves ${servingLabel ?? 'no version'} in prod now. This promotion changes it — read each change, then acknowledge it.`}
      confirmLabel="Promote"
      confirmDisabled={!ready}
      onConfirm={() => onAnswer(answer())}
      onCancel={() => onAnswer(null)}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxHeight: '60vh', overflowY: 'auto' }}>
        {checkpoint.permission && (
          <Section title="Permission changes">
            <PermissionBody section={checkpoint.permission} servingLabel={servingLabel} incomingLabel={incomingLabel} />
            {left.permission ? (
              <Checkbox
                label="I have read the permission changes and acknowledge them"
                checked={permissionTicked}
                onChange={setPermissionTicked}
              />
            ) : (
              <Acknowledged />
            )}
          </Section>
        )}
        {checkpoint.migration && (
          <Section title="Migration changes">
            <MigrationBody section={checkpoint.migration} />
            {left.migration ? (
              <Checkbox
                label="I acknowledge the migration change"
                description="Acknowledged separately from the permission changes — one does not cover the other."
                checked={migrationTicked}
                onChange={setMigrationTicked}
              />
            ) : (
              <Acknowledged />
            )}
          </Section>
        )}
        {checkpoint.exportBreak && (
          <ExportBreakAck
            section={checkpoint.exportBreak}
            outstanding={left.exportBreak}
            ticked={exportBreakTicked}
            onTick={setExportBreakTicked}
          />
        )}
      </div>
    </Dialog>
  );
}

const muted: CSSProperties = { fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 };
const mono: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 12 };

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
      {children}
    </section>
  );
}

function Acknowledged() {
  return <div style={{ fontSize: 12.5, color: 'var(--status-success-fg)' }}>Acknowledged.</div>;
}

const UNVERIFIABLE: Record<Unverifiable, (serving: string | null, incoming: string) => string> = {
  'serving-has-no-registry': (serving) =>
    `The version prod serves${serving ? ` (${serving})` : ''} carries no permission registry — it was pushed before registries were kept — so nothing here can be compared against it.`,
  'incoming-has-no-registry': (_serving, incoming) =>
    `${incoming} carries no permission registry — it was pushed before registries were kept, or declares no permissions — so nothing here can be compared.`,
  'neither-has-a-registry': () =>
    'Neither the version prod serves nor the one being promoted carries a permission registry, so nothing here can be compared.',
};

const DIRECTION: Record<Exclude<RegistryDirection, 'none'>, string> = {
  adds: 'This promotion only adds permissions. Nothing is removed.',
  removes: 'This promotion only removes permissions. Nothing is added.',
  mixed: 'This promotion adds, removes or re-words permissions.',
};

function PermissionBody({ section, servingLabel, incomingLabel }: { section: PermissionSection; servingLabel: string | null; incomingLabel: string }) {
  if (section.kind === 'unverifiable') {
    return (
      <div style={muted}>
        {UNVERIFIABLE[section.why](servingLabel, incomingLabel)} The permission surface may have changed, and this dialog cannot show
        how. Promoting means accepting that.
      </div>
    );
  }
  if (section.kind === 'server-reported') {
    return (
      <div style={muted}>
        The registry reports that the permission surface differs{section.digests ? <> (<span style={mono}>{section.digests}</span>)</> : null},
        but no per-permission difference could be drawn. Promoting means accepting a change this dialog cannot show.
      </div>
    );
  }
  const { diff, from, to } = section;
  const direction = registryDirection(diff);
  const describe = (reg: RegistryLike, key: string) => reg.permissions.find((p) => p.key === key)?.description;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {direction !== 'none' && <div style={{ ...muted, color: 'var(--text-primary)' }}>{DIRECTION[direction]}</div>}
      {diff.addedKeys.length > 0 && (
        <Group label="New permissions" kind="info">
          {diff.addedKeys.map((k) => (
            <KeyLine key={k} k={k} note={describe(to, k)} />
          ))}
        </Group>
      )}
      {diff.removedKeys.length > 0 && (
        <Group label="Removed permissions" kind="danger">
          {diff.removedKeys.map((k) => (
            <KeyLine key={k} k={k} note={describe(from, k)} />
          ))}
        </Group>
      )}
      {diff.changedKeys.length > 0 && (
        <Group label="Description changed" kind="warning">
          {diff.changedKeys.map((k) => (
            <KeyLine key={k} k={k} note={`“${describe(from, k) ?? ''}” → “${describe(to, k) ?? ''}”`} />
          ))}
        </Group>
      )}
      {diff.roleChanges.length > 0 && (
        <Group label="Roles" kind="neutral">
          {diff.roleChanges.map((r) => (
            <ShapeLine
              key={r.key}
              name={r.key}
              added={r.added}
              removed={r.removed}
              status={r.isNew ? 'new role' : r.isGone ? 'role removed' : r.added.length > 0 ? 'role widened' : 'role narrowed'}
              kind={r.isGone ? 'neutral' : r.added.length > 0 || r.isNew ? 'warning' : 'neutral'}
            />
          ))}
        </Group>
      )}
      {diff.grantChanges.length > 0 && (
        <Group label="Entity grant shapes" kind="neutral">
          {diff.grantChanges.map((g) => (
            <ShapeLine
              key={g.entityType}
              name={g.entityType}
              added={g.added}
              removed={g.removed}
              status={g.isNew ? 'new shape' : g.isGone ? 'shape removed' : g.added.length > 0 ? 'shape widened' : 'shape narrowed'}
              kind={g.isGone ? 'neutral' : g.added.length > 0 || g.isNew ? 'warning' : 'neutral'}
            />
          ))}
        </Group>
      )}
    </div>
  );
}

function Group({ label, kind, children }: { label: string; kind: 'info' | 'danger' | 'warning' | 'neutral'; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div>
        <Pill kind={kind}>{label}</Pill>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 4 }}>{children}</div>
    </div>
  );
}

function KeyLine({ k, note }: { k: string; note?: string | undefined }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
      <span style={mono}>{k}</span>
      {note && <span style={{ ...muted, fontSize: 12 }}>{note}</span>}
    </div>
  );
}

function ShapeLine({ name, added, removed, status, kind }: { name: string; added: string[]; removed: string[]; status: string; kind: 'warning' | 'neutral' }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <Pill kind={kind}>{status}</Pill>
      <MonoTag>{name}</MonoTag>
      {added.map((p) => (
        <span key={`+${p}`} style={{ ...mono, color: 'var(--status-info-fg)' }}>
          +{p}
        </span>
      ))}
      {removed.map((p) => (
        <span key={`-${p}`} style={{ ...mono, color: 'var(--status-danger-fg)' }}>
          −{p}
        </span>
      ))}
    </div>
  );
}

function MigrationBody({ section }: { section: MigrationSection }) {
  return (
    <div style={muted}>
      The migration set changed{section.digests ? <> (<span style={mono}>{section.digests}</span>)</> : null}. The SQL isn’t available
      yet (#1677 part b), so what the migrations do can’t be shown here — read them in the repository before you acknowledge.
    </div>
  );
}
