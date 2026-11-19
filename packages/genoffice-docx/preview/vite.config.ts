import { defineConfig } from 'vite';

// Preview renderer: a static page served from the plugin package origin.
// No dev server, no proxy, no network — bytes arrive over the Host port.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: false,
  },
});
