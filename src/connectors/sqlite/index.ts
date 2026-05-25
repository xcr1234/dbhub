/**
 * SQLite Connector Implementation (No C/C++ compilation required for standard platforms)
 *
 * Implements SQLite database connectivity for DBHub using 'sqlite' and 'sqlite3' (Pre-built binaries)
 * To use this connector: Set DSN=sqlite:///path/to/database.db in your .env file
 */

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
import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
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

  private sourceId: string = "default";

  getId(): string {
    return this.sourceId;
  }

  clone(): Connector {
    return new SQLiteConnector();
  }

  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    const parsedConfig = await this.dsnParser.parse(dsn, config);
    this.dbPath = parsedConfig.dbPath;

    try {
      // Determine open mode
      let mode = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;
      if (config?.readonly && this.dbPath !== ':memory:') {
        mode = sqlite3.OPEN_READONLY;
      }

      // Open connection using 'sqlite' promise wrapper
      this.db = await open({
        filename: this.dbPath,
        driver: sqlite3.Database,
        mode: mode
      });

      if (initScript) {
        await this.db.exec(initScript);
      }
    } catch (error) {
      console.error("Failed to connect to SQLite database:", error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      try {
        await this.db.close();
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
    if (!this.db) throw new Error("Not connected to SQLite database");

    try {
      const rows = await this.db.all<SQLiteTableNameRow[]>(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `);
      return rows.map((row) => row.name);
    } catch (error) {
      throw error;
    }
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    if (!this.db) throw new Error("Not connected to SQLite database");

    try {
      const row = await this.db.get<SQLiteTableNameRow>(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name = ?
      `, tableName);
      return !!row;
    } catch (error) {
      throw error;
    }
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    if (!this.db) throw new Error("Not connected to SQLite database");

    try {
      const indexInfoRows = await this.db.all<{ index_name: string; is_unique: number }[]>(`
        SELECT name as index_name, 0 as is_unique
        FROM sqlite_master 
        WHERE type = 'index' AND tbl_name = ?
      `, tableName);

      const quotedTableName = quoteIdentifier(tableName, "sqlite");
      const indexListRows = await this.db.all<{ name: string; unique: number }[]>(
        `PRAGMA index_list(${quotedTableName})`
      );

      const indexUniqueMap = new Map<string, boolean>();
      for (const indexListRow of indexListRows) {
        indexUniqueMap.set(indexListRow.name, indexListRow.unique === 1);
      }

      const tableInfo = await this.db.all<SQLiteTableInfo[]>(
        `PRAGMA table_info(${quotedTableName})`
      );

      const pkColumns = tableInfo.filter((col) => col.pk > 0).map((col) => col.name);
      const results: TableIndex[] = [];

      for (const indexInfo of indexInfoRows) {
        const quotedIndexName = quoteIdentifier(indexInfo.index_name, "sqlite");
        const indexDetailRows = await this.db.all<{ name: string }[]>(
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
    if (!this.db) throw new Error("Not connected to SQLite database");

    try {
      const quotedTableName = quoteIdentifier(tableName, "sqlite");
      const rows = await this.db.all<SQLiteTableInfo[]>(`PRAGMA table_info(${quotedTableName})`);

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
            const rows = await this.db.all(processedStatement, ...params);
            return { rows, rowCount: rows.length };
          } catch (error) {
            console.error(`[SQLite executeSQL] ERROR: ${(error as Error).message}`);
            throw error;
          }
        } else {
          try {
            const params = parameters || [];
            const result = await this.db.run(processedStatement, ...params);
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
            const rows = await this.db.all(statement);
            allRows.push(...rows);
          } else {
            const result = await this.db.run(statement);
            totalChanges += result.changes ?? 0;
          }
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