import { useState } from 'react';
import { Button, Input, Select } from '@substrat-run/ui';
import { type AppAuthChoice, type AppRow, type CatalogEntry, type EnvVarSpec } from '../lib/api';
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
  /** The vertical's declared config fields (#426) — rendered on the Configure step so
   *  first-run values ride WITH provisioning instead of a later Env-tab save. */
  envSpec: EnvVarSpec[];
  /** Declared capabilities (#427): an `oidc-issuer` PROVIDER gets no Identity section
   *  (an issuer doesn't delegate to another issuer); a REQUIRER's Identity section is
   *  its declared delegation seam. */
  provides: string[];
  requires: string[];
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
  authServers,
  onCancel,
  onCreate,
}: {
  catalog: CatalogEntry[];
  /** The current team's display name — slugified into the hostname preview, mirroring the worker. */
  teamName?: string;
  /** The team's ACTIVE Auth Server apps — offered as one-click issuers in the Identity section. */
  authServers: AppRow[];
  onCancel: () => void;
  onCreate: (input: { verticalSlug: string; name: string; auth?: AppAuthChoice; config?: Record<string, string> }) => Promise<void>;
}) {
  const [source, setSource] = useState<Source | null>(null);

  if (!source) {
    return <ChooseVertical catalog={catalog} onCancel={onCancel} onPick={setSource} />;
  }
  return <Configure source={source} teamName={teamName} authServers={authServers} onBack={() => setSource(null)} onCancel={onCancel} onCreate={onCreate} disabled={catalog.length === 0} />;
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
            envSpec: entry.envSpec ?? [],
            provides: entry.provides ?? [],
            requires: entry.requires ?? [],
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

function Configure({ source, teamName, authServers, onBack, onCancel, onCreate, disabled }: { source: Source; teamName?: string; authServers: AppRow[]; onBack: () => void; onCancel: () => void; onCreate: (i: { verticalSlug: string; name: string; auth?: AppAuthChoice; config?: Record<string, string> }) => Promise<void>; disabled: boolean }) {
  const [name, setName] = useState(source.defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The Identity picker (below) OWNS auth config: for a vertical that declares
  // `requires: ['oidc-issuer']`, its auth env keys are marked `identityManaged` and the
  // picker (Built-in / an Auth Server / External OIDC) supersedes them — so drop them from
  // the raw config form rather than offer two contradictory ways to set the same thing (nor
  // deliver their defaults, which would pin auth behind the picker's back). They stay on
  // the post-install Env tab as the hand-edit fallback. `identityApplies` is false for an
  // `oidc-issuer` PROVIDER itself — an issuer doesn't delegate to another issuer.
  const identityApplies = !source.provides.includes('oidc-issuer') && source.verticalSlug !== 'auth-server';
  const formSpecs = source.envSpec.filter((s) => !(identityApplies && s.identityManaged));
  // The vertical's declared config (#426), collected HERE so first-run values ride with
  // provisioning — the instance is born configured (an issuer with its admin) instead of
  // live-but-unconfigured until someone finds the Env tab. Non-secrets prefill their
  // declared default; secrets always start blank. Only the VISIBLE (non-identity) specs,
  // so an identity-managed key's default is never delivered as an install override.
  const [config, setConfig] = useState<Record<string, string>>(() =>
    Object.fromEntries(formSpecs.map((s) => [s.key, s.secret ? '' : s.default ?? ''])),
  );
  const requiredMissing = formSpecs.filter((s) => s.required && !(config[s.key] ?? '').trim());
  const configGroups = new Map<string, EnvVarSpec[]>();
  for (const s of formSpecs) {
    const g = s.group ?? 'Configuration';
    (configGroups.get(g) ?? configGroups.set(g, []).get(g)!).push(s);
  }
  const host = slugify(name);
  // The default hostname is `<app>-<team>.global.substrat.run` (provision.ts's
  // tenant-suffix scheme); teamless sessions fall back to the unsuffixed form.
  const suffix = `${teamName ? `-${slugify(teamName)}` : ''}.global.substrat.run`;

  // The Identity choice (vertical-auth-detach.md §2.4). 'builtin' = the vertical's own
  // auth (the safe default — every vertical supports it); an issuer app = one-click SSO
  // (the client is registered there automatically); 'external' = any OIDC issuer,
  // configured by hand. `identityApplies` (computed above, where it also gates the
  // identity-managed env fields) is false for an `oidc-issuer` PROVIDER itself (#427,
  // capability-declared — the legacy `auth-server` slug is grandfathered): an issuer
  // doesn't authenticate against another issuer.
  //
  // A declared requirer (#427): the Identity section is the vertical's own delegation
  // seam, so say so — the offer is capability-driven, not a generic form section.
  const declaresOidc = source.requires.includes('oidc-issuer');
  const [identity, setIdentity] = useState('builtin');
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [audience, setAudience] = useState('');
  const identityOptions = [
    { value: 'builtin', label: 'Built-in — this app manages its own users' },
    ...authServers.map((a) => ({ value: a.app_scope_id, label: `Auth Server — ${a.name}` })),
    { value: 'external', label: 'External OIDC issuer…' },
  ];

  const authChoice = (): AppAuthChoice | undefined => {
    if (!identityApplies || identity === 'builtin') return undefined;
    if (identity === 'external') {
      return {
        source: 'external',
        issuer: issuer.trim(),
        clientId: clientId.trim(),
        ...(clientSecret ? { clientSecret } : {}),
        ...(audience.trim() ? { audience: audience.trim() } : {}),
      };
    }
    return { source: 'auth-server', scopeId: identity };
  };
  const externalIncomplete = identity === 'external' && (!issuer.trim() || !clientId.trim());

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    // Only touched fields ride: an empty optional stays undelivered, so the vertical's
    // own defaults apply instead of an explicit empty string overriding them.
    const filled = Object.fromEntries(Object.entries(config).filter(([, v]) => v.trim() !== ''));
    try {
      await onCreate({
        verticalSlug: source.verticalSlug,
        name: name.trim() || source.defaultName,
        auth: authChoice(),
        ...(Object.keys(filled).length > 0 ? { config: filled } : {}),
      });
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

        {[...configGroups.entries()].map(([group, specs]) => (
          <div key={group} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)', paddingTop: 4 }}>{group}</div>
            {specs.map((s) => (
              <Input
                key={s.key}
                label={`${s.label ?? s.key}${s.required ? '' : ' (optional)'}`}
                type={s.secret ? 'password' : 'text'}
                value={config[s.key] ?? ''}
                onChange={(e) => setConfig((m) => ({ ...m, [s.key]: e.target.value }))}
                placeholder={s.placeholder ?? ''}
                hint={s.description}
                style={{ maxWidth: 420 }}
              />
            ))}
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              Delivered with provisioning, so the app starts configured. Editable later under Settings → Environment.
            </div>
          </div>
        ))}

        {identityApplies && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Select
              label="Identity"
              options={identityOptions}
              value={identity}
              onChange={(e) => setIdentity(e.target.value)}
              style={{ maxWidth: 420 }}
            />
            {declaresOidc && identity === 'builtin' && (
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                This app can delegate sign-in to an OIDC issuer — pick one of your issuer apps for team-wide SSO, or keep built-in accounts.
              </div>
            )}
            {identity !== 'builtin' && identity !== 'external' && (
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                Users sign in through this Auth Server — the app is registered there automatically when it's created.
              </div>
            )}
            {identity === 'external' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Input label="Issuer URL" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="https://auth.example.com" hint={`Register the redirect URL https://${host}.global.substrat.run/api/auth/callback at your issuer.`} />
                <div style={{ display: 'flex', gap: 10 }}>
                  <Input label="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} style={{ flex: 1 }} />
                  <Input label="Client secret" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} style={{ flex: 1 }} />
                </div>
                <Input label="Audience (optional)" value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="https://api.example.com" hint="Expected `aud` claim of verified tokens — issuer-dependent." style={{ maxWidth: 420 }} />
              </div>
            )}
          </div>
        )}

        {error && <div style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{error}</div>}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
          <Button onClick={submit} disabled={busy || disabled || externalIncomplete || requiredMissing.length > 0}>{busy ? 'Creating…' : 'Create app'}</Button>
          {requiredMissing.length > 0 && !busy && (
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              Fill {requiredMissing.map((s) => s.label ?? s.key).join(', ')} to continue.
            </span>
          )}
          <Button variant="ghost" onClick={onBack}>Back</Button>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Appears in your grid immediately — provisions in the background.</div>
        </div>
      </div>
    </Page>
  );
}
