import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The CLI tests spawn the built binary, which is slow on Windows runners.
  test: { testTimeout: 30_000 },
});
