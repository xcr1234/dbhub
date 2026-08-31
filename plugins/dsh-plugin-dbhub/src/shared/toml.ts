/**
 * Pure conversion between the plugin's `DbhubConfig` and dbhub's TOML
 * `[[sources]]` format. The two are not the same shape: dbhub TOML is the
 * canonical config (DSN + id + optional SSH/SSL/timeouts/init script) and
 * the panel only manages the DSN.
 *
 * v1 has no UI for SSH / SSL / query_timeout; users who want them edit
 * the file directly. To make that workflow safe we preserve any
 * hand-added fields across panel saves: the host reads the previous
 * TOML, hands the unknown per-source fields to {@link configToToml}
 * via the `preserved` argument, and re-emits them alongside the panel
 * fields. The panel's own writes (id, dsn) win on conflict — that's
 * the panel's contract with the user.
 *
 * Future revisions can layer a richer schema on top without breaking
 * these primitives.
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
    [key: string]: unknown
  }>
}

/**
 * Per-source bag of unknown TOML fields, keyed by source id. Built by
 * {@link parsePreservedFields} from the previous dbhub.toml, then
 * consumed by {@link configToToml}. Sources not in the new config
 * are dropped on write; sources whose id was renamed lose their
 * preserved fields (the user can re-add them after renaming).
 */
export type PreservedFields = Record<string, Record<string, unknown>>

/** Build the TOML text the host writes to `dbhub.toml`. */
export function configToToml(
  config: DbhubConfig,
  preserved: PreservedFields = {},
): string {
  // `toml.stringify` on a `{ sources: [...] }` shape produces:
  //   [[sources]]
  //   id = "..."
  //   dsn = "..."
  //   <any preserved fields>
  // which is exactly the array-of-tables layout dbhub's loader expects.
  // We cast to `any` because @iarna/toml's JsonMap type is stricter
  // than the value space we actually need (id/dsn strings + arbitrary
  // preserved scalars/tables).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sources = config.sources.map((s) => {
    const extras = preserved[s.id]
    if (extras === undefined) return { id: s.id, dsn: s.dsn }
    // `parsePreservedFields` already strips `id` and `dsn` from the
    // extras, but we re-strip here defensively — the panel's own
    // fields must always win on conflict, otherwise a hand-edited
    // old dsn would silently overwrite a freshly-typed one.
    const safeExtras: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(extras)) {
      if (k === 'id' || k === 'dsn') continue
      safeExtras[k] = v
    }
    return { ...safeExtras, id: s.id, dsn: s.dsn }
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return toml.stringify({ sources } as any)
}

/**
 * Read the unknown per-source fields out of an existing dbhub.toml
 * for re-emission on the next write. Returns an empty object on
 * parse failure (so a hand-typed typo doesn't brick the panel —
 * the user can fix the file and the next save will pick up
 * whatever survives). Sources without `id` are skipped because
 * we have no key to merge them with.
 */
export function parsePreservedFields(text: string): PreservedFields {
  let parsed: unknown
  try {
    parsed = toml.parse(text)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const sources = (parsed as { sources?: unknown }).sources
  if (!Array.isArray(sources)) return {}
  const result: PreservedFields = {}
  for (const raw of sources) {
    if (raw === null || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const id = record.id
    if (typeof id !== 'string' || id.length === 0) continue
    const preserved: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(record)) {
      if (key === 'id' || key === 'dsn') continue
      preserved[key] = value
    }
    if (Object.keys(preserved).length > 0) result[id] = preserved
  }
  return result
}

/**
 * Read back a TOML string into a `DbhubConfig`. Only `id` and `dsn`
 * are surfaced — SSH/SSL/etc. live on disk in the TOML but not in
 * the panel's settings schema, so the panel cannot show them. They
 * are still preserved across saves via {@link parsePreservedFields}.
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
