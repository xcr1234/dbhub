import { defineConfig } from 'tsup'

/**
 * Host bundle only. The client half is built by `scripts/build-client.mjs`
 * separately because it needs the `window.__ModuleLoader__.load` factory
 * wrapper that esbuild's tsup presets do not generate directly.
 *
 * esbuild's `jsx: 'transform'` rewrites JSX into
 * `React.createElement(...)` at build time, so neither half needs a
 * runtime JSX transformer.
 */
export default defineConfig({
  entry: { index: 'src/index.ts', typert: 'src/typert.ts' },
  format: ['esm'],
  dts: true,
  outDir: 'lib',
  target: 'node20',
  sourcemap: true,
  clean: true,
  // The host already provides react / dom / zod through its loader
  // composition. @iarna/toml and the typert zod codecs pass through
  // the host at registration time. `@deepseek-ai/dsh-typert-protocol`
  // is bundled into the host (rather than treated as a bare import)
  // so the `TypertRemoteService` class the plugin extends, and the
  // `Remote` decorator, share the same `markers` WeakMap as the
  // dsh-web gateway's lookup. Two instances of the package would
  // otherwise fail the `markers.get(prototype)` check and the
  // gateway would not see the `@Remote`-marked methods.
  external: ['react', 'react-dom', 'react/jsx-runtime', '@iarna/toml', 'zod'],
})
