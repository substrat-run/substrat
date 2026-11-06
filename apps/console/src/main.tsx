import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@substrat-run/elements';
import '@substrat-run/elements/controls';
import './wa';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
