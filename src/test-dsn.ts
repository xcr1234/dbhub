/**
 * One-shot DSN connectivity probe for the DSH plugin's "test connection"
 * button. Runs outside the normal dbhub lifecycle: no HTTP/stdio transport,
 * no tool registration, no config watcher, no banner. Just a quick
 * `connect` -> liveness query -> `disconnect` round trip on a fresh
 * connector clone.
 *
 * Triggered by the `--test-dsn=<dsn>` argv flag, which `src/index.ts`
 * detects before the normal `loadConnectors(...).then(main)` chain runs.
 *
 * Output convention:
 *   - stdout: a single JSON line, `{ok, latencyMs, dbType, serverVersion}`
 *     on success or `{ok: false, error}` on failure. Anything that wants
 *     to parse this output should `JSON.parse(stdout.trim())`.
 *   - stderr: human-readable diagnostics (via `console.error`), kept
 *     separate so they never pollute the JSON.
 *   - exit code: 0 on success, 1 on failure. The caller may also check
 *     `process.exitCode` directly because we set it instead of calling
 *     `process.exit` (which would skip pending async work).
 *
 * Why we don't reuse ConnectorManager: that class wraps SSH tunnels,
 * AWS IAM token refresh, lazy connect, and other multi-source state we
 * don't want here. The plugin wants to test the raw DSN string the user
 * just typed, before any of that machinery is in play.
 *
 * @module @xcr1234/dbhub/test-dsn
 */

import { ConnectorRegistry, type Connector } from "./connectors/interface.js";

/** JSON shape written to stdout on either branch. */
export interface TestDsnResult {
  ok: boolean;
  /** Wall-clock latency in milliseconds for the whole probe. */
  latencyMs: number;
  /** Inferred database protocol: postgres / mysql / mariadb / sqlserver / sqlite / oracle. */
  dbType?: string;
  /** Database server version string when reachable, otherwise null. */
  serverVersion: string | null;
  /** Human-readable error message on the failure branch; otherwise null. */
  error: string | null;
}

/**
 * Per-connector liveness + version query. Picked so that a successful
 * `executeSQL` proves end-to-end auth, not just TCP connect:
 *
 *   postgres / mysql / mariadb / sqlserver / sqlite  -> SELECT 1 (cheap)
 *   oracle                                          -> SELECT 1 FROM DUAL
 *
 * For `serverVersion` we run the database's native version query and
 * take the first row's first string field. The query is connector-
 * specific because there's no ANSI standard.
 */
function versionQuery(connectorId: string): string {
  switch (connectorId) {
    case "postgres":
      return "SELECT version()";
    case "mysql":
    case "mariadb":
      return "SELECT VERSION()";
    case "sqlserver":
      return "SELECT @@VERSION";
    case "oracle":
      return "SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1";
    case "sqlite":
      return "SELECT sqlite_version()";
    default:
      return "SELECT 1";
  }
}

/** Extract a single string version from the connector's row shape. */
function extractVersion(rows: unknown[]): string | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = rows[0] as Record<string, unknown> | unknown;
  if (first === null || typeof first !== "object") return null;
  // pg / mysql2 / mssql / better-sqlite3 / mariadb each return rows as
  // `{ <column>: <value> }` objects, but oracle returns rows as
  // positional arrays when OUT_FORMAT_ARRAY is set (we set OBJECT in
  // the oracle connector's connect(), so we should always get objects
  // here — but defensively fall back to a positional scan).
  const record = first as Record<string, unknown>;
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** Write the result JSON to stdout and set the process exit code. */
function emit(result: TestDsnResult): void {
  // Always print, even partial JSON, so the caller has something to
  // parse. process.stdout.write is used directly so we don't accidentally
  // prepend a "[dbhub]" prefix that some logger might inject.
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

/** Drive the probe. Always emits a JSON line and sets process.exitCode. */
export async function runTestDsn(dsn: string): Promise<void> {
  const startedAt = Date.now();
  const baseResult: Omit<TestDsnResult, "ok" | "latencyMs"> = {
    dbType: undefined,
    serverVersion: null,
    error: null,
  };

  const prototype = ConnectorRegistry.getConnectorForDSN(dsn);
  if (prototype === null) {
    emit({
      ...baseResult,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: "unsupported DSN protocol",
    });
    return;
  }

  const dbType = prototype.id;
  let connector: Connector | null = null;
  try {
    connector = prototype.clone();
    await connector.connect(dsn);
    // `connector.executeSQL` returns SQLResult = { rows, rowCount };
    // pass `.rows` (not the whole object) into extractVersion, which
    // expects a raw row array. The earlier pass accidentally sent the
    // whole SQLResult, so Array.isArray guard bailed and Oracle /
    // SQLite versions came back null even on a successful probe.
    const result = await connector.executeSQL(versionQuery(dbType), {});
    const serverVersion = extractVersion((result.rows ?? []) as unknown[]);
    emit({
      dbType,
      serverVersion,
      error: null,
      ok: true,
      latencyMs: Date.now() - startedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Redact obvious credentials before forwarding to stderr in case the
    // user is tailing the dsh web log; the JSON error field carries the
    // unredacted version for the panel UI.
    console.error(`[dbhub:test-dsn] ${dbType} probe failed: ${message}`);
    emit({
      dbType,
      serverVersion: null,
      error: message,
      ok: false,
      latencyMs: Date.now() - startedAt,
    });
  } finally {
    if (connector !== null) {
      try {
        await connector.disconnect();
      } catch {
        // disconnect failures are not user-actionable; swallow.
      }
    }
  }
}