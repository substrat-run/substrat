/**
 * Settings: the theme and light/dark choice, each theme shown as a live preview.
 *
 * A preview is real theme tokens, not a picture: the card carries the theme's classes,
 * and Web Awesome's theme rules re-declare the derived tokens on any element with
 * `wa-theme-default` + `wa-light`/`wa-dark`, so the theme applies inside the card
 * whatever the page around it uses.
 */
import { isDark, setAppearance, THEMES, useAppearance, type Mode, type ThemeId } from './appearance.js';

const MODES: { id: Mode; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
];

const valueOf = (e: { target: EventTarget | null }) => (e.target as HTMLInputElement).value;

export function Settings() {
  const { theme, mode } = useAppearance();
  const shade = isDark(mode) ? 'wa-dark' : 'wa-light';
  return (
    <>
      <a className="back" href="#/">
        ← all lists
      </a>
      <h2 style={{ marginTop: '.6rem' }}>Settings</h2>
      <p className="sub">How the app looks for you. Kept in this browser.</p>

      <section className="settings">
        <wa-radio-group
          label="Theme"
          name="theme"
          value={theme}
          onInput={(e) => setAppearance({ theme: valueOf(e) as ThemeId })}
        >
          {THEMES.map((t) => (
            <wa-radio key={t.id} value={t.id} class="theme-card">
              <span className={`preview wa-theme-default ${shade} ${t.className} ${t.preview}`} aria-hidden="true">
                <span className="preview-bar">
                  <span className="preview-title">Aa</span>
                  <span className="preview-button" />
                </span>
                <span className="preview-row">
                  <span className="preview-line" />
                  <span className="preview-chip" />
                </span>
                <span className="preview-row">
                  <span className="preview-line short" />
                  <span className="preview-chip quiet" />
                </span>
              </span>
              <span className="theme-name">{t.label}</span>
              <span className="theme-blurb">{t.blurb}</span>
            </wa-radio>
          ))}
        </wa-radio-group>

        <wa-radio-group
          label="Appearance"
          name="mode"
          orientation="horizontal"
          value={mode}
          hint="System follows your device’s light or dark setting."
          onInput={(e) => setAppearance({ mode: valueOf(e) as Mode })}
        >
          {MODES.map((m) => (
            <wa-radio key={m.id} value={m.id} appearance="button">
              {m.label}
            </wa-radio>
          ))}
        </wa-radio-group>
      </section>
    </>
  );
}
