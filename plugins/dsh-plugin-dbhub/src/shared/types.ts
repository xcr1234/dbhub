/**
 * Wire types shared by host and client halves.
 *
 * The plugin's UI is deliberately simple: one source = one row with `id` +
 * `dsn`. Anything dbhub's TOML supports beyond that (SSH, SSL, timeouts,
 * per-tool `readonly` / `max_rows`, custom tools) is not exposed in v1; a
 * user can still hand-edit the produced `dbhub.toml` to add it, because
 * the file is fully dbhub-compatible and only our DSN-shape rows are
 * managed by the panel.
 *
 * The settings namespace is also the durable store: `dbhub/save` writes
 * it, the host watches it, and on every commit re-emits the TOML file.
 * Hand-edits to the TOML do NOT flow back into settings — that is one-way.
 *
 * @module @xcr1234/dsh-plugin-dbhub/shared
 */

import { z } from 'zod'
import zSchema from '@deepseek-ai/schemastery'

/** One UI-managed source. Matches the user input shape from the panel. */
export interface DbhubSource {
  /** Stable source id, also the model-facing namespace suffix. */
  id: string
  /**
   * DSN string. Format: `protocol://user:pass@host:port/dbname` (see
   * `dbhub` README). SQLite accepts `sqlite:///abs/path.db` or
   * `sqlite:///:memory:`.
   *
   * Treated as a secret: persisted verbatim in the user document but
   * `SettingsProvider.describe({ redactSecrets: true })` strips it
   * from wire fetches. The panel reads it through `get(ns)` so it
   * sees the full value when the user is editing.
   */
  dsn: string
}

/** The full settings-namespace document. */
export interface DbhubConfig {
  /** HTTP port for the in-process dbhub MCP server. Default: 18080. */
  port: number
  /** Whether dbhub is currently running. Toggled by the panel toggle. */
  enabled: boolean
  /** UI-managed sources. DSN strings only in v1. */
  sources: DbhubSource[]
}

/**
 * Schemastery schema for the `dbhub` settings namespace. DSH's
 * `installSettingsSection` (and SettingsProvider.register) expect a
 * schemastery `z<T>` schema, not a zod one. We keep the same shape
 * so `dbhub/save`'s wire zod schema can validate the JSON-serialized
 * input without round-tripping through schemastery.
 */
export const dbhubConfigSchema = zSchema.object({
  port: zSchema.number().default(18080).min(1).max(65535),
  enabled: zSchema.boolean().default(true),
  sources: zSchema
    .array(
      zSchema.object({
        id: zSchema.string().required().pattern(/^[A-Za-z0-9_-]{1,64}$/),
        dsn: zSchema.string().required().role('secret'),
      }),
    )
    .default([]),
}) as unknown as zSchema<DbhubConfig>

/** Zod schema mirroring {@link dbhubConfigSchema}, used by the typert wire. */
export const dbhubConfigZodSchema = z.object({
  port: z.number().int().min(1).max(65535),
  enabled: z.boolean(),
  sources: z.array(
    z.object({
      id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
      dsn: z.string().min(1),
    }),
  ),
})

/** Zod schema for the `dbhub/save` input — a full new config to persist. */
export const dbhubSaveInputSchema = dbhubConfigZodSchema

/** The `dbhub/list` view: current config plus runtime phase info. */
export interface DbhubView {
  config: DbhubConfig
  /** True when the host has the in-process dbhub server bound. */
  running: boolean
  /** Last error from start/stop, or null. */
  lastError: string | null
  /** Absolute path of the emitted dbhub.toml (under the profile's base dir). */
  configPath: string
}

export const dbhubViewSchema = z.object({
  config: dbhubConfigZodSchema,
  running: z.boolean(),
  lastError: z.string().nullable(),
  configPath: z.string(),
})

/** DSN prefix → connector type. Mirrors dbhub's getDatabaseTypeFromDSN. */
export function inferDbType(dsn: string): 'postgres' | 'mysql' | 'mariadb' | 'sqlserver' | 'sqlite' | 'oracle' | null {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(dsn)
  if (!match) return null
  const proto = match[0].slice(0, -3).toLowerCase()
  switch (proto) {
    case 'postgres':
    case 'postgresql':
      return 'postgres'
    case 'mysql':
      return 'mysql'
    case 'mariadb':
      return 'mariadb'
    case 'sqlserver':
    case 'mssql':
      return 'sqlserver'
    case 'sqlite':
      return 'sqlite'
    case 'oracle':
    case 'oracledb':
      return 'oracle'
    default:
      return null
  }
}
