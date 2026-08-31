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

/**
 * Input for the `dbhub/testConnection` endpoint. A single DSN to probe;
 * the host forwards this to dbhub's `--test-dsn` CLI and surfaces the
 * structured result back to the panel.
 */
export interface DbhubTestInput {
  dsn: string
}

export const dbhubTestInputSchema = z.object({
  dsn: z.string().min(1),
})

/**
 * Result of a one-shot connectivity probe. The host runs a fresh dbhub
 * child process for each call so the long-running MCP server is never
 * disturbed; `latencyMs` covers the whole connect + liveness query +
 * disconnect round trip.
 *
 * `serverVersion` is null when the probe failed before reaching the
 * version query, or when the connector has no version concept (sqlite).
 */
export interface DbhubTestResult {
  ok: boolean
  latencyMs: number
  /** Inferred protocol; undefined when the DSN's protocol was unrecognised. */
  dbType: string | null
  /** Database server's own version string when reachable, otherwise null. */
  serverVersion: string | null
  /** Human-readable error message on the failure branch; otherwise null. */
  error: string | null
}

export const dbhubTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number(),
  dbType: z.string().nullable(),
  serverVersion: z.string().nullable(),
  error: z.string().nullable(),
})

/** The `dbhub/list` view: current config plus runtime phase info. */
export interface DbhubView {
  config: DbhubConfig
  /** True when the host has the in-process dbhub server bound. */
  running: boolean
  /** Last error from start/stop, or null. */
  lastError: string | null
  /** Absolute path of the emitted dbhub.toml (under the profile's base dir). */
  configPath: string
  /** Live tool inventory fetched from dbhub's `/api/sources`. Empty when dbhub is not running. */
  tools: DbhubTool[]
}

/** One tool exposed by dbhub for one source. */
export interface DbhubTool {
  /** Source id this tool belongs to. */
  sourceId: string
  /** Tool name (e.g. "execute_sql", "search_objects"). */
  name: string
  /** Tool description as returned by dbhub. */
  description: string | null
  /** True when the tool is marked readonly in dbhub.toml. */
  readonly: boolean
}

export const dbhubToolSchema = z.object({
  sourceId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  readonly: z.boolean(),
})

/** The `dbhub/listTools` view. Empty array when dbhub is not running. */
export const dbhubToolListSchema = z.array(dbhubToolSchema)

export const dbhubViewSchema = z.object({
  config: dbhubConfigZodSchema,
  running: z.boolean(),
  lastError: z.string().nullable(),
  configPath: z.string(),
  tools: dbhubToolListSchema,
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
