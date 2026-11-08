import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev ports in the private 887x/527x block. The employee app is :5275, the API
// on :8875; the same two vars drive src/server.ts, so `PORT=… WEB_PORT=…` moves
// both ends of the proxy together. The (future) admin web app takes :5276.
const WEB_PORT = Number(process.env.WEB_PORT ?? 5275);
const API_PORT = Number(process.env.PORT ?? 8875);

export default defineConfig({
  plugins: [react()],
  server: {
    port: WEB_PORT,
    // The API keeps its scopes' SQLite databases in this demo's `.data/`, inside the root Vite
    // serves files from: without this, `/@fs/…/.data/<scope>.sqlite` answers 200 to anyone who
    // can reach this port. `deny` REPLACES Vite's own list, so its defaults are written out first
    // (`pnpm lint:vite-proxy` holds both halves).
    fs: {
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem,key,p12,pfx,cer,der}',
        '.npmrc',
        '.yarnrc.yml',
        '**/.git/**',
        '**/.data/**',
        '*.{sqlite,sqlite-shm,sqlite-wal}',
      ],
    },
    proxy: {
      // `changeOrigin: false`, written out. Vite's string shorthand expands to
      // `{ target, changeOrigin: true }`, which rewrites Host — and the API derives
      // its OIDC `redirect_uri` from the Host it is handed, so the login callback
      // would come back to the API's port, where this app is not (#1388).
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: false },
    },
  },
});
