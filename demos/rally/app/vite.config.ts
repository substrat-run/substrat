import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Private 887x/527x block. `PORT=… PLAYER_PORT=… pnpm dev` moves both ends.
const PLAYER_PORT = Number(process.env.PLAYER_PORT ?? 5277);
const API_PORT = Number(process.env.PORT ?? 8877);

export default defineConfig({
  plugins: [react()],
  server: {
    port: PLAYER_PORT,
    proxy: {
      // `changeOrigin: false`, written out. Vite's string shorthand expands to
      // `{ target, changeOrigin: true }`, which rewrites Host — and the API derives
      // its OIDC `redirect_uri` from the Host it is handed, so the login callback
      // would come back to the API's port, where this app is not (#1388).
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: false },
    },
  },
});
