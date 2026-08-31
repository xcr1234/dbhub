/**
 * Minimal test harness. We avoid vitest because its config loader
 * spawns esbuild, which fails on sandboxed Windows shells with
 * EPERM. The plugin's tests are pure-Node over TOML and config
 * shapes; `node:assert/strict` is enough.
 *
 * Each test file (`tests/*.test.ts`) is self-contained: it
 * inlines its own `describe` / `t` / `expect` and prints its
 * summary at module-evaluation time. This file's job is to
 * import every test file and wait for the process to settle.
 *
 * Usage: `node tests/runner.mjs` from the plugin root.
 */

const here = new URL('.', import.meta.url)
const files = ['./toml.test.ts', './dsn.test.ts']
for (const file of files) {
  await import(new URL(file, here).href)
}
// Give every file's top-level `await new Promise(setImmediate)`
// chains a chance to flush their summaries to stdout.
await new Promise((resolve) => setImmediate(resolve))
await new Promise((resolve) => setImmediate(resolve))
