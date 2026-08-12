// Standalone vitest config, deliberately NOT importing vite.config.ts: the tests
// are pure Node tests over src/worker modules, and the Cloudflare Vite plugin
// rejects the environment options vitest injects.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
