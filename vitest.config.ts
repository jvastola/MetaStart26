import { defineConfig } from 'vitest/config';

// Unit tests cover pure modules only, so they skip the IWSDK dev plugin
// (which would otherwise try to start or attach to the dev runtime).
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
