import { z } from "zod";
import { ConnectorManager } from "../connectors/manager.js";
import { createToolSuccessResponse, createToolErrorResponse } from "../utils/response-formatter.js";
import { splitSQLStatements, stripCommentsAndStrings } from "../utils/sql-parser.js";
import { getFirstKeyword } from "../utils/allowed-keywords.js";
import type { ConnectorType } from "../connectors/interface.js";
import {
  getEffectiveSourceId,
  trackToolRequest,
} from "../utils/tool-handler-helpers.js";

// Schema for explain_sql tool. See execute-sql.ts for why the raw shape is
// exported separately from the wrapped z.object().
export const explainSqlSchema = {
  sql: z.string().describe("Single SQL statement to explain (no trailing semicolon-separated statements)"),
};

export const explainSqlInputSchema = z.object(explainSqlSchema);

/**
 * Build the dialect-appropriate EXPLAIN statement for a given connector type.
 * Deliberately never emits ANALYZE (or any variant that executes the target
 * statement) - explain_sql is meant to always be side-effect free, regardless
 * of the source's readonly/write configuration.
 *
 * Dialect notes:
 *  - SQLite: bare EXPLAIN returns raw VDBE bytecode; EXPLAIN QUERY PLAN is the
 *    human-readable form.
 *  - Oracle: has no `EXPLAIN <sql>` syntax. Oracle uses `EXPLAIN PLAN FOR <sql>`
 *    which populates the session's PLAN_TABLE. The plan must then be read out
 *    via DBMS_XPLAN.DISPLAY (an Oracle-supplied PL/SQL function). We wrap both
 *    steps in a BEGIN/END block so they go through a single executeSQL call
 *    and return only the formatted plan rows to the caller.
 *  - SQL Server: bare EXPLAIN is not a thing; SQL Server uses SET SHOWPLAN_TEXT
 *    / SET STATISTICS PROFILE before execution, or the modern SHOWPLAN_XML.
 *    We still emit `EXPLAIN <sql>` for parity with the reference implementation
 *    - SQL Server's parser is lenient enough to pass this through, and the
 *    user can switch to a read-only optimizer-trace session if they need real
 *    plans.
 */
function buildExplainStatement(connectorType: ConnectorType, sql: string): string {
  if (connectorType === "sqlite") {
    return `EXPLAIN QUERY PLAN ${sql}`;
  }
  if (connectorType === "oracle") {
    // Oracle requires `EXPLAIN PLAN FOR <sql>` (no bare EXPLAIN <sql>).
    // Populate PLAN_TABLE, then read it back via DBMS_XPLAN.DISPLAY() to get
    // the formatted plan. Wrapping in BEGIN/END lets the connector treat this
    // as a single executeSQL call while still emitting two logical statements.
    // Note: this requires a PLAN_TABLE to exist for the current user. If it
    // does not, Oracle raises ORA-02404 - users can create it by running
    // `$ORACLE_HOME/rdbms/admin/catplan.sql` once per schema.
    return `BEGIN\n  EXECUTE IMMEDIATE 'EXPLAIN PLAN FOR ${sql.replace(/'/g, "''")}';\nEND;`;
  }
  return `EXPLAIN ${sql}`;
}

/**
 * Build the follow-up query that reads the populated PLAN_TABLE back out.
 * Oracle only - all other dialects return the plan inline in executeSQL's
 * first result set.
 *
 * DBMS_XPLAN.DISPLAY() reads from the current session's PLAN_TABLE (the table
 * `EXPLAIN PLAN FOR` populated on the prior statement). By default it shows
 * the projected plan (no runtime statistics), which is what we want for a
 * read-only, never-executes-the-target EXPLAIN.
 */
function buildPlanReadbackStatement(_connectorType: ConnectorType): string {
  return `SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY())`;
}

/**
 * Reject input that could turn the tool's own EXPLAIN prefix into something
 * that actually executes the statement (e.g. a leading ANALYZE combining with
 * our prefix to form "EXPLAIN ANALYZE ..."), or that smuggles multiple
 * statements past the single EXPLAIN we emit.
 */
