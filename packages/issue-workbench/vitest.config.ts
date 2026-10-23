import { defineConfig } from 'vitest/config';
export default defineConfig({ esbuild: { jsx: 'automatic' }, test: {
  environment: 'jsdom', include: ['test/ui/**/*.test.{ts,tsx}'], restoreMocks: true,
} });
