import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev ports sit in the demos' private 887x/527x block, clear of the Vite (5173)
// and Wrangler (8787) defaults. The same two vars drive src/server.ts, so
// `PORT=… WEB_PORT=… pnpm dev` moves both ends of the proxy together.
const WEB_PORT = Number(process.env.WEB_PORT ?? 5278);
const API_PORT = Number(process.env.PORT ?? 8878);

export default defineConfig({
  plugins: [react()],
  server: {
    port: WEB_PORT,
    proxy: { '/api': `http://localhost:${API_PORT}` },
  },
});
