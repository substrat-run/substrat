import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev ports sit in a private 887x/527x block, clear of the Vite (5173) and
// Wrangler (8787) defaults. The same vars drive src/server.ts, so
// `PORT=… CONSOLE_PORT=… pnpm dev` moves both ends of the proxy together.
const CONSOLE_PORT = Number(process.env.CONSOLE_PORT ?? 5278);
const API_PORT = Number(process.env.PORT ?? 8877);

export default defineConfig({
  plugins: [react()],
  server: {
    port: CONSOLE_PORT,
    proxy: {
      // `changeOrigin: false`, written out. Vite's string shorthand expands to
      // `{ target, changeOrigin: true }`, which rewrites Host — and the API derives
      // its OIDC `redirect_uri` from the Host it is handed, so the login callback
      // would come back to the API's port, where this console is not (#1388).
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: false },
    },
  },
});
