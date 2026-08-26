import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev ports sit in the demos' private 887x/527x block. :5275 is meridian's, :5279 and
// :5280 are ticket0's own fake customer sites, so the app takes :5281.
const WEB_PORT = Number(process.env.WEB_PORT ?? 5281);
const API_PORT = Number(process.env.PORT ?? 8874);

export default defineConfig({
  plugins: [react()],
  server: {
    port: WEB_PORT,
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        /**
         * Explicitly false, and it has to be said out loud.
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
