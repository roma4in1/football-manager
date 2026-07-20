/**
 * Workbench vite config — dev instrument only. @fm/engine2 is source-first
 * (exports point at .ts); Vite compiles it like local sources, same pattern
 * as web ↔ @fm/engine.
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 5199 },
});
