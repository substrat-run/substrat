import { useState } from 'react';
import { Button, Input, Select } from '@substrat-run/ui';
import { type CatalogEntry } from '../lib/api';
import { ENV_OPTS, verticalMeta } from '../lib/demo';
import { Ic } from '../lib/icons';
import { slugify } from '../lib/format';
import { Page } from '../components/layout';
import { card, Pill } from '../components/ui';

interface Source {
  /** Display name of the picked vertical. */
  title: string;
  engineLine: string;
  accent: string;
  defaultName: string;
  /** The catalog slug the app is created under. */
  verticalSlug: string;
}

/** Short marketing lines for the first-party verticals the live catalog can offer. */
const TEMPLATE_BLURBS: Record<string, string> = {
  protocol: 'Documents, protocols & e-signing',
  documents: 'Documents, protocols & e-signing',
  callout: 'Work orders, time & material, self-inspection',
  workorder: 'Work orders, time & material, self-inspection',
};

/**
 * Create App — pure INSTANTIATION (the demand side of the marketplace split). Step 1
 * picks a vertical from the live catalog (`GET /api/catalog`), grouped **Marketplace**
 * (published) and **Your verticals** (your team's own, private unless published). Step 2
 * configures + creates: `POST /api/apps` provisions an instance — your data, your domain.
 * Building a NEW vertical (GitHub import, CLI push) lives on the Verticals page: a repo
 * import produces a pushed version, not a running app, so it isn't a create-app source.
 */
export function CreateApp({
  catalog,
  teamName,
  onCancel,
  onCreate,
}: {
  catalog: CatalogEntry[];
  /** The current team's display name — slugified into the hostname preview, mirroring the worker. */
  teamName?: string;
  onCancel: () => void;
  onCreate: (input: { verticalSlug: string; name: string }) => Promise<void>;
}) {
  const [source, setSource] = useState<Source | null>(null);

  if (!source) {
    return <ChooseVertical catalog={catalog} onCancel={onCancel} onPick={setSource} />;
  }
  return <Configure source={source} teamName={teamName} onBack={() => setSource(null)} onCancel={onCancel} onCreate={onCreate} disabled={catalog.length === 0} />;
}

function Stepper({ step }: { step: 1 | 2 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: step === 1 ? 500 : 400, color: step === 1 ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
        <span style={{ width: 20, height: 20, borderRadius: '50%', background: step === 1 ? 'var(--brand-600)' : 'var(--surface-active)', color: step === 1 ? '#fff' : undefined, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600 }}>
          {step === 1 ? '1' : <Ic name="check" size={12} color="var(--status-success-fg)" />}
        </span>
        Vertical
      </span>
      <span style={{ width: 48, height: 1, background: 'var(--border-strong)' }} />
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: step === 2 ? 500 : 400, color: step === 2 ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
        <span style={{ width: 20, height: 20, borderRadius: '50%', background: step === 2 ? 'var(--brand-600)' : 'transparent', border: step === 2 ? 'none' : '1px solid var(--border-strong)', color: step === 2 ? '#fff' : undefined, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, boxSizing: 'border-box' }}>2</span>
        Configure
      </span>
    </div>
  );
}

function Header({ onCancel }: { onCancel: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>Create an app</div>
      <div style={{ flex: 1 }} />
      <Button variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

function VerticalRow({ entry, onPick }: { entry: CatalogEntry; onPick: (s: Source) => void }) {
  const meta = verticalMeta(entry.slug);
  // An owned vertical shows its visibility; a not-yet-promoted one can't be installed
  // (provisioning would fail without a prod version) — point at the Verticals page instead.
  const subtitle = entry.owned
    ? entry.installable
      ? 'Your vertical'
      : 'No version in production yet — promote one from Verticals'
    : TEMPLATE_BLURBS[entry.slug] ?? `${meta.label} vertical`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 56, padding: '0 16px', borderBottom: '1px solid var(--border-subtle)' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: meta.accent }} />
      <span style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 8 }}>
          {entry.name}
          {entry.owned && <Pill kind={entry.listed ? 'success' : 'neutral'}>{entry.listed ? 'Published' : 'Private'}</Pill>}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{subtitle}</span>
      </span>
      <Button
        variant="secondary"
        size="sm"
        disabled={!entry.installable}
        onClick={() =>
          onPick({
            title: entry.name,
            engineLine: `${meta.label} · installed as your instance`,
            accent: meta.accent,
            defaultName: entry.name,
            verticalSlug: entry.slug,
          })
        }
      >
        Install
      </Button>
    </div>
  );
}

