/**
 * SQLite Connector Implementation (WebAssembly Version - No C/C++ compilation)
 *
 * Implements SQLite database connectivity for DBHub using 'sql.js'
 * To use this connector: Set DSN=sqlite:///path/to/database.db in your .env file
 */

import fs from "fs/promises";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";

import {
  Connector,
  ConnectorType,
  ConnectorRegistry,
  DSNParser,
  SQLResult,
  TableColumn,
  TableIndex,
  StoredProcedure,
  ExecuteOptions,
  ConnectorConfig,
} from "../interface.js";
import { quoteIdentifier } from "../../utils/identifier-quoter.js";
import { SafeURL } from "../../utils/safe-url.js";
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";
import { SQLRowLimiter } from "../../utils/sql-row-limiter.js";
import { splitSQLStatements } from "../../utils/sql-parser.js";

class SQLiteDSNParser implements DSNParser {
  async parse(dsn: string, config?: ConnectorConfig): Promise<{ dbPath: string }> {
    if (!this.isValidDSN(dsn)) {
      const obfuscatedDSN = obfuscateDSNPassword(dsn);
      const expectedFormat = this.getSampleDSN();
      throw new Error(
        `Invalid SQLite DSN format.\nProvided: ${obfuscatedDSN}\nExpected: ${expectedFormat}`
      );
    }

    try {
      const url = new SafeURL(dsn);
      let dbPath: string;

      if (url.hostname === "" && url.pathname === "/:memory:") {
        dbPath = ":memory:";
      } else {
        if (url.pathname.startsWith("//")) {
          dbPath = url.pathname.substring(2);
        } else if (url.pathname.match(/^\/[A-Za-z]:\//)) {
          dbPath = url.pathname.substring(1);
        } else {
          dbPath = url.pathname;
        }
      }

      return { dbPath };
    } catch (error) {
      throw new Error(
        `Failed to parse SQLite DSN: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getSampleDSN(): string {
    return "sqlite:///path/to/database.db";
  }

  isValidDSN(dsn: string): boolean {
    try {
      return dsn.startsWith('sqlite://');
    } catch (error) {
      return false;
    }
  }
}

interface SQLiteTableInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface SQLiteTableNameRow {
  name: string;
}

export class SQLiteConnector implements Connector {
  id: ConnectorType = "sqlite";
  name = "SQLite";
  dsnParser = new SQLiteDSNParser();

  private db: Database | null = null;
  private dbPath: string = ":memory:";
  private SQL: SqlJsStatic | null = null;

  private sourceId: string = "default";

  getId(): string {
    return this.sourceId;
  }

  clone(): Connector {
    return new SQLiteConnector();
  }

  // Helper method to save in-memory database to disk
  private async saveToDisk(): Promise<void> {
    if (this.dbPath !== ':memory:' && this.db) {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      await fs.writeFile(this.dbPath, buffer);
    }
  }

  // Wrapper equivalent to sqlite3 db.all()
  private async dbAll<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    if (!this.db) throw new Error("Not connected to SQLite database");
    const stmt = this.db.prepare(sql);
    try {
      if (params && params.length > 0) {
        stmt.bind(params);
      }
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as unknown as T);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  // Wrapper equivalent to sqlite3 db.get()
  private async dbGet<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
    const rows = await this.dbAll<T>(sql, params);
    return rows.length > 0 ? rows[0] : undefined;
  }

  // Wrapper equivalent to sqlite3 db.run()
  private async dbRun(sql: string, params: any[] = []): Promise<{ changes: number }> {
    if (!this.db) throw new Error("Not connected to SQLite database");
    this.db.run(sql, params);
    return { changes: this.db.getRowsModified() };
  }

  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    const parsedConfig = await this.dsnParser.parse(dsn, config);
    this.dbPath = parsedConfig.dbPath;

    try {
      if (!this.SQL) {
        // Initialize WebAssembly engine
        this.SQL = await initSqlJs();
      }

      if (this.dbPath === ':memory:') {
        this.db = new this.SQL.Database();
      } else {
        try {
          // Try to load existing file from disk into memory
          const fileBuffer = await fs.readFile(this.dbPath);
          this.db = new this.SQL.Database(fileBuffer);
        } catch (err: any) {
          if (err.code === 'ENOENT') {
            // File does not exist
            if (config?.readonly) {
              throw new Error(`Database file not found in readonly mode: ${this.dbPath}`);
            }
            // Create new database and immediately save to verify write access
            this.db = new this.SQL.Database();
            await this.saveToDisk();
          } else {
            throw err;
          }
        }
      }

      if (initScript) {
        this.db.run(initScript);
        await this.saveToDisk();
      }
    } catch (error) {
      console.error("Failed to connect to SQLite database (sql.js):", error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      try {
        await this.saveToDisk(); // Ensure any pending changes are flushed
        this.db.close();
        this.db = null;
      } catch (error) {
        console.error('Error during SQLite disconnect:', error);
        this.db = null;
      }
    }
    return Promise.resolve();
  }

  async getSchemas(): Promise<string[]> {
    if (!this.db) throw new Error("Not connected to SQLite database");
    return ["main"];
  }

  async getTables(schema?: string): Promise<string[]> {
    try {
      const rows = await this.dbAll<SQLiteTableNameRow[]>(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `);
      return rows.map((row: any) => row.name);
    } catch (error) {
      throw error;
    }
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    try {
      const row = await this.dbGet<SQLiteTableNameRow>(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name = ?
      `, [tableName]);
      return !!row;
    } catch (error) {
      throw error;
    }
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    try {
      const indexInfoRows = await this.dbAll<{ index_name: string; is_unique: number }>(`
        SELECT name as index_name, 0 as is_unique
        FROM sqlite_master 
        WHERE type = 'index' AND tbl_name = ?
      `, [tableName]);

      const quotedTableName = quoteIdentifier(tableName, "sqlite");
      const indexListRows = await this.dbAll<{ name: string; unique: number }>(
        `PRAGMA index_list(${quotedTableName})`
      );

      const indexUniqueMap = new Map<string, boolean>();
      for (const indexListRow of indexListRows) {
        indexUniqueMap.set(indexListRow.name, indexListRow.unique === 1);
      }

      const tableInfo = await this.dbAll<SQLiteTableInfo>(
        `PRAGMA table_info(${quotedTableName})`
      );

      const pkColumns = tableInfo.filter((col) => col.pk > 0).map((col) => col.name);
      const results: TableIndex[] = [];

      for (const indexInfo of indexInfoRows) {
        const quotedIndexName = quoteIdentifier(indexInfo.index_name, "sqlite");
        const indexDetailRows = await this.dbAll<{ name: string }>(
          `PRAGMA index_info(${quotedIndexName})`
        );
        const columnNames = indexDetailRows.map((row) => row.name);

        results.push({
          index_name: indexInfo.index_name,
          column_names: columnNames,
          is_unique: indexUniqueMap.get(indexInfo.index_name) || false,
          is_primary: false,
        });
      }

      if (pkColumns.length > 0) {
        results.push({
          index_name: "PRIMARY",
          column_names: pkColumns,
          is_unique: true,
          is_primary: true,
        });
      }

      return results;
    } catch (error) {
      throw error;
    }
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    try {
      const quotedTableName = quoteIdentifier(tableName, "sqlite");
      const rows = await this.dbAll<SQLiteTableInfo>(`PRAGMA table_info(${quotedTableName})`);

      return rows.map((row) => ({
        column_name: row.name,
        data_type: row.type,
        is_nullable: (row.notnull === 1 || row.pk > 0) ? "NO" : "YES",
        column_default: row.dflt_value,
        description: null,
      }));
    } catch (error) {
      throw error;
    }
  }

  async getStoredProcedures(schema?: string, routineType?: "procedure" | "function"): Promise<string[]> {
    if (!this.db) throw new Error("Not connected to SQLite database");
    return [];
  }

  async getStoredProcedureDetail(procedureName: string, schema?: string): Promise<StoredProcedure> {
    throw new Error(
      "SQLite does not support stored procedures. Functions are defined programmatically through the SQLite API, not stored in the database."
    );
  }

  async executeSQL(sql: string, options: ExecuteOptions, parameters?: any[]): Promise<SQLResult> {
    if (!this.db) throw new Error("Not connected to SQLite database");

    try {
      const statements = splitSQLStatements(sql, "sqlite");
      let dataModified = false;

      if (statements.length === 1) {
        let processedStatement = statements[0];
        const trimmedStatement = statements[0].toLowerCase().trim();
        const isReadStatement = trimmedStatement.startsWith('select') ||
          trimmedStatement.startsWith('with') ||
          trimmedStatement.startsWith('explain') ||
          trimmedStatement.startsWith('analyze') ||
          (trimmedStatement.startsWith('pragma') &&
            (trimmedStatement.includes('table_info') ||
              trimmedStatement.includes('index_info') ||
              trimmedStatement.includes('index_list') ||
              trimmedStatement.includes('foreign_key_list')));

        if (options.maxRows) {
          processedStatement = SQLRowLimiter.applyMaxRows(processedStatement, options.maxRows);
        }

        if (isReadStatement) {
          try {
            const params = parameters || [];
            const rows = await this.dbAll(processedStatement, params);
            return { rows, rowCount: rows.length };
          } catch (error) {
            console.error(`[SQLite executeSQL] ERROR: ${(error as Error).message}`);
            throw error;
          }
        } else {
          try {
            const params = parameters || [];
            const result = await this.dbRun(processedStatement, params);
            await this.saveToDisk(); // Persist changes immediately on write operations
            return { rows: [], rowCount: result.changes ?? 0 };
          } catch (error) {
            console.error(`[SQLite executeSQL] ERROR: ${(error as Error).message}`);
            throw error;
          }
        }
      } else {
        if (parameters && parameters.length > 0) {
          throw new Error("Parameters are not supported for multi-statement queries in SQLite");
        }

        let totalChanges = 0;
        let allRows: any[] = [];

        // Execute statements sequentially
        for (let statement of statements) {
          const trimmedStatement = statement.toLowerCase().trim();
          const isReadStatement = trimmedStatement.startsWith('select') ||
            trimmedStatement.startsWith('with') ||
            trimmedStatement.startsWith('explain') ||
            trimmedStatement.startsWith('analyze') ||
            (trimmedStatement.startsWith('pragma') &&
              (trimmedStatement.includes('table_info') ||
                trimmedStatement.includes('index_info') ||
                trimmedStatement.includes('index_list') ||
                trimmedStatement.includes('foreign_key_list')));

          if (isReadStatement) {
            statement = SQLRowLimiter.applyMaxRows(statement, options.maxRows);
            const rows = await this.dbAll(statement);
            allRows.push(...rows);
          } else {
            const result = await this.dbRun(statement);
            totalChanges += result.changes ?? 0;
            dataModified = true;
          }
        }

        if (dataModified) {
          await this.saveToDisk(); // Batch persist at the end of the transaction/multiple statements
        }

        return { rows: allRows, rowCount: totalChanges + allRows.length };
      }
    } catch (error) {
      throw error;
    }
  }
}

// Register the SQLite connector
const sqliteConnector = new SQLiteConnector();
ConnectorRegistry.register(sqliteConnector);