import { useEffect, useState } from 'react';
import { PageHeader } from '@substrat-run/ui';
import { issuerSettings, setIssuerSettings } from '../api';
import { useThemeForm } from './applications/client-forms';

/**
 * `/branding` — how this issuer's hosted screens look, for every application that does not say
 * otherwise, and for the screens with no application behind them (an invitation, a password
 * reset). Written to the declared config key `ISSUER_THEME`, so there is one answer whether it
 * was set here, on the platform's Env tab or as a `wrangler` var.
 */
export function BrandingView() {
  const [stored, setStored] = useState<Record<string, unknown> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void issuerSettings()
      .then((s) => setStored(s.issuerTheme))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <>
      <PageHeader title="Branding" description="How sign-in looks for everyone this issuer serves." />
      {err && <p className="error">{err}</p>}
      {stored ? <BrandingForm stored={stored} /> : !err && <p className="muted">Loading…</p>}
    </>
  );
}

function BrandingForm({ stored }: { stored: Record<string, unknown> }) {
  const theme = useThemeForm(
    stored,
    'The look of every hosted screen. An application can override any of it on its own Branding tab.',
  );
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setErr(null);
    setSaved(false);
    setBusy(true);
    try {
      await setIssuerSettings({ issuerTheme: theme.build(stored) ?? {} });
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel editor">
      {theme.view}
      {err && <p className="error">{err}</p>}
      {saved && <p className="notice">Saved. It applies the next time a screen is opened.</p>}
      <div className="row">
        <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>Save</button>
        <a className="btn" href="/login" target="_blank" rel="noreferrer">Open the sign-in screen</a>
      </div>
    </section>
  );
}
