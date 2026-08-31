#!/usr/bin/env node

import { main, startServer } from "./server.js";
import { loadConnectors } from "./utils/module-loader.js";
import { parseCommandLineArgs } from "./config/env.js";
import { runTestDsn } from "./test-dsn.js";

// Re-exported so embedders (the DSH plugin) can spin up the server
// programmatically without spawning a child process.
export { startServer, type StartServerOptions } from "./server.js";

// Each load function uses a string literal so the bundler can resolve it.
const connectorModules = [
  { load: () => import("./connectors/postgres/index.js"), name: "PostgreSQL", driver: "pg" },
  { load: () => import("./connectors/sqlserver/index.js"), name: "SQL Server", driver: "mssql" },
  { load: () => import("./connectors/sqlite/index.js"), name: "SQLite", driver: "better-sqlite3" },
  { load: () => import("./connectors/mysql/index.js"), name: "MySQL", driver: "mysql2" },
  { load: () => import("./connectors/mariadb/index.js"), name: "MariaDB", driver: "mariadb" },
  { load: () => import("./connectors/oracle/index.js"), name: "Oracle", driver: "oracle" },
];

// One-shot DSN probe mode. The DSH plugin's "test connection" button
// spawns `node dist/index.js --test-dsn=<dsn>` instead of going through
// the MCP transport; the result is a single JSON line on stdout. We
// intercept this BEFORE the normal main() chain runs so we never print
// the banner, never bind the HTTP listener, never register tools, and
// never start the config watcher — the child process exits as soon as
// the probe finishes.
const testDsnArg = parseCommandLineArgs()["test-dsn"];
if (typeof testDsnArg === "string" && testDsnArg.length > 0) {
  loadConnectors(connectorModules)
    .then(() => runTestDsn(testDsnArg))
    .catch((error) => {
      // `runTestDsn` emits its own JSON line on every code path; this
      // catch only fires when `loadConnectors` itself rejects (e.g. a
      // driver module failed to import). Still emit a JSON line so the
      // caller always has something to parse.
      console.error("Fatal error:", error);
      process.stdout.write(`${JSON.stringify({
        ok: false,
        latencyMs: 0,
        dbType: undefined,
        serverVersion: null,
        error: error instanceof Error ? error.message : String(error),
      })}\n`);
      process.exitCode = 1;
    });
} else {
  loadConnectors(connectorModules)
    .then(() => main())
    .catch((error) => {
      console.error("Fatal error:", error);
      process.exit(1);
    });
}

// Reference to keep the import live across tree-shaking.
void startServer;
