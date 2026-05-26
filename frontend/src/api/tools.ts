import { ApiError } from './errors';

export interface QueryResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
}

interface McpResponse {
  jsonrpc: string;
  id: string;
  result?: {
    content: Array<{ type: string; text: string }>;
  };
  error?: {
    code: number;
    message: string;
  };
}

interface ToolResultData {
  success: boolean;
  data: {
    rows: Record<string, any>[];
    count: number;
    source_id: string;
  } | null;
  error: string | null;
}

export async function executeTool(
  toolName: string,
  args: Record<string, any>
): Promise<QueryResult> {
  const response = await fetch('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    }),
  });

  if (!response.ok) {
    throw new ApiError(`HTTP error: ${response.status}`, response.status);
  }

  const mcpResponse: McpResponse = await response.json();

  if (mcpResponse.error) {
    throw new ApiError(mcpResponse.error.message, mcpResponse.error.code);
  }

  if (!mcpResponse.result?.content?.[0]?.text) {
    throw new ApiError('Invalid response format', 500);
  }

  const toolResult: ToolResultData = JSON.parse(mcpResponse.result.content[0].text);

  if (!toolResult.success || toolResult.error) {
    throw new ApiError(toolResult.error || 'Tool execution failed', 500);
  }

  // search_objects returns {success, data: {object_type, pattern, count, results, ...}}
  // execute_sql returns {success, data: {rows, count, source_id}}
  // Normalize: extract the inner data, handling different response formats
  const innerData = toolResult.data as Record<string, any>;

  // Check if data has rows (execute_sql format) or results (search_objects format)
  if (innerData.rows !== undefined) {
    // execute_sql format
    const rows = innerData.rows;
    if (rows.length === 0) {
      return { columns: [], rows: [], rowCount: innerData.count };
    }
    const columns = Object.keys(rows[0]);
    const rowArrays = rows.map((row: Record<string, any>) => columns.map((col) => row[col]));
    return {
      columns,
      rows: rowArrays,
      rowCount: innerData.count,
    };
  } else if (innerData.results !== undefined) {
    // search_objects format
    const results = innerData.results;
    if (results.length === 0) {
      return { columns: [], rows: [], rowCount: innerData.count };
    }
    const columns = Object.keys(results[0]);
    const rowArrays = results.map((row: Record<string, any>) => columns.map((col) => row[col]));
    return {
      columns,
      rows: rowArrays,
      rowCount: innerData.count,
    };
  }

  return { columns: [], rows: [], rowCount: 0 };
}
