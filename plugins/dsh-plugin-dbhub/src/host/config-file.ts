/**
 * File layout for the plugin's on-disk artefacts.
 *
 * The plugin owns a single TOML file under the active DSH profile
 * directory. dbhub is started with `--config=<that file>` so cwd
 * is irrelevant, and the file's directory doubles as the place
 * the user can hand-edit advanced options (SSH, SSL,
 * query_timeout, custom tools) without breaking the panel.
 *
 * Resolution order
 * ----------------
 *
 *  1. `process.env.DBHUB_TOML_PATH` — explicit override; wins when
 *     the operator wants the config file outside the profile (e.g.
 *     for a shared DB across multiple profiles, or a sync'd
 *     dotfiles checkout). The directory of the resolved path is
 *     used as the profile dir.
 *
 *  2. The DSH loader's `cordis:include` entry. Its `config.path`
 *     points at `<profile>/cordis.yml`, and the profile dir is
 *     its dirname. This is the same source of truth the
 *     `@opendsh/dsh-plugin-setting-mcp` reference plugin uses to
 *     locate `cordis.patch.yml`, so the dbhub.toml will land
 *     beside it: `<profile>/dbhub.toml`. Read through the loader
 *     once the host's `apply()` has run.
 *
 *  3. Walk up from this plugin's own install path. dsh-web loads
 *     the plugin through
 *     `<profile>/node_modules/@xcr1234/dsh-plugin-dbhub`, so the
 *     directory four levels up from `package.json` is the profile
 *     root. Useful when the loader isn't available yet (e.g. in
 *     unit tests).
 *
 *  4. `process.env.DSH_PROFILE_DIR` — set by older launcher
 *     revisions; respected for compatibility but secondary
 *     because recent dsh releases do NOT export it.
 *
 *  5. `~/.dsh/profile-data` last-resort fallback. Lets a developer
 *     running `node lib/index.js` directly (no dsh-web involved)
 *     still land the file somewhere sane.
 *
 * @module @xcr1234/dsh-plugin-dbhub/host
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** Convert a file URL or plain path string to an absolute path. */
function toAbsolutePath(value: string): string {
  if (value.startsWith('file://')) return fileURLToPath(value)
  return resolve(value)
}

/** Filename of the generated dbhub config inside the profile dir. */
const TOML_FILENAME = 'dbhub.toml'

/**
 * Walk up from `start` looking for a `package.json` whose
 * `name` field is `@xcr1234/dsh-plugin-dbhub`. The dsh-web
 * loader installs us under
 * `<profile>/node_modules/@xcr1234/dsh-plugin-dbhub/`, so
 * when the file is found the plugin dir is its containing
 * directory and the profile root is four levels up.
 *
 * Returns the absolute profile directory, or `null` when no
 * `cordis.yml` is found within `maxDepth` levels of `start`.
 */
function discoverProfileDirFromInstallPath(start: string, maxDepth = 10): string | null {
  let cursor = start
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const candidate = resolve(cursor, 'package.json')
    if (existsSync(candidate)) {
      try {
        const text = readFileSync(candidate, 'utf8')
        if (text.includes('"@xcr1234/dsh-plugin-dbhub"')) {
          const profileDir = resolve(cursor, '..', '..', '..', '..')
          if (existsSync(join(profileDir, 'cordis.yml'))) {
            return profileDir
          }
        }
      } catch {
        // unreadable package.json; keep walking.
      }
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return null
}

/** Sanity-checked path of the root DSH profile's `cordis.yml`. */
function readProfileDirFromCordisInclude(cordisPath: string): string {
  // `cordisPath` is either a `file://` URL (the loader's standard
  // representation across every dsh release we have seen) or a
  // plain absolute path. Convert to a real path before any
  // filesystem operation.
  const absolute = toAbsolutePath(cordisPath)
  const profileDir = dirname(absolute)
  if (!existsSync(join(profileDir, 'cordis.yml'))) {
    throw new Error(
      `dbhub.toml location: ${profileDir} does not look like a DSH profile (cordis.yml missing)`,
    )
  }
  return profileDir
}

/**
 * Walk the loader's `cordis:include` entries to find the root
 * profile's `cordis.yml`. Returns the profile dir, or `null` when
 * the loader has no include entry yet (test environments, very
 * early bootstrap).
 */
export function resolveProfileDirFromLoader(loader: unknown): string | null {
  if (!loader || typeof loader !== 'object') return null
  // `loader.entries()` is the cross-loader public surface; each
  // entry exposes `options` and an optional `subtree` handle.
  const entriesFn = (loader as { entries?: () => Iterable<unknown> }).entries
  if (typeof entriesFn !== 'function') return null
  // Debug breadcrumbs: surface what the loader actually sees so
  // a stale cordis:include entry or a misconfigured loader is
  // diagnosable in the dsh log without rebuilding.
  const seenNames: string[] = []
  for (const entry of entriesFn.call(loader)) {
    const e = entry as {
      options?: { name?: unknown; config?: unknown }
      subtree?: unknown
    }
    const options = e.options
    if (options === undefined) continue
    const name = options.name
    if (typeof name === 'string') seenNames.push(name)
    if (name !== 'cordis:include') continue
    const config = options.config as { path?: unknown } | undefined
    if (config === undefined || typeof config.path !== 'string') {
      console.warn(
        `[dbhub] loader has cordis:include but no usable config.path; saw entries: ${seenNames.join(', ')}`,
      )
      continue
    }
    try {
      const dir = readProfileDirFromCordisInclude(config.path)
      console.warn(`[dbhub] profile dir resolved from cordis:include -> ${dir}`)
      return dir
    } catch (err) {
      console.warn(
        `[dbhub] cordis:include path rejected: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  console.warn(
    `[dbhub] no cordis:include in loader; entries seen: ${seenNames.join(', ')}; falling back`,
  )
  return null
}

/** Resolve the directory this plugin writes its artefacts into. */
export function resolveProfileDir(loader?: unknown): string {
  // 1. Explicit override of the full TOML file path.
  const explicit = process.env.DBHUB_TOML_PATH
  if (typeof explicit === 'string' && explicit.length > 0) {
    return dirname(resolve(explicit))
  }
  // 2. Active dsh profile dir, read from the loader's
  // `cordis:include` entry (authoritative).
  const fromLoader = resolveProfileDirFromLoader(loader)
  if (fromLoader !== null) {
    return fromLoader
  }
  // 3. Walk up from the plugin's own install path.
  const here = fileURLToPath(import.meta.url)
  const fromInstall = discoverProfileDirFromInstallPath(here)
  if (fromInstall !== null) {
    return fromInstall
  }
  // 4. Legacy env var.
  const legacy = process.env.DSH_PROFILE_DIR
  if (typeof legacy === 'string' && legacy.length > 0) {
    return resolve(legacy)
  }
  // 5. Last-resort fallback.
  return join(homedir(), '.dsh', 'profile-data')
}

/** Resolve the absolute path of the generated dbhub.toml. */
export function resolveConfigPath(loader?: unknown): string {
  const explicit = process.env.DBHUB_TOML_PATH
  if (typeof explicit === 'string' && explicit.length > 0) {
    return resolve(explicit)
  }
  return join(resolveProfileDir(loader), TOML_FILENAME)
}

/** Ensure the parent dir exists. Idempotent. */
export function ensureConfigDir(loader?: unknown): void {
  mkdirSync(dirname(resolveConfigPath(loader)), { recursive: true })
}