/**
 * Vite config: React SPA + PWA. Shared league/engine modules are imported
 * straight from the repo root via the @shared alias (they are pure TS — the
 * import graph web/ touches must never reach pg/fastify/pg-boss).
 * Dev: /api proxies to the Fastify process (league-server.ts, :8080).
 */

import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // installable PWA; push subscription deliberately absent (blocked on iOS device test)
      manifest: {
        name: 'FM League',
        short_name: 'FM League',
        description: 'Fantasy football manager league',
        start_url: '/',
        display: 'standalone',
        background_color: '#101418',
        theme_color: '#101418',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
    }),
  ],
  resolve: {
    alias: { '@shared': repoRoot },
  },
  server: {
    proxy: { '/api': 'http://127.0.0.1:8080' },
    fs: { allow: [repoRoot] },
  },
  test: {
    environment: 'jsdom',
  },
});
