import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  // Core is a private workspace package shipped as TypeScript source, so it is bundled in.
  noExternal: ['@opsdraw/core'],
  // Core's own dependencies stay external (CommonJS packages can't be inlined into ESM).
  external: ['yaml', 'elkjs'],
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
});
