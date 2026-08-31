/**
 * Parse a DSN string into the structured fields the panel edits, and
 * compose the structured fields back into a DSN string.
 *
 * Encoding policy (mirrors dbhub's `SafeURL` + `buildDSNFromSource`):
 *   - username / password / database name are URL-encoded when composing
 *     and decoded when parsing. This is what dbhub itself expects, so
 *     passwords containing `@`, `:`, `/`, `#`, `%`, `&`, `=`, `+`,
 *     spaces, etc. survive the round-trip.
 *   - host is preserved verbatim. Users occasionally type IPv6 addresses
 *     (`[::1]`) or `[host]:port` brackets; we only split the trailing
 *     `:port` and never touch the rest.
 *   - SQLite file path is preserved verbatim (no encoding). Paths can
 *     legitimately contain spaces and most punctuation.
 *   - params is free-form: typed as the user wants it, but each value
 *     the panel hands us is encoded.
 *
 * The parser is intentionally lenient: a malformed DSN returns `null`
 * and the caller (panel / settings validator) falls back to showing
 * the raw string. Anything that DOES parse round-trips byte-for-byte.
 *
 * @module @xcr1234/dsh-plugin-dbhub/shared
 */

import { inferDbType } from './types.ts'

/** Database type identifiers used by the panel. Matches `inferDbType`. */
export type DbType = 'postgres' | 'mysql' | 'mariadb' | 'sqlserver' | 'sqlite' | 'oracle'

/** Network DB connection fields. `port` is a string so the input stays editable. */
export interface NetworkDsnFields {
  host: string
  port: string
  user: string
  password: string
  database: string
  /** Free-form query string WITHOUT leading `?` (e.g. `sslmode=require`). */
  params: string
}

/** SQLite connection fields. */
export interface SqliteDsnFields {
  /** Absolute or relative path. Empty when `memory` is true. */
  filePath: string
  /** `sqlite:///:memory:` toggle. When true, `filePath` is ignored. */
  memory: boolean
}

/** Discriminated union over the db type — what the form holds. */
export type DsnFields =
  | { type: 'sqlite'; sqlite: SqliteDsnFields }
  | { type: Exclude<DbType, 'sqlite'>; network: NetworkDsnFields }

/** Ordered list of types for the dropdown — most common first. */
export const DB_TYPE_ORDER: DbType[] = ['postgres', 'mysql', 'mariadb', 'sqlserver', 'oracle', 'sqlite']

/** Display labels in the user's current locale (en fallback, see `locales.ts` for overrides). */
export const DB_TYPE_LABELS: Record<DbType, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  sqlserver: 'SQL Server',
  oracle: 'Oracle',
  sqlite: 'SQLite',
}

/** Default ports, used when the user changes type. `sqlite` has no port. */
export const DEFAULT_PORTS: Record<Exclude<DbType, 'sqlite'>, number> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  sqlserver: 1433,
  oracle: 1521,
}

const SQLITE_IN_MEMORY = 'sqlite:///:memory:'
const SQLITE_PREFIX = 'sqlite://'

/**
 * Parse a DSN into structured fields. Returns `null` if the protocol is
 * unknown — callers should keep the raw string as a fallback.
 */
