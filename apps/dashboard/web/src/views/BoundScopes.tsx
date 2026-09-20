import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Dialog, Input, Select } from '@substrat-run/ui';
import { api, type BoundScopeRow, type BoundScopesView, type Deployment } from '../lib/api';
import { hasBoundScopes, isRetireArmed, looksStrandedByRename, moveTargets } from '../lib/bound-scopes';
import { DEV_MOCK, MOCK_BOUND_SCOPES } from '../lib/mock';
import { GridTable, Row } from '../components/layout';
import { MonoTag, Pill, type PillKind } from '../components/ui';

/**
 * The installs a vertical still backs (#1592).
 *
 * A vertical cannot be removed while a scope is bound to it, and the refusal names a
 * COUNT. This is what that count is counting, and the two things a person can do about
 * it — in the order that matches how they usually got here:
 *
 * - **Move** leads. The common case is not a cleanup: a vertical whose slug was derived
 *   from the package name was renamed, so new versions landed under the new slug while
 *   the installs stayed on the old one. Those are LIVE installs that need rebinding.
 * - **Retire** is the guarded one. It wipes storage, so it is armed by typing how many
 *   are being retired — and the worker refuses without that typed count no matter what
 *   this dialog did, so the dialog is honesty about the rule and not the rule itself.
 *
 * Renders nothing when the vertical backs nothing: an empty section would be a list of
 * zero under a heading that promises work.
 */

const STATUS_PILL: Record<string, PillKind> = {
  active: 'success',
  provisioning: 'warning',
  suspended: 'warning',
  archiving: 'warning',
  archived: 'neutral',
};

const COLUMNS = '2.2fr 0.9fr 1.1fr 2fr';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function BoundScopes({ d, all }: { d: Deployment; all: readonly Deployment[] }) {
  const [view, setView] = useState<BoundScopesView | null>(DEV_MOCK ? mockView(d.slug) : null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<'move' | 'retire' | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // What the open dialog last heard back: a refusal from the plane, shown where the
  // person is looking rather than in a toast behind a modal.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [target, setTarget] = useState('');
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState('');

  // The vertical this page is on NOW — a read that lands after the person has moved to
  // another vertical's page must not paint that page with the previous one's installs.
  const current = useRef(d.slug);
  current.current = d.slug;

  const load = useCallback(async () => {
    if (DEV_MOCK) return;
    const slug = d.slug;
    try {
      const next = await api.listBoundScopes(slug);
      if (current.current !== slug) return;
      setView(next);
      setError(null);
    } catch (e) {
      if (current.current !== slug) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [d.slug]);

  useEffect(() => {
    setView(DEV_MOCK ? mockView(d.slug) : null);
    setError(null);
    setSelected(new Set());
    setNotice(null);
    setDialog(null);
    void load();
  }, [d.slug, load]);

  const scopes = view?.scopes ?? [];
  const chosen = scopes.filter((s) => selected.has(s.id));
  const movable = chosen.filter((s) => s.movable);
  const targets = useMemo(() => moveTargets(d, all), [d, all]);
  const stranded = useMemo(() => looksStrandedByRename(d, all), [d, all]);

  const closeDialog = () => {
    setDialog(null);
    setRefusal(null);
    setAck(false);
    setTyped('');
  };

  const openMove = () => {
    setTarget(targets[0]?.slug ?? '');
    setAck(false);
    setRefusal(null);
    setNotice(null);
    setDialog('move');
  };

  const openRetire = () => {
    setTyped('');
    setRefusal(null);
    setNotice(null);
    setDialog('retire');
  };

  const move = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      const ids = movable.map((s) => s.id);
      const result = DEV_MOCK
        ? { moved: ids, refusal: null }
        : await api.moveBoundScopes(d.slug, { scopeIds: ids, target, ...(ack ? { ackMigrations: true } : {}) });
      if (DEV_MOCK) setView((v) => dropScopes(v, result.moved));
      else await load();
      // Whatever moved is off the list now; whatever did not stays selected for the re-run.
      setSelected((sel) => new Set([...sel].filter((id) => !result.moved.includes(id))));
      if (result.refusal) {
        const who = scopes.find((s) => s.id === result.refusal!.scopeId)?.slug ?? result.refusal.scopeId;
        setRefusal(`${result.moved.length > 0 ? `${plural(result.moved.length, 'install')} moved. ` : ''}${who}: ${result.refusal.message}`);
      } else {
        setNotice(`${plural(result.moved.length, 'install')} moved to ${targetName(target, all)}.`);
        closeDialog();
      }
    } catch (e) {
      setRefusal(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const retire = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      const ids = chosen.map((s) => s.id);
      const result = DEV_MOCK
        ? { retired: ids, failure: null }
        : await api.retireBoundScopes(d.slug, { scopeIds: ids, confirm: typed });
      if (DEV_MOCK) setView((v) => dropScopes(v, result.retired));
      else await load();
      setSelected((sel) => new Set([...sel].filter((id) => !result.retired.includes(id))));
      if (result.failure) {
        const who = scopes.find((s) => s.id === result.failure!.scopeId)?.slug ?? result.failure.scopeId;
        setRefusal(`${result.retired.length > 0 ? `${plural(result.retired.length, 'install')} retired. ` : ''}Stopped at ${who}: ${result.failure.message}`);
      } else {
        setNotice(`${plural(result.retired.length, 'install')} retired.`);
        closeDialog();
      }
    } catch (e) {
      setRefusal(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'var(--status-danger-fg)' }}>
        Couldn’t read the installs on this vertical: {error}
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!hasBoundScopes(view)) {
    // The last install just left — say so, and that the removal is now possible. With no
    // outcome to report there is nothing to render at all (and while loading, likewise).
    return notice ? (
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{notice} Nothing is bound to this vertical now, so it can be removed.</div>
    ) : null;
  }

  const allSelected = chosen.length === scopes.length;
  const versionLabel = (s: BoundScopeRow) =>
    s.verticalVersionId === null ? 'follows prod' : (d.versions.find((v) => v.id === s.verticalVersionId)?.version ?? 'another vertical’s version');

  return (
    <section id="bound-scopes" style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Bound scopes</h3>
        <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
          {view.live > 0 && <>{plural(view.live, 'install')} still on this vertical</>}
          {view.live > 0 && view.archived > 0 && ' · '}
          {view.archived > 0 && <>{view.archived} archived, waiting to be wiped</>}
        </span>
      </div>
      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
        This vertical can’t be removed while anything is bound to it. Move installs to the vertical your versions now land under; retire the ones that are finished.
      </p>
      {stranded && (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-secondary)' }}>
          These may have been left behind by a package rename — pin <code>"substrat": {'{'} "slug": "…" {'}'}</code> in <code>package.json</code> so new versions keep landing here.
        </p>
      )}
      {notice && <div style={{ fontSize: 12.5, color: 'var(--status-success-fg)' }}>{notice}</div>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setSelected(allSelected ? new Set() : new Set(scopes.map((s) => s.id)))}>
          {allSelected ? 'Clear selection' : 'Select all'}
        </Button>
        <span style={{ flex: 1 }} />
        <Button size="sm" disabled={busy || movable.length === 0 || targets.length === 0} onClick={openMove}>
          Move… ({movable.length})
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || chosen.length === 0}
          onClick={openRetire}
          style={{ color: 'var(--status-danger-fg)' }}
        >
          Retire… ({chosen.length})
        </Button>
      </div>
      {targets.length === 0 && (
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          Move needs another vertical of yours with a version in prod to land on — push and promote one first.
        </span>
      )}

      <GridTable columns={COLUMNS} header={['Install', 'Status', 'Pinned to', 'Names']}>
        {scopes.map((s, i) => (
          // Taller than the default row: the install cell is two lines and the names wrap.
          <Row key={s.id} columns={COLUMNS} last={i === scopes.length - 1} style={{ height: 'auto', minHeight: 56, padding: '10px 16px' }}>
            <Checkbox
              label={s.name}
              description={s.fork ? `${s.slug} · snapshot fork` : s.slug}
              checked={selected.has(s.id)}
              onChange={(on) =>
                setSelected((sel) => {
                  const next = new Set(sel);
                  if (on) next.add(s.id);
                  else next.delete(s.id);
                  return next;
                })
              }
            />
            <span>
              <Pill kind={STATUS_PILL[s.status] ?? 'neutral'}>{s.status}</Pill>
            </span>
            <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{versionLabel(s)}</span>
            <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minWidth: 0 }}>
              {s.hostnames.length === 0 ? (
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>none</span>
              ) : (
                s.hostnames.map((h) => <MonoTag key={h}>{h}</MonoTag>)
              )}
            </span>
          </Row>
        ))}
      </GridTable>

      <Dialog
        open={dialog === 'move'}
        title={`Move ${plural(movable.length, 'install')} to another vertical`}
        description="Each install is rebound onto the target’s serving version, data first. This vertical keeps its copy of the data."
        confirmLabel="Move"
        confirmDisabled={movable.length === 0 || target === ''}
        busy={busy}
        onConfirm={() => void move()}
        onCancel={closeDialog}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {movable.map((s) => (
              <MonoTag key={s.id}>{s.slug}</MonoTag>
            ))}
          </div>
          {chosen.length > movable.length && (
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              {plural(chosen.length - movable.length, 'selected scope')} {chosen.length - movable.length === 1 ? 'stays' : 'stay'} behind — a snapshot fork or an archived scope has no live install to move. Retire {chosen.length - movable.length === 1 ? 'it' : 'them'} instead.
            </span>
          )}
          <Select
            label="Move to"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            options={targets.map((t) => ({ value: t.slug, label: `${t.name} — ${t.displaySlug}` }))}
          />
          <Checkbox
            label="The migration histories differ — I have read both"
            description="Only needed when this vertical’s version and the target’s carry different migrations. The platform refuses the move otherwise, and says so."
            checked={ack}
            onChange={setAck}
          />
          {refusal && <div style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{refusal}</div>}
        </div>
      </Dialog>

      <Dialog
        open={dialog === 'retire'}
        danger
        title={`Retire ${plural(chosen.length, 'install')}`}
        description="For each: its names are released, it is archived, then its storage is wiped. A backup is taken first — if it can’t be, that install is left archived, not wiped. Snapshot forks are deleted outright. There is no restore from here."
        confirmLabel="Retire"
        confirmDisabled={!isRetireArmed(typed, chosen.length)}
        busy={busy}
        onConfirm={() => void retire()}
        onCancel={closeDialog}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 220, overflowY: 'auto' }}>
            {chosen.map((s) => (
              <div key={s.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 6, fontSize: 12.5 }}>
                <MonoTag>{s.slug}</MonoTag>
                {s.hostnames.length > 0 ? (
                  s.hostnames.map((h) => (
                    <span key={h} style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-tertiary)' }}>
                      {h}
                    </span>
                  ))
                ) : (
                  <span style={{ color: 'var(--text-tertiary)' }}>no names</span>
                )}
              </div>
            ))}
          </div>
          <Input
            label={`Type ${chosen.length} to confirm`}
            mono
            placeholder={String(chosen.length)}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          {refusal && <div style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{refusal}</div>}
        </div>
      </Dialog>
    </section>
  );
}

const targetName = (slug: string, all: readonly Deployment[]) => all.find((d) => d.slug === slug)?.name ?? slug;

/** The dev preview has no worker behind it: what a "move" or "retire" did is dropping the rows. */
function dropScopes(view: BoundScopesView | null, ids: readonly string[]): BoundScopesView | null {
  if (!view) return view;
  const scopes = view.scopes.filter((s) => !ids.includes(s.id));
  const archived = scopes.filter((s) => s.status === 'archived').length;
  return { live: scopes.length - archived, archived, scopes };
}

function mockView(slug: string): BoundScopesView | null {
  return MOCK_BOUND_SCOPES[slug] ?? null;
}
