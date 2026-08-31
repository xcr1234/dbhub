import oracledb from "oracledb";
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
import { SafeURL } from "../../utils/safe-url.js";
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";
import { SQLRowLimiter } from "../../utils/sql-row-limiter.js";
import { splitSQLStatements } from "../../utils/sql-parser.js";
import { quoteIdentifier } from "../../utils/identifier-quoter.js";


const oracleClientPath = process.env.ORACLE_CLIENT_LIB_DIR

if(oracleClientPath){
  oracledb.initOracleClient({
    libDir: oracleClientPath
  })
}

/**
 * Oracle DSN Parser
 * Handles DSN strings like: oracle://user:password@localhost:1521/XEPDB1
 */
class OracleDSNParser implements DSNParser {
  async parse(dsn: string, config?: ConnectorConfig): Promise<oracledb.PoolAttributes> {
    if (!this.isValidDSN(dsn)) {
      const obfuscatedDSN = obfuscateDSNPassword(dsn);
      const expectedFormat = this.getSampleDSN();
      throw new Error(
        `Invalid Oracle DSN format.\nProvided: ${obfuscatedDSN}\nExpected: ${expectedFormat}`
      );
    }

    try {
      const url = new SafeURL(dsn);

      // Extract service name or SID from the path
      const serviceName = url.pathname ? url.pathname.substring(1) : "";
      const port = url.port || "1521";
      const connectString = `${url.hostname}:${port}/${serviceName}`;

      const poolConfig: oracledb.PoolAttributes = {
        user: url.username,
        password: url.password,
        connectString: connectString,
        // Optional tuning for connection pools
        poolMin: 1,
        poolMax: 10,
        poolIncrement: 1,
      };

      // Apply connection timeout if specified (Node-oracledb configures timeouts at the DB level via sqlnet.ora typically,
      // but poolTimeout can be adjusted)
      if (config?.connectionTimeoutSeconds !== undefined) {
        poolConfig.poolTimeout = config.connectionTimeoutSeconds;
      }

      return poolConfig;
    } catch (error) {
      throw new Error(
        `Failed to parse Oracle DSN: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getSampleDSN(): string {
    return "oracle://scott:tiger@localhost:1521/ORCLCDB";
  }

  isValidDSN(dsn: string): boolean {
    try {
      return dsn.startsWith("oracle://");
    } catch (error) {
      return false;
    }
  }
}

/**
 * Oracle Connector Implementation
 */
export class OracleConnector implements Connector {
  // Assuming "oracle" will be added to ConnectorType in interface.ts
  id: ConnectorType = "oracle" as ConnectorType;
  name = "Oracle";
  dsnParser = new OracleDSNParser();

  private pool: oracledb.Pool | null = null;
  private sourceId: string = "default";
  private queryTimeoutMs?: number;

  getId(): string {
    return this.sourceId;
  }

  clone(): Connector {
    return new OracleConnector();
  }

  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    try {
      // Set to output objects instead of arrays by default
      oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
      // Optional: Initialize Oracle Client (Thin mode is default in oracledb 6.0+)
      // Allow ORACLE_CLIENT_LIB_DIR env var to switch to Thick mode with a local Oracle Client lib path.
      const oracleClientPath = process.env.ORACLE_CLIENT_LIB_DIR;
      if (oracleClientPath) {
        oracledb.initOracleClient({
          libDir: oracleClientPath,
        });
      }

      const poolOptions = await this.dsnParser.parse(dsn, config);
      this.pool = await oracledb.createPool(poolOptions);

      if (config?.queryTimeoutSeconds !== undefined) {
        this.queryTimeoutMs = config.queryTimeoutSeconds * 1000;
      }

      // Test the connection
      const conn = await this.pool.getConnection();
      try {
        await conn.execute("SELECT 1 FROM DUAL");

        if (initScript) {
          await conn.execute(initScript);
        }
      } finally {
        await conn.close();
      }
    } catch (err) {
      console.error("Failed to connect to Oracle database:", err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.close(0);
      this.pool = null;
    }
  }

  async getSchemas(): Promise<string[]> {
    if (!this.pool) throw new Error("Not connected to database");
    const conn = await this.pool.getConnection();
    try {
      // 使用 ORACLE_MAINTAINED = 'N' 过滤掉所有系统自带的 Schema (适用于 Oracle 12c+)
      const result = await conn.execute(`
        SELECT USERNAME
        FROM ALL_USERS
        ORDER BY USERNAME
      `);
      return (result.rows as any[]).map((row) => row.USERNAME);
    } catch (error) {
      console.error("Error getting schemas:", error);
      throw error;
    } finally {
      await conn.close();
    }
  }

  async getTables(schema?: string): Promise<string[]> {
    if (!this.pool) throw new Error("Not connected to database");
    const conn = await this.pool.getConnection();
    try {
      const targetSchema = schema ? schema.toUpperCase() : await this.getCurrentSchema(conn);

      const result = await conn.execute(
        `
        SELECT TABLE_NAME 
        FROM ALL_TABLES 
        WHERE OWNER = :schema
        ORDER BY TABLE_NAME
        `,
        { schema: targetSchema }
      );
      return (result.rows as any[]).map((row) => row.TABLE_NAME);
    } finally {
      await conn.close();
    }
  }

  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    if (!this.pool) throw new Error("Not connected to database");
    const conn = await this.pool.getConnection();
    try {
      const targetSchema = schema ? schema.toUpperCase() : await this.getCurrentSchema(conn);

      const result = await conn.execute(
        `
        SELECT COUNT(*) AS CNT
        FROM ALL_TABLES 
        WHERE OWNER = :schema 
        AND TABLE_NAME = :tableName
        `,
        { schema: targetSchema, tableName: tableName.toUpperCase() }
      );

      return (result.rows as any[])[0].CNT > 0;
    } finally {
      await conn.close();
    }
  }

  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    if (!this.pool) throw new Error("Not connected to database");
    const conn = await this.pool.getConnection();
    try {
      const targetSchema = schema ? schema.toUpperCase() : await this.getCurrentSchema(conn);

      const result = await conn.execute(
        `
        SELECT 
          i.INDEX_NAME, 
          ic.COLUMN_NAME, 
          i.UNIQUENESS,
          c.CONSTRAINT_TYPE
        FROM ALL_INDEXES i
        JOIN ALL_IND_COLUMNS ic 
          ON i.INDEX_NAME = ic.INDEX_NAME AND i.OWNER = ic.INDEX_OWNER
        LEFT JOIN ALL_CONSTRAINTS c 
          ON c.INDEX_NAME = i.INDEX_NAME AND c.OWNER = i.OWNER AND c.CONSTRAINT_TYPE = 'P'
        WHERE i.TABLE_OWNER = :schema 
          AND i.TABLE_NAME = :tableName
        ORDER BY i.INDEX_NAME, ic.COLUMN_POSITION
        `,
        { schema: targetSchema, tableName: tableName.toUpperCase() }
      );

      const indexMap = new Map<string, { columns: string[]; is_unique: boolean; is_primary: boolean; }>();

      for (const row of (result.rows as any[])) {
        const indexName = row.INDEX_NAME;
        const columnName = row.COLUMN_NAME;
        const isUnique = row.UNIQUENESS === 'UNIQUE';
        const isPrimary = row.CONSTRAINT_TYPE === 'P';

        if (!indexMap.has(indexName)) {
          indexMap.set(indexName, {
            columns: [],
            is_unique: isUnique,
            is_primary: isPrimary,
          });
        }
        indexMap.get(indexName)!.columns.push(columnName);
      }

      return Array.from(indexMap.entries()).map(([indexName, indexInfo]) => ({
        index_name: indexName,
        column_names: indexInfo.columns,
        is_unique: indexInfo.is_unique,
        is_primary: indexInfo.is_primary,
      }));
    } finally {
      await conn.close();
    }
  }

  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    if (!this.pool) throw new Error("Not connected to database");
    const conn = await this.pool.getConnection();
    try {
      const targetSchema = schema ? schema.toUpperCase() : await this.getCurrentSchema(conn);

      const result = await conn.execute(
        `
        SELECT 
          c.COLUMN_NAME as "column_name",
          c.DATA_TYPE as "data_type",
          c.NULLABLE as "is_nullable",
          c.DATA_DEFAULT as "column_default",
          cc.COMMENTS as "description"
        FROM ALL_TAB_COLS c
        LEFT JOIN ALL_COL_COMMENTS cc 
          ON c.OWNER = cc.OWNER AND c.TABLE_NAME = cc.TABLE_NAME AND c.COLUMN_NAME = cc.COLUMN_NAME
        WHERE c.OWNER = :schema
          AND c.TABLE_NAME = :tableName
          AND c.USER_GENERATED = 'YES' -- Exclude hidden/system columns
        ORDER BY c.COLUMN_ID
        `,
        { schema: targetSchema, tableName: tableName.toUpperCase() }
      );

      return (result.rows as any[]).map((row: any) => ({
        ...row,
        // Oracle returns 'Y' or 'N' for NULLABLE; map it to standard format if needed, or leave as string
        is_nullable: row.is_nullable === 'Y' ? 'YES' : 'NO',
        description: row.description || null,
      }));
    } finally {
      await conn.close();
    }
  }

  async getTableComment(tableName: string, schema?: string): Promise<string | null> {
    if (!this.pool) throw new Error("Not connected to database");
    const conn = await this.pool.getConnection();
    try {
      const targetSchema = schema ? schema.toUpperCase() : await this.getCurrentSchema(conn);

      const result = await conn.execute(
        `
        SELECT COMMENTS
        FROM ALL_TAB_COMMENTS
        WHERE OWNER = :schema
        AND TABLE_NAME = :tableName
        `,
        { schema: targetSchema, tableName: tableName.toUpperCase() }
      );

      const rows = result.rows as any[];
      return rows.length > 0 ? rows[0].COMMENTS || null : null;
    } finally {
      await conn.close();
    }
  }

  async getStoredProcedures(schema?: string, routineType?: "procedure" | "function"): Promise<string[]> {
    if (!this.pool) throw new Error("Not connected to database");
    const conn = await this.pool.getConnection();
    try {
      const targetSchema = schema ? schema.toUpperCase() : await this.getCurrentSchema(conn);

      let typeFilter = "OBJECT_TYPE IN ('PROCEDURE', 'FUNCTION')";
      if (routineType === "function") typeFilter = "OBJECT_TYPE = 'FUNCTION'";
      if (routineType === "procedure") typeFilter = "OBJECT_TYPE = 'PROCEDURE'";

      const result = await conn.execute(
        `
        SELECT OBJECT_NAME
        FROM ALL_OBJECTS
        WHERE OWNER = :schema
        AND ${typeFilter}
        ORDER BY OBJECT_NAME
        `,
        { schema: targetSchema }
      );

      return (result.rows as any[]).map((row) => row.OBJECT_NAME);
    } finally {
      await conn.close();
    }
  }

  async getStoredProcedureDetail(procedureName: string, schema?: string): Promise<StoredProcedure> {
    if (!this.pool) throw new Error("Not connected to database");
    const conn = await this.pool.getConnection();
    try {
      const targetSchema = schema ? schema.toUpperCase() : await this.getCurrentSchema(conn);
      const targetProcedure = procedureName.toUpperCase();

      // Determine if it's a PROCEDURE or FUNCTION
      const objResult = await conn.execute(
        `SELECT OBJECT_TYPE FROM ALL_OBJECTS WHERE OWNER = :schema AND OBJECT_NAME = :procName AND OBJECT_TYPE IN ('PROCEDURE', 'FUNCTION')`,
        { schema: targetSchema, procName: targetProcedure }
      );

      const objRows = objResult.rows as any[];
      if (objRows.length === 0) {
        throw new Error(`Stored procedure '${procedureName}' not found in ${targetSchema}`);
      }
      const procType = objRows[0].OBJECT_TYPE.toLowerCase();

      // Extract parameter list
      const argResult = await conn.execute(
        `
        SELECT ARGUMENT_NAME, IN_OUT, DATA_TYPE 
        FROM ALL_ARGUMENTS 
        WHERE OWNER = :schema 
          AND OBJECT_NAME = :procName
          AND ARGUMENT_NAME IS NOT NULL
        ORDER BY POSITION
        `,
        { schema: targetSchema, procName: targetProcedure }
      );

      const parameters = (argResult.rows as any[])
        .map(p => `${p.ARGUMENT_NAME} ${p.IN_OUT} ${p.DATA_TYPE}`)
        .join(", ");

      // Attempt to get definition body from ALL_SOURCE
      let definition = "";
      try {
        const srcResult = await conn.execute(
          `
          SELECT TEXT 
          FROM ALL_SOURCE 
          WHERE OWNER = :schema AND NAME = :procName 
          ORDER BY LINE
          `,
          { schema: targetSchema, procName: targetProcedure }
        );
        definition = (srcResult.rows as any[]).map(r => r.TEXT).join("");
      } catch (err) {
        console.error(`Error fetching source for ${targetProcedure}: ${err}`);
      }

      return {
        procedure_name: targetProcedure,
        procedure_type: procType as "procedure" | "function",
        language: "plsql",
        parameter_list: parameters,
        definition: definition || undefined,
      };
    } finally {
      await conn.close();
    }
  }

  private async getCurrentSchema(conn: oracledb.Connection): Promise<string> {
    const result = await conn.execute(`SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') as SCHEMA FROM DUAL`);
    return (result.rows as any[])[0].SCHEMA;
  }

  async executeSQL(sql: string, options: ExecuteOptions, parameters?: any[]): Promise<SQLResult> {
    if (!this.pool) throw new Error("Not connected to database");
    const conn = await this.pool.getConnection();
    try {
      // Oracle timeout is configured on execute via options
      const execOptions: oracledb.ExecuteOptions = {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        autoCommit: true // Default true for executing read/write commands
      };

      if (this.queryTimeoutMs) {
        execOptions.timeout = this.queryTimeoutMs; // Requires oracledb 6.x+ or specific OCI config
      }

      // Oracle's `conn.execute()` only accepts a single statement; the
      // presence of a `;` anywhere other than the end triggers
      // ORA-03405. Multi-statement scripts must be wrapped in an
      // anonymous PL/SQL block (`BEGIN ... COMMIT; END;`).
      //
      // We split the input unconditionally — `splitSQLStatements` is a
      // no-op for a single statement — and wrap whenever the result has
      // more than one element. The previous version only did this when
      // `options.maxRows` was set, which left plain `INSERT; INSERT; COMMIT;` scripts broken.
      const statements = splitSQLStatements(sql, "oracle");
      const isMultiStatement = statements.length > 1;

      // `FETCH FIRST n ROWS ONLY` (Oracle 12c+) is a SELECT-only
      // limiter; it must not be applied to DML. The earlier code only
      // considered this branch when `maxRows` was set; we keep that
      // gate but lift the BEGIN/END wrap out so it always applies for
      // multi-statement input.
      const processedStatements = options.maxRows
        ? statements.map((statement) => {
            if (statement.trim().toUpperCase().startsWith('SELECT') && !statement.toUpperCase().includes('FETCH FIRST')) {
              return `${statement} FETCH FIRST ${options.maxRows} ROWS ONLY`;
            }
            return SQLRowLimiter.applyMaxRows(statement, options.maxRows);
          })
        : statements;

      const processedSQL = isMultiStatement
        ? `BEGIN\n${processedStatements.join(';\n')};\nEND;`
        : (processedStatements[0] ?? sql);

      const result = await conn.execute(processedSQL, parameters || [], execOptions);

      const rows = (result.rows as any[]) || [];
      // SELECT/EXPLAIN return rows but rowsAffected is undefined (so || 0 collapses
      // to 0 and the caller sees a misleading "empty" result). DML leaves rows
      // empty but populates rowsAffected. Prefer rows.length when present.
      const rowCount = rows.length > 0 ? rows.length : (result.rowsAffected || 0);

      return { rows, rowCount };
    } catch (error) {
      console.error("Error executing query:", error);
      throw error;
    } finally {
      await conn.close();
    }
  }
}

// Create and register the connector
const oracleConnector = new OracleConnector();
ConnectorRegistry.register(oracleConnector);