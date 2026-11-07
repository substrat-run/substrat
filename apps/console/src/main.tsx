import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@substrat-run/ui/wa/register';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
