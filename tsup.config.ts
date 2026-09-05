import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', extract: 'src/extract.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  shims: true,
  target: 'es2022',
  external: ['pdf-lib', 'harfbuzzjs'],
});
