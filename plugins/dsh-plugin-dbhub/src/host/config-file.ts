/**
 * File layout for the plugin's on-disk artefacts.
 *
 * The plugin owns a single TOML file under the active DSH profile's
 * base dir. dbhub is started with `--config=<that file>` so cwd is
 * irrelevant, and the file's directory doubles as the place the user
 * can hand-edit advanced options (SSH, SSL, query_timeout, custom
 * tools) without breaking the panel.
 *
 * Resolution:
 *  - `process.env.DSH_PROFILE_DIR` if set (used by the dsh launcher
 *    to point each profile at its own data dir).
 *  - `~/.dsh/profiles/<active>` otherwise. We do not parse the
 *    launcher's config to discover the profile id; the env var is
 *    authoritative when present.
 *
 * @module @xcr1234/dsh-plugin-dbhub/host
 */

import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

/** Filename of the generated dbhub config inside the profile data dir. */
const TOML_FILENAME = 'dbhub.toml'

/** Resolve the directory this plugin writes its artefacts into. */
export function resolveProfileDir(): string {
  const env = process.env.DSH_PROFILE_DIR
  if (typeof env === 'string' && env.length > 0) {
    return resolve(env)
  }
  // Fallback: a `.dsh` dir under the user's home. The dsh launcher
  // usually exports DSH_PROFILE_DIR; this exists for the standalone
  // `node lib/index.js` smoke test and the rare custom launcher.
  return join(homedir(), '.dsh', 'profile-data')
}

/** Resolve the absolute path of the generated dbhub.toml. */
export function resolveConfigPath(): string {
  return join(resolveProfileDir(), TOML_FILENAME)
}

/** Ensure the parent dir exists. Idempotent. */
export function ensureConfigDir(): void {
  mkdirSync(dirname(resolveConfigPath()), { recursive: true })
}