function ChooseVertical({
  catalog,
  onCancel,
  onPick,
}: {
  catalog: CatalogEntry[];
  onCancel: () => void;
  onPick: (s: Source) => void;
}) {
  // One registry, two lenses: the public marketplace, and what your team pushed
  // (which may ALSO be published — it stays in your group, badged, not duplicated).
  const marketplace = catalog.filter((e) => e.listed && !e.owned);
  const mine = catalog.filter((e) => e.owned);

  return (
    <Page maxWidth={720}>
      <Header onCancel={onCancel} />
      <Stepper step={1} />

      <div style={{ ...card, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 16px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Marketplace</span>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>ready to install</span>
        </div>
        {marketplace.length === 0 ? (
          <div style={{ padding: '20px 16px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>Nothing is published to the marketplace yet.</div>
        ) : (
          marketplace.map((entry) => <VerticalRow key={entry.slug} entry={entry} onPick={onPick} />)
        )}
      </div>

      {mine.length > 0 && (
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 16px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Your verticals</span>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>what your team pushed</span>
          </div>
          {mine.map((entry) => <VerticalRow key={entry.slug} entry={entry} onPick={onPick} />)}
        </div>
      )}

      <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
        Every install is your own instance — your data, your domain, upgraded only when you choose.
        Building your own?{' '}
        <a href="#/verticals">Import a repository or push from the CLI on Verticals →</a>
      </div>
    </Page>
  );
}

function Configure({ source, teamName, onBack, onCancel, onCreate, disabled }: { source: Source; teamName?: string; onBack: () => void; onCancel: () => void; onCreate: (i: { verticalSlug: string; name: string }) => Promise<void>; disabled: boolean }) {
  const [name, setName] = useState(source.defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const host = slugify(name);
  // The default hostname is `<app>-<team>.global.substrat.run` (provision.ts's
  // tenant-suffix scheme); teamless sessions fall back to the unsuffixed form.
  const suffix = `${teamName ? `-${slugify(teamName)}` : ''}.global.substrat.run`;

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onCreate({ verticalSlug: source.verticalSlug, name: name.trim() || source.defaultName });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Page maxWidth={720}>
      <Header onCancel={onCancel} />
      <Stepper step={2} />
      <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 12, borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: source.accent }} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              {source.title}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{source.engineLine}</div>
          </div>
          <div style={{ flex: 1 }} />
          <a href="#" onClick={(e) => { e.preventDefault(); onBack(); }} style={{ fontSize: 12.5 }}>Change</a>
        </div>

        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} hint="Prefilled from the vertical — you can rename later." />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-secondary)' }}>URL</div>
          <div style={{ display: 'flex', alignItems: 'center', height: 32, border: '1px solid var(--border-default)', borderRadius: 6, overflow: 'hidden', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>
            <span style={{ padding: '0 10px', lineHeight: '30px', color: 'var(--text-primary)', background: 'var(--surface-card)' }}>{host}</span>
            <span style={{ padding: '0 10px', lineHeight: '30px', color: 'var(--text-tertiary)', background: 'var(--surface-inset)', borderLeft: '1px solid var(--border-subtle)', flex: 1 }}>{suffix}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Live as soon as provisioning completes. Custom domains attach later.</div>
        </div>

        <Select label="Environment" options={ENV_OPTS} value="Production" style={{ width: 220 }} />

        {error && <div style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{error}</div>}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
          <Button onClick={submit} disabled={busy || disabled}>{busy ? 'Creating…' : 'Create app'}</Button>
          <Button variant="ghost" onClick={onBack}>Back</Button>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Appears in your grid immediately — provisions in the background.</div>
        </div>
      </div>
    </Page>
  );
}
