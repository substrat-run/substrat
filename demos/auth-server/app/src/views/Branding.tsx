import { useEffect, useState } from 'react';
import { PageHeader } from '@substrat-run/ui';
import { issuerSettings, setIssuerSettings, type IssuerSettings } from '../api';
import { useThemeForm } from './applications/client-forms';

/**
 * `/branding` — how this issuer's hosted screens look, for every application that does not say
 * otherwise, and for the screens with no application behind them (an invitation, a password
 * reset). Written to the declared config key `ISSUER_THEME`, so there is one answer whether it
 * was set here, on the platform's Env tab or as a `wrangler` var.
 */
export function BrandingView() {
  const [settings, setSettings] = useState<IssuerSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void issuerSettings()
      .then(setSettings)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <>
      <PageHeader title="Branding" description="How sign-in looks for everyone this issuer serves." />
      {err && <p className="error">{err}</p>}
      {settings ? <BrandingForm settings={settings} /> : !err && <p className="muted">Loading…</p>}
    </>
  );
}

function BrandingForm({ settings }: { settings: IssuerSettings }) {
  const stored = settings.issuerTheme;
  const [defaultLocale, setDefaultLocale] = useState(settings.defaultLocale);
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
      await setIssuerSettings({ issuerTheme: theme.build(stored) ?? {}, defaultLocale });
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel editor">
      <label className="field">
        <span>Default language</span>
        <select value={defaultLocale} onChange={(e) => setDefaultLocale(e.target.value as IssuerSettings['defaultLocale'])}>
          <option value="sv">Svenska</option>
          <option value="en">English</option>
        </select>
        <em className="hint">
          Used when a browser offers neither language, and for mail with no browser behind it, such as an invitation.
          Anyone signing in can switch language at the foot of the screen.
        </em>
      </label>
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
