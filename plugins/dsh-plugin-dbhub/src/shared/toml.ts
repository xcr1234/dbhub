/**
 * Pure conversion between the plugin's `DbhubConfig` and dbhub's TOML
 * `[[sources]]` format. The two are not the same shape: dbhub TOML is the
 * canonical config (DSN + id + optional SSH/SSL/timeouts/init script) and
 * the panel only manages the DSN. The functions here do the simplest
 * possible thing — write `id` + `dsn` per source and read them back —
 * and leave any hand-added TOML fields (ssh_host, sslmode, …) untouched
 * on the way out by reading only the keys we own.
 *
 * v1 has no UI for SSH / SSL / query_timeout; users who want them edit
 * the file directly. Future revisions can layer a richer schema on top
 * without breaking these primitives.
 *
 * @module @xcr1234/dsh-plugin-dbhub/shared
 */

import toml from '@iarna/toml'
import type { DbhubConfig, DbhubSource } from './types.ts'
import { inferDbType } from './types.ts'

/** Whole-file TOML schema we expect to read back. */
interface DbhubTomlFile {
  sources?: Array<{
    id?: unknown
    dsn?: unknown
  }>
}

/** Build the TOML text the host writes to `dbhub.toml`. */
export function configToToml(config: DbhubConfig): string {
  // `toml.stringify` on a `{ sources: [...] }` shape produces:
  //   [[sources]]
  //   id = "..."
  //   dsn = "..."
  // which is exactly the array-of-tables layout dbhub's loader expects.
  // We cast to `any` because @iarna/toml's JsonMap type is stricter
  // than the value space we actually need (id/dsn strings).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return toml.stringify({ sources: config.sources.map((s) => ({ id: s.id, dsn: s.dsn })) } as any)
}

/**
 * Read back a TOML string into a `DbhubConfig`. Unknown keys on each
 * source (e.g. `ssh_host`) are preserved as `unknown` and dropped here;
 * the user can re-add them by editing the file and the next read will
 * carry the DSN forward untouched.
 *
 * If the file is empty / has no `[[sources]]`, returns an empty
 * `sources` array. A malformed file throws with a clear message; the
 * settings namespace keeps its last good value, mirroring dbhub's own
 * `config-watcher.ts` behaviour.
 */
export function tomlToConfig(text: string, fallback: DbhubConfig): DbhubConfig {
  let parsed: DbhubTomlFile
  try {
    parsed = toml.parse(text) as DbhubTomlFile
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`dbhub.toml is not valid TOML: ${message}`)
  }
  const sources: DbhubSource[] = []
  for (const raw of parsed.sources ?? []) {
    if (typeof raw.id !== 'string' || raw.id.length === 0) continue
    if (typeof raw.dsn !== 'string' || raw.dsn.length === 0) continue
    sources.push({ id: raw.id, dsn: raw.dsn })
  }
  return { ...fallback, sources }
}

/** Validate that a DSN is parseable. Returns the inferred type or throws. */
export function assertValidDsn(dsn: string, sourceId: string): 'postgres' | 'mysql' | 'mariadb' | 'sqlserver' | 'sqlite' | 'oracle' {
  const type = inferDbType(dsn)
  if (type === null) {
    throw new Error(`source "${sourceId}": dsn must start with one of postgres://, mysql://, mariadb://, sqlserver://, sqlite://, oracle://`)
  }
  return type
}
