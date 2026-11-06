/** The shell: theme, top bar, user menu and hash routing. Screens live in `screens.ts`. */
import { html, render } from 'lit';
import '@substrat-run/elements';
import '@substrat-run/elements/controls';
import '@substrat-run/elements/themes/base.css';
import '@substrat-run/elements/themes/native.css';
import '@substrat-run/elements/themes/ledger.css';
import './style.css';
import { screens } from './screens.js';

const root = document.getElementById('root')!;

function draw(): void {
  const path = location.hash.replace(/^#\/?/, '').split('?')[0];
  const current = screens.find((s) => s.path === path) ?? screens[0]!;
  render(
    html`
      <header class="bar">
        <nav>
          ${screens.map(
            (s) => html`<a href="#/${s.path}" aria-current=${s === current ? 'page' : 'false'}>${s.label}</a>`,
          )}
        </nav>
        <sub-user-menu show="name"></sub-user-menu>
      </header>
      <main>${current.render()}</main>
    `,
    root,
  );
}

addEventListener('hashchange', draw);
draw();
