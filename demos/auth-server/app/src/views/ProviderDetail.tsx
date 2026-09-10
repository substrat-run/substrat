import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from '@substrat-run/ui';
import {
  identityProviders,
  removeIdentityProvider,
  type ConfiguredProvider,
  type ProviderCatalogueEntry,
} from '../api';
import { navigate } from '../console/router';
import { PROVIDERS_PATH } from '../console/routes';
import { ProviderEditor } from './Providers';

/**
 * `/providers/:providerId` — one upstream directory this issuer signs people in through.
 * Everything a provider is was edited in a form that unfolded UNDER the table: a client id, a
 * secret, a tenant or issuer URL and three decisions with real consequences (one of them
 * "trust this provider's email addresses"), with no URL of its own. So the credentials an
 * operator was reading could not be linked to, survived neither a reload nor a sign-in, and
 * sat on top of the list they were comparing against.
 *
 * The read is the same one the list uses — `/api/admin/providers` returns the catalogue and
 * the configured rows together, and this screen deliberately adds no per-provider GET: there
 * are four catalogue entries and a handful of rows, and a second server surface for a `find`
 * is a surface to authorize, test and keep in step for no new fact.
 *
 * An id is a place here whether or not it is configured yet. A catalogue entry nobody has
 * enabled has an id all the same, so `/providers/google` is the screen that enables Google —
 * the same screen that afterwards edits it. Only the custom OIDC provider nobody has named
 * yet has no id, and it is therefore still added on the list.
 *
 * The nav is not the gate here — every call below is refused server-side by session + the
 * `admin` role, and this component simply is not rendered for anyone else.
 */
export function ProviderDetailView({ providerId, issuer }: { providerId: string; issuer: string | null }) {
  const [state, setState] = useState<{
    entry: ProviderCatalogueEntry | null;
    provider: ConfiguredProvider | null;
  } | null | 'missing'>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const read = await identityProviders();
      const entry = read.catalogue.find((e) => e.id === providerId) ?? null;
      const provider = read.providers.find((p) => p.id === providerId) ?? null;
      // Neither half knows this id: not a provider this issuer ships an editor for, and not one
      // an operator configured. There is nothing to show and nothing to enable.
      setState(entry || provider ? { entry, provider } : 'missing');
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [providerId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A pasted link to a custom provider that has since been removed. It is a real outcome of the
  // feature — the link outlives the row — so it gets an answer rather than a spinner that never
  // resolves.
  if (state === 'missing') {
    return (
      <EmptyState
        title="No such provider"
        description={`Nothing here is configured as “${providerId}”, and this issuer ships no editor for that name. It may have been removed since this link was shared.`}
        action={
          <button className="btn primary" style={{ width: 'auto' }} onClick={() => navigate(PROVIDERS_PATH)}>
            Back to Sign-in providers
          </button>
        }
      />
    );
  }

  return (
    <>
      <button
        className="btn link"
        style={{ justifySelf: 'start', padding: 0 }}
        onClick={() => navigate(PROVIDERS_PATH)}
      >
        ← Sign-in providers
      </button>
      {err && <p className="error">{err}</p>}
      {/* A failed read is an error state, not a pending one. Saying "Loading…" underneath the
          error would tell an operator to keep waiting for a request that already came back. */}
      {state === null ? (
        !err && <p className="muted">Loading this provider…</p>
      ) : (
        <>
          {state.provider && <ProviderHeader entry={state.entry} provider={state.provider} issuer={issuer} />}
          <section className="panel">
            <div className="panel-head">
              <h2>{state.provider ? 'Credentials' : 'Enable this provider'}</h2>
            </div>
            {/* No key needed here: the whole view is keyed by `providerId` at its call site, so
                one provider's unsaved credentials cannot outlive a move to another. */}
            <ProviderEditor
              issuer={issuer}
              entry={state.entry}
              provider={state.provider}
              onSaved={async () => {
                await reload();
              }}
            />
          </section>
          {state.provider && <ProviderActions provider={state.provider} entry={state.entry} />}
        </>
      )}
    </>
  );
}

/* ---- what this provider is ---- */

function ProviderHeader({
  entry, provider, issuer,
}: {
  entry: ProviderCatalogueEntry | null;
  provider: ConfiguredProvider;
  issuer: string | null;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          {entry?.label ?? provider.label ?? provider.id}{' '}
          {!entry && provider.issuer && <span className="tag">custom OIDC</span>}
        </h2>
      </div>
      <dl className="kv">
        <dt>Provider ID</dt>
        {/* The callback path segment, and therefore the one string that has to match what was
            registered upstream. Fixed once saved, which is why it is a fact here rather than a
            field below. */}
        <dd><code>{provider.id}</code></dd>
        <dt>Status</dt>
        <dd>
          {provider.disabled ? <span className="tag warn">disabled</span> : 'enabled'}
          {provider.allowSignup && <span className="tag">creates accounts</span>}
          {provider.trustEmail && <span className="tag">trusted email</span>}
        </dd>
        <dt>Client ID</dt>
        <dd><code>{provider.clientId}</code></dd>
        {provider.issuer && (
          <>
            <dt>Issuer URL</dt>
            <dd><code>{provider.issuer}</code></dd>
          </>
        )}
        {provider.tenantId && (
          <>
            <dt>Tenant</dt>
            <dd><code>{provider.tenantId}</code></dd>
          </>
        )}
        <dt>Redirect URI</dt>
        <dd>
          <code>
            {(issuer ?? window.location.origin).replace(/\/$/, '')}
            {provider.callbackPath}
          </code>
        </dd>
        <dt>Last changed</dt>
        {/* `updatedAt` is epoch milliseconds, and null for a row that predates the column. */}
        <dd>{provider.updatedAt ? new Date(provider.updatedAt).toLocaleString() : '—'}</dd>
      </dl>
    </section>
  );
}

/* ---- the lever that is not a field ---- */

function ProviderActions({
  provider, entry,
}: { provider: ConfiguredProvider; entry: ProviderCatalogueEntry | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const name = entry?.label ?? provider.label ?? provider.id;

  return (
    <section className="panel">
      <div className="panel-head"><h2>Actions</h2></div>
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button
          className="btn danger"
          disabled={busy}
          onClick={() =>
            void (async () => {
              if (!window.confirm(`Remove ${name}? People who signed in with it will need another way in.`)) return;
              setBusy(true);
              setErr(null);
              try {
                await removeIdentityProvider(provider.id);
                // Back to the list rather than staying on a screen whose row is gone. A
                // catalogue entry's screen would still be a place — it would offer to enable
                // the provider again — which is the wrong answer to a removal just made.
                navigate(PROVIDERS_PATH);
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
                setBusy(false);
              }
            })()
          }
        >
          Remove
        </button>
      </div>
      <p className="muted small">
        Removing takes the button off the login screen and forgets the credentials. To keep them
        and only hide the button, tick <strong>Disabled</strong> above instead.
      </p>
    </section>
  );
}
