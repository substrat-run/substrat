import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev ports sit in a private 887x/527x block, clear of the Vite (5173) and
// Wrangler (8787) defaults that every other project on the machine also wants.
// The same two vars drive src/server.ts, so `PORT=… WEB_PORT=… pnpm dev` moves
// both ends of the proxy together.
const WEB_PORT = Number(process.env.WEB_PORT ?? 5272);
const API_PORT = Number(process.env.PORT ?? 8872);

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
      '/api': {
        target: `http://localhost:${API_PORT}`,
        /**
         * Explicitly false, and it has to be said out loud — ticket0 carries the same
         * note for the same reason.
         *
         * The API derives its OIDC `redirect_uri` from the Host header it receives, so
         * a rewritten Host sends the login callback to the API's own port — where the
         * app is not — and the round-trip ends on a 404. Vite's shorthand string form
         * rewrote it, which is why this is the object form with the flag written down
         * rather than left to a default.
         */
        changeOrigin: false,
      },
    },
  },
});
