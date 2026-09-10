import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev ports in the private 887x/527x block. The app is :5276, the API on :8876; the
// same two vars drive src/server.ts, so `PORT=… WEB_PORT=…` moves both ends together.
const WEB_PORT = Number(process.env.WEB_PORT ?? 5276);
const API_PORT = Number(process.env.PORT ?? 8876);

export default defineConfig({
  plugins: [react()],
  server: {
    port: WEB_PORT,
    proxy: {
      // `changeOrigin: false`, written out. Vite's string shorthand expands to
      // `{ target, changeOrigin: true }`, which rewrites Host — and the API derives
      // its OIDC `redirect_uri` from the Host it is handed, so the login callback
      // would come back to the API's port, where this app is not (#1388).
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: false },
    },
  },
});
