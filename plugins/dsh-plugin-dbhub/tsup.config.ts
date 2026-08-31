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
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  outDir: 'lib',
  target: 'node20',
  sourcemap: true,
  clean: true,
  // The host dsh profile provides react / dom / zod through its
  // loader composition. @iarna/toml and the dsh-settings namespace
  // registration pass through the host at apply() time.
  // `@deepseek-ai/dsh-client-connection` is a peer dep (provided by
  // the host at runtime); the previous `@deepseek-ai/dsh-typert-protocol`
  // runtime dep was retired when the plugin migrated to
  // `ctx.connection.rpc` — see README §6 for the rationale.
  external: ['react', 'react-dom', 'react/jsx-runtime', '@iarna/toml', 'zod'],
})