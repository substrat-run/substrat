import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@substrat-run/ui/wa/register';
import '@substrat-run/ui/styles.css';
import '@substrat-run/ui/wa.css';
import './app.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
