import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev ports sit in a private 887x/527x block, clear of the Vite (5173) and
// Wrangler (8787) defaults that every other project on the machine also wants.
// The same two vars drive src/server.ts, so `PORT=… WEB_PORT=… pnpm dev` moves
// both ends of the proxy together.
const WEB_PORT = Number(process.env.WEB_PORT ?? 5273);
const API_PORT = Number(process.env.PORT ?? 8873);
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 5274);

export default defineConfig({
  plugins: [react()],
  // Staff who land on the storefront get a hand-off link to the back-office;
  // deriving it from ADMIN_PORT keeps the two apps in step when either moves.
  define: {
    __ADMIN_ORIGIN__: JSON.stringify(`http://localhost:${ADMIN_PORT}`),
  },
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
      // would come back to the API's port, where this storefront is not (#1388).
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: false },
    },
  },
});
