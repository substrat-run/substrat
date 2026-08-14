import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Ports live in the private 887x/527x block (CLAUDE.md): API 8879, web 5279.
const API = process.env.BUILDER_API ?? 'http://127.0.0.1:8879';

export default defineConfig({
	plugins: [react()],
	server: {
		port: Number(process.env.WEB_PORT ?? 5279),
		proxy: { '/api': { target: API, changeOrigin: true } },
	},
});
