import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The 887x API block is full (8871–8878 taken, 8879 is the dev issuer's own default), so
// tock sits just past it. The same two vars drive src/server.ts, so `PORT=… WEB_PORT=…
// pnpm dev` moves both ends of the proxy together.
const WEB_PORT = Number(process.env.WEB_PORT ?? 5280);
const API_PORT = Number(process.env.PORT ?? 8880);

export default defineConfig({
  plugins: [react()],
  server: {
    port: WEB_PORT,
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        // EXPLICITLY false, and it has to be: the API derives its OIDC `redirect_uri` from
        // the forwarded Host header, so a rewritten Host sends the login callback to the API
        // port instead of back here — you sign in and land on a 404. Vite's string shorthand
        // does not leave the header alone, which is the trap: writing no option at all reads
        // like "unchanged" and is not.
        changeOrigin: false,
      },
    },
  },
});
