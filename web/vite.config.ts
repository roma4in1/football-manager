/**
 * Vite config: React SPA + PWA. Engine/league domain modules come from the
 * @fm/engine workspace package (source-first: exports point at .ts files,
 * Vite compiles them like local sources).
 * Dev: /api proxies to the Fastify process (@fm/server, :8080).
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
      workbox: {
        // /api is NEVER the service worker's business. Without this denylist,
        // workbox's navigation fallback served cached index.html for top-level
        // NAVIGATIONS to /api/* — including the magic-link redeem
        // (/api/auth/redeem?token=...), so the request never reached the
        // server, no session cookie was set, and login was impossible.
        // The regex runs against pathname+search of navigation requests.
        navigateFallbackDenylist: [/^\/api\//],
        // No runtimeCaching is configured and the precache manifest is build
        // assets only, so non-navigation /api fetches already pass through the
        // SW untouched — keep it that way.
        // Explicit (autoUpdate implies them, but they are load-bearing here):
        // clients holding the broken SW must activate this fix on their next
        // visit without a manual unregister.
        skipWaiting: true,
        clientsClaim: true,
      },
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
  server: {
    proxy: { '/api': 'http://127.0.0.1:8080' },
    fs: { allow: [repoRoot] }, // workspace-linked @fm/engine sources live outside web/
  },
  test: {
    environment: 'jsdom',
  },
});
