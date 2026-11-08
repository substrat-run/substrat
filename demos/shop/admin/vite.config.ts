import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The admin dashboard is its own app on its own port, next to the storefront
// (:5273). Both proxy /api to the same server — one kernel, one permission
// check. Ports live in the private 887x/527x block; override with
// ADMIN_PORT=… PORT=… pnpm dev
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 5274);
const API_PORT = Number(process.env.PORT ?? 8873);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5273);

export default defineConfig({
  plugins: [react()],
  // The "Butiken" link needs the storefront's origin at build time; deriving it
  // from WEB_PORT keeps the two apps in step when either port moves.
  define: {
    __STOREFRONT_ORIGIN__: JSON.stringify(`http://localhost:${WEB_PORT}`),
  },
  server: {
    port: ADMIN_PORT,
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
      // would come back to the API's port, where this back-office is not (#1388).
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: false },
    },
  },
});
