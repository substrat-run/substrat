import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev ports sit in the demos' private 887x/527x block, clear of the Vite (5173)
// and Wrangler (8787) defaults. The same two vars drive src/server.ts, so
// `PORT=… WEB_PORT=… pnpm dev` moves both ends of the proxy together.
const WEB_PORT = Number(process.env.WEB_PORT ?? 5278);
const API_PORT = Number(process.env.PORT ?? 8878);
// The Notes plugin's API, when `pnpm --filter @substrat-run/demo-notes dev` runs it beside this app.
const NOTES_API_PORT = Number(process.env.NOTES_API_PORT ?? 8881);

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
      // The plugin's notes on this app's items, from the same origin, so the session cookie goes
      // with them. Deployed, a plugin is another origin, and this is the open question of how its
      // screens appear inside the app it belongs to (docs/rfc/dependent-people.md).
      '/plugins/notes/api': {
        target: `http://localhost:${NOTES_API_PORT}`,
        rewrite: (path) => path.replace(/^\/plugins\/notes/, ''),
        changeOrigin: false,
      },
    },
  },
});
