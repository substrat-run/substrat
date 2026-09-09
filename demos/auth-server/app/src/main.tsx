import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Order is load-bearing, not alphabetical: `tokens.css` is the theming contract every
// relying party's stored theme is applied through, so it is loaded LAST and wins the one
// custom property the two sets share (`--radius-lg`). See console/console.css.
import './console/console.css';
import './tokens.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