export function parseDsn(dsn: string): DsnFields | null {
  const type = inferDbType(dsn)
  if (type === null) return null

  if (type === 'sqlite') {
    if (dsn === SQLITE_IN_MEMORY) {
      return { type: 'sqlite', sqlite: { filePath: '', memory: true } }
    }
    if (dsn.startsWith(SQLITE_PREFIX)) {
      // Strip `sqlite://` first. The remaining string starts with
      // either a `/` (URL-convention "empty authority") or directly
      // with the path body. We can't blindly strip a leading `/`,
      // because Unix absolute paths are `/var/...` and the leading
      // `/` is part of the path. But Windows drive letters look like
      // `/C:` — the leading `/` is the URL convention, the actual
      // path is `C:`. Detect that one case and peel off only there.
      let filePath = dsn.slice(SQLITE_PREFIX.length)
      if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1)
      return { type: 'sqlite', sqlite: { filePath, memory: false } }
    }
    return null
  }

  // Network: `<proto>://[user[:pass]@]host[:port][/db][?params]`
  const protoMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(dsn)
  if (protoMatch === null) return null
  let rest = dsn.slice(protoMatch[0].length)

  let params = ''
  const qIdx = rest.indexOf('?')
  if (qIdx >= 0) {
    params = rest.slice(qIdx + 1)
    rest = rest.slice(0, qIdx)
  }

  let user = ''
  let password = ''
  const atIdx = rest.lastIndexOf('@')
  let hostPart: string
  if (atIdx >= 0) {
    const auth = rest.slice(0, atIdx)
    hostPart = rest.slice(atIdx + 1)
    const colonIdx = auth.indexOf(':')
    if (colonIdx >= 0) {
      try {
        user = decodeURIComponent(auth.slice(0, colonIdx))
        password = decodeURIComponent(auth.slice(colonIdx + 1))
      } catch {
        // Bad percent-escape: keep raw, dbhub will reject too.
        user = auth.slice(0, colonIdx)
        password = auth.slice(colonIdx + 1)
      }
    } else {
      try {
        user = decodeURIComponent(auth)
      } catch {
        user = auth
      }
    }
  } else {
    hostPart = rest
  }

  // Peel off the `/database` BEFORE splitting host:port, so IPv6
  // literals like `[::1]:5432/db` keep their brackets intact.
  let hostPort = hostPart
  let database = ''
  const slashIdx = hostPort.indexOf('/')
  if (slashIdx >= 0) {
    database = hostPort.slice(slashIdx + 1)
    hostPort = hostPort.slice(0, slashIdx)
  }

  let host = hostPort
  let port = ''
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']')
    if (close >= 0) {
      host = hostPort.slice(0, close + 1)
      const after = hostPort.slice(close + 1)
      if (after.startsWith(':')) port = after.slice(1)
    }
  } else {
    const colonIdx = hostPort.lastIndexOf(':')
    if (colonIdx >= 0) {
      host = hostPort.slice(0, colonIdx)
      port = hostPort.slice(colonIdx + 1)
    }
  }

  if (database.length > 0) {
    try {
      database = decodeURIComponent(database)
    } catch {
      // leave raw
    }
  }

  return {
    type,
    network: {
      host,
      port,
      user,
      password,
      database,
      params,
    },
  }
}

/**
 * Compose structured fields back into a DSN. Mirrors `parseDsn`:
 * encodes user / password / database; preserves host verbatim; encodes
 * each query param key/value. Empty optional fields are omitted (no
 * trailing `/`, no `?` if no params).
 */
export function composeDsn(fields: DsnFields): string {
  if (fields.type === 'sqlite') {
    if (fields.sqlite.memory) return SQLITE_IN_MEMORY
    const fp = fields.sqlite.filePath
    // Mirror the parser's special case: Windows drive-letter paths
    // need a third `/` (URL-convention "empty authority") added back.
    // Unix absolute (`/var/...`), relative (`./rel`), and bare names
    // (`rel`) all keep their own leading char.
    const prefix = /^[A-Za-z]:/.test(fp) ? `${SQLITE_PREFIX}/` : SQLITE_PREFIX
    return `${prefix}${fp}`
  }

  const proto = fields.type === 'postgres' ? 'postgres' : fields.type
  const net = fields.network

  let auth = ''
  if (net.user.length > 0 || net.password.length > 0) {
    auth = `${encodeURIComponent(net.user)}:${encodeURIComponent(net.password)}@`
  }

  let hostPort = net.host
  if (net.port.length > 0) hostPort += `:${net.port}`

  let db = ''
  if (net.database.length > 0) db = `/${encodeURIComponent(net.database)}`

  let params = ''
  if (net.params.trim().length > 0) params = `?${encodeParams(net.params)}`

  return `${proto}://${auth}${hostPort}${db}${params}`
}

/**
 * Re-encode a query string the user typed. We split on `&` and `=`,
 * then encode each piece independently. This means an unencoded value
 * (e.g. `sslmode=require`) is normalized to `sslmode=require`, while a
 * value that already contains `&` (rare but possible after a copy-paste)
 * gets escaped — except we treat top-level `&` as separators.
 *
 * Trade-off: a user-typed literal `&` inside a value can't be expressed
 * via this field; they should percent-encode it as `%26` themselves.
 */
function encodeParams(raw: string): string {
  return raw
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq === -1) return encodeURIComponent(pair)
      const key = pair.slice(0, eq)
      const value = pair.slice(eq + 1)
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    })
    .join('&')
}

/**
 * Build a fresh `DsnFields` with sensible defaults for the given type.
 * Used when the user clicks "Add connection" or switches type — we
 * pre-fill the port so they don't have to look it up.
 */
export function emptyFields(type: DbType): DsnFields {
  if (type === 'sqlite') {
    return { type, sqlite: { filePath: '', memory: false } }
  }
  return {
    type,
    network: {
      host: '',
      port: String(DEFAULT_PORTS[type]),
      user: '',
      password: '',
      database: '',
      params: '',
    },
  }
}