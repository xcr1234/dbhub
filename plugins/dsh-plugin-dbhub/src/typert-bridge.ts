/**
 * Bridge that re-exports `@deepseek-ai/dsh-typert-protocol` from
 * the operator's deepseek-harness checkout.
 *
 * Why this exists
 * ---------------
 *
 * `@deepseek-ai/dsh-typert-protocol` is a deepseek-harness
 * monorepo internal package. The plugin's `@Remote` decorators
 * write their markers into a module-level WeakMap inside that
 * package's `Remote` decorator. The dsh-web typert gateway reads
 * the SAME WeakMap to discover marked methods on a live service.
 *
 * If the plugin loads its own copy of the package (resolved
 * through its own `node_modules` after pnpm install) and dsh-web
 * uses the monorepo's copy (resolved through deepseek-harness's
 * pnpm workspace), the two copies are different module instances
 * and the gateway never sees the plugin's markers. The typert
 * gateway then reports "Service has no visible typertRemote
 * binding".
 *
 * This bridge replaces the bare import with a `createRequire`
 * call that lands on the deepseek-harness `lib/index.js`
 * directly. Both sides now load the exact same file, the marker
 * Map is shared, and the gateway finds the plugin's `@Remote`
 * methods.
 *
 * The `DSH_HARNESS_ROOT` env var lets the operator point at a
 * different checkout. The default is the canonical
 * `E:\dev\deepseek-harness`. A missing checkout is a load-time
 * error so we fail loud rather than silently keeping the old
 * broken behaviour.
 *
 * @module @xcr1234/dsh-plugin-dbhub
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// `import.meta.url` is the URL of THIS file at runtime. We resolve
// to deepseek-harness's `lib/index.js` relative to the plugin's
// own location, which is the same file dsh-web loaded its copy
// from. That gives both sides the same module identity and the
// marker WeakMap is shared.
const here = dirname(fileURLToPath(import.meta.url))
// Walk up: this file lives at
// `E:\dev\dbhub\plugins\dsh-plugin-dbhub\src\typert-bridge.ts`.
// deepseek-harness's typert-protocol lib is at
// `E:\dev\deepseek-harness\packages\typert\protocol\lib\index.js`,
// i.e. four levels up + the harness subtree.
const fallback = resolve(
  here,
  '..',
  '..',
  '..',
  '..',
  'deepseek-harness',
  'packages',
  'typert',
  'protocol',
  'lib',
  'index.js',
)

const root = process.env.DSH_HARNESS_ROOT
const target =
  root !== undefined && root.length > 0
    ? resolve(root, 'packages', 'typert', 'protocol', 'lib', 'index.js')
    : fallback

if (!existsSync(target)) {
  throw new Error(
    `@xcr1234/dsh-plugin-dbhub: could not locate dsh-typert-protocol at ${target}. ` +
      `Set DSH_HARNESS_ROOT to your deepseek-harness checkout, or run this plugin against ` +
      `a deepseek-harness-based dsh install.`,
  )
}

const require = createRequire(import.meta.url)
// Pull the named exports from the deepseek-harness copy. The
// `require` here returns the same module instance dsh-web's
// gateway sees, so the `markers` WeakMap is the same one the
// `@Remote` decorators write to.
const typert = require(target) as {
  Remote: typeof import('@deepseek-ai/dsh-typert-protocol').Remote
  TypertRemoteService: typeof import('@deepseek-ai/dsh-typert-protocol').TypertRemoteService
}

export const Remote = typert.Remote
export const TypertRemoteService = typert.TypertRemoteService
