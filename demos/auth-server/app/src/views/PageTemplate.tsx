import { useEffect, useRef, useState } from 'react';
import { PAGE_TEMPLATE_PREVIEW_URL, pageTemplate, removePageTemplate, setPageTemplate } from '../api';

/**
 * The install's page template (#3350, `src/page-template.ts`, `PAGE-TEMPLATES.md`): an HTML
 * document in Liquid that every hosted screen is drawn inside, as Auth0's Universal Login page
 * templates are.
 *
 * The preview is a real page: the draft is posted as a form into the frame, so the sign-in app
 * boots inside it exactly as on the hosted page, drawing the chosen screen with the issuer's
 * theme and sample data. A save is judged on every screen in both languages; a template that
 * fails anywhere is refused with the reason.
 */

const SCREENS = [
  ['login', 'Sign in'],
  ['signup', 'Sign up'],
  ['consent', 'Consent'],
  ['reset-password', 'Reset password'],
  ['accept-invitation', 'Invitation'],
  ['github-email', 'GitHub address'],
] as const;

/** A starting point, so the two required tags and the variables are on screen from the start. */
const EXAMPLE = `<!DOCTYPE html>
<html lang="{{ locale }}">
  <head>
    {%- auth0:head -%}
    <title>{% if application %}{{ application.name }}{% else %}{{ tenant.friendly_name }}{% endif %}</title>
    <style>
      body { display: flex; flex-direction: column; min-height: 100vh; background: {{ branding.colors.page_background | default: "#f4f5f7" }}; }
      header, footer { padding: 16px 24px; }
      main { flex: 1; display: grid; place-items: center; }
      footer { font-size: 12px; opacity: 0.7; }
    </style>
  </head>
  <body class="screen-{{ prompt.screen.name }}">
    <header>
      {% if branding.logo_url %}<img src="{{ branding.logo_url }}" alt="" height="32">{% endif %}
    </header>
    <main>
      {%- auth0:widget -%}
    </main>
    <footer>
      {% if locale == "sv" %}Behöver du hjälp? Kontakta oss.{% else %}Need help? Contact us.{% endif %}
    </footer>
  </body>
</html>
`;

export function PageTemplatePanel() {
  const [stored, setStored] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [screen, setScreen] = useState<(typeof SCREENS)[number][0]>('login');
  const [locale, setLocale] = useState<'sv' | 'en'>('en');
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    void pageTemplate()
      .then((t) => {
        setStored(t);
        setDraft(t ?? '');
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  // Redraw the preview a moment after the draft, screen or language last changed.
  useEffect(() => {
    if (stored === undefined || !draft.trim()) return;
    const timer = setTimeout(() => form.current?.submit(), 400);
    return () => clearTimeout(timer);
  }, [draft, screen, locale, stored]);

  const act = async (fn: () => Promise<void>, done: string) => {
    setErr(null);
    setNotice(null);
    setBusy(true);
    try {
      await fn();
      setNotice(done);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    act(async () => {
      await setPageTemplate(draft);
      setStored(draft);
    }, 'Saved. It applies the next time a screen is opened.');

  const reset = () => {
    if (!window.confirm('Remove the page template? Every screen goes back to the built-in page.')) return;
    void act(async () => {
      await removePageTemplate();
      setStored(null);
      setDraft('');
    }, 'Removed. The screens use the built-in page again.');
  };

  if (stored === undefined) return err ? <p className="error">{err}</p> : <p className="muted">Loading…</p>;

  return (
    <section className="panel editor page-template">
      <h2>Page template</h2>
      <p className="muted">
        An HTML page in Liquid that every sign-in screen is drawn inside, written the way Auth0's Universal Login page
        templates are. It must contain <code>{'{%- auth0:head -%}'}</code> in its head and{' '}
        <code>{'{%- auth0:widget -%}'}</code> where the sign-in form goes. Without a template the screens use the
        built-in page, and <code>/login?builtin=0</code> always does.
      </p>
      <label className="field">
        <span>Template</span>
        <textarea
          value={draft}
          rows={18}
          spellCheck={false}
          placeholder="No template: the built-in page is used."
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      <div className="row">
        {!draft.trim() && (
          <button type="button" className="btn" onClick={() => setDraft(EXAMPLE)}>
            Start from an example
          </button>
        )}
        <label className="field inline">
          <span>Preview</span>
          <select value={screen} onChange={(e) => setScreen(e.target.value as typeof screen)}>
            {SCREENS.map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </label>
        <label className="field inline">
          <span>Language</span>
          <select value={locale} onChange={(e) => setLocale(e.target.value as typeof locale)}>
            <option value="en">English</option>
            <option value="sv">Svenska</option>
          </select>
        </label>
      </div>
      {draft.trim() ? (
        <>
          <form ref={form} method="post" action={`${PAGE_TEMPLATE_PREVIEW_URL}?ui_locales=${locale}`} target="page-template-preview" hidden>
            <input type="hidden" name="template" value={draft} />
            <input type="hidden" name="screen" value={screen} />
            <input type="hidden" name="locale" value={locale} />
          </form>
          <iframe
            name="page-template-preview"
            title="Page template preview"
            className="page-template-preview"
            sandbox="allow-scripts allow-same-origin"
          />
        </>
      ) : (
        <p className="muted">Nothing to preview: the screens use the built-in page.</p>
      )}
      {err && <p className="error">{err}</p>}
      {notice && <p className="notice">{notice}</p>}
      <div className="row">
        <button type="button" className="btn primary" disabled={busy || !draft.trim() || draft === stored} onClick={() => void save()}>
          Save template
        </button>
        <button type="button" className="btn" disabled={busy || stored === null} onClick={reset}>
          Reset to default
        </button>
      </div>
    </section>
  );
}
