#!/usr/bin/env node
// Boot the unit-test harness. We avoid vitest here because its
// config loader spawns esbuild, which fails on sandboxed Windows
// shells with EPERM. The plugin's tests are pure-Node over
// TOML and config shapes; `node:assert/strict` is enough.
//
// Usage: `node tests/runner.mjs` from the plugin root.

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = dirname(here)

// Re-exec under tsx so the .ts test files compile on the fly.
// `spawnSync` blocks the parent; the child gets the same stdout
// so test results stream straight back to the user.
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx/esm', join(here, 'run-tests.ts')],
  { stdio: 'inherit', cwd: pluginRoot },
)
process.exit(result.status ?? 1)
