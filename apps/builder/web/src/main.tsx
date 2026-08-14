import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Design-system tokens first (the handoff's tokens are byte-identical to the ui
// package's — consume, never copy), then the studio's own classes over them.
import '@substrat-run/ui/styles.css';
import { App } from './App.js';
import './styles.css';

// Theme follows the OS by default; the top-bar toggle overrides per handoff.
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme(dark: boolean): void {
	document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
}
applyTheme(prefersDark.matches);
prefersDark.addEventListener('change', (e) => {
	if (!localStorage.getItem('builder-theme')) applyTheme(e.matches);
});
const saved = localStorage.getItem('builder-theme');
if (saved) applyTheme(saved === 'dark');

createRoot(document.getElementById('root') as HTMLElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