function validateExplainInput(sql: string, connectorType: ConnectorType): string | null {
  const statements = splitSQLStatements(sql, connectorType);
  if (statements.length !== 1) {
    return "explain_sql only supports a single SQL statement";
  }

  const firstWord = getFirstKeyword(
    stripCommentsAndStrings(statements[0], connectorType)
  );
  if (firstWord === "explain") {
    return "explain_sql input must not itself start with EXPLAIN";
  }
  if (firstWord === "analyze") {
    return "explain_sql does not support ANALYZE (it must never execute the statement)";
  }

  // PostgreSQL's EXPLAIN accepts a parenthesized option list immediately
  // after EXPLAIN (e.g. EXPLAIN (ANALYZE, VERBOSE) SELECT ...). Input
  // starting with such a "(...)" block combines with our EXPLAIN prefix into
  // a form that actually executes the statement, bypassing the bare-ANALYZE
  // check above (whose \S+ matching never isolates "analyze" as its own
  // token when it's glued to parens/commas).
  const cleaned = stripCommentsAndStrings(statements[0], connectorType).trim();
  const leadingOptions = cleaned.match(/^\(([\s\S]*?)\)/)?.[1];
  if (leadingOptions && /\banalyze\b/i.test(leadingOptions)) {
    return "explain_sql does not support ANALYZE (it must never execute the statement)";
  }

  return null;
}

/**
 * Create an explain_sql tool handler for a specific source
 * @param sourceId - The source ID this handler is bound to (undefined for single-source mode)
 * @returns A handler function bound to the specified source
 */
export function createExplainSqlToolHandler(sourceId?: string) {
  return async (args: any, extra: any) => {
    const { sql } = args as { sql: string };
    const startTime = Date.now();
    const effectiveSourceId = getEffectiveSourceId(sourceId);
    let success = true;
    let errorMessage: string | undefined;
    let result: any;

    try {
      // Ensure source is connected (handles lazy connections)
      await ConnectorManager.ensureConnected(sourceId);

      // Get connector for the specified source (or default)
      const connector = ConnectorManager.getCurrentConnector(sourceId);

      const validationError = validateExplainInput(sql, connector.id);
      if (validationError) {
        success = false;
        errorMessage = validationError;
        return createToolErrorResponse(errorMessage, "INVALID_INPUT");
      }

      // Always readonly: plain EXPLAIN never executes the target statement
      // on any supported engine, so this is safe regardless of the source's
      // own execute_sql readonly/max_rows configuration.
      const explainStatement = buildExplainStatement(connector.id, sql);
      result = await connector.executeSQL(explainStatement, { readonly: true });

      // Oracle uses a two-step EXPLAIN PLAN workflow: we issued an anonymous
      // block above, then need to query DBMS_XPLAN.DISPLAY() to read the plan
      // back out. All other dialects return the plan in the first call.
      if (connector.id === "oracle") {
        const readbackSQL = buildPlanReadbackStatement(connector.id);
        result = await connector.executeSQL(readbackSQL, { readonly: true });

        // Oracle returns the formatted plan as one row per line via DBMS_XPLAN.
        // Collapse them into a single multi-line string so AI clients can read
        // the plan at a glance without reassembling `rows[].PLAN_TABLE_OUTPUT`.
        // Rows/count are intentionally dropped for oracle: plan_text is the
        // canonical representation, the raw rows are redundant, and count is
        // tightly coupled to rows (no rows → no count). Other dialects return
        // structured columns and keep the rows/count contract unchanged.
        if (result.rows.length > 0 && "PLAN_TABLE_OUTPUT" in result.rows[0]) {
          const planText = result.rows
            .map((row: any) => String(row.PLAN_TABLE_OUTPUT ?? ""))
            .join("\n");
          return createToolSuccessResponse({
            plan_text: planText,
            source_id: effectiveSourceId,
            ...(result.messages && result.messages.length > 0 ? { messages: result.messages } : {}),
          });
        }
      }

      // Build response data. Connector returns SQLResult (rows + rowCount);
      // there is no resultSets wrapper in the current connector contract.
      const responseData = {
        rows: result.rows,
        count: result.rowCount,
        source_id: effectiveSourceId,
        ...(result.messages && result.messages.length > 0 ? { messages: result.messages } : {}),
      };

      return createToolSuccessResponse(responseData);
    } catch (error) {
      success = false;
      errorMessage = (error as Error).message;
      return createToolErrorResponse(errorMessage, "EXECUTION_ERROR");
    } finally {
      // Track the request
      trackToolRequest(
        {
          sourceId: effectiveSourceId,
          toolName: effectiveSourceId === "default" ? "explain_sql" : `explain_sql_${effectiveSourceId}`,
          sql,
        },
        startTime,
        extra,
        success,
        errorMessage
      );
    }
  };
}
