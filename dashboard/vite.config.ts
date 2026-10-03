import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

const dashboardRoot = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

/** Where `npm run dev:dashboard` forwards backend requests (the bot's web server). */
const backend = process.env.DASHBOARD_BACKEND_URL ?? 'http://localhost:3000';

// Keep the original Host header so cookies and OAuth redirects behave like production.
const proxy: ProxyOptions = { target: backend, changeOrigin: false, ws: false };

export default defineConfig({
  root: dashboardRoot,
  base: '/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The dashboard imports shared contracts from ../src.
    fs: { allow: [projectRoot] },
    proxy: {
      '/api': proxy,
      '/auth': proxy,
      '/webhooks': proxy,
      '/healthz': proxy,
    },
  },
  preview: { port: 4173 },
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
