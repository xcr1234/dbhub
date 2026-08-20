/**
 * Built-in tool constants
 * Central location for built-in tool names used throughout the codebase
 */

export const BUILTIN_TOOL_EXECUTE_SQL = "execute_sql";
export const BUILTIN_TOOL_SEARCH_OBJECTS = "search_objects";
export const BUILTIN_TOOL_EXPLAIN_SQL = "explain_sql";

// The default tools every source gets when it has no [[tools]] entries of its
// own. explain_sql is auto-enabled by default.
export const BUILTIN_TOOLS = [
  BUILTIN_TOOL_EXECUTE_SQL,
  BUILTIN_TOOL_SEARCH_OBJECTS,
  BUILTIN_TOOL_EXPLAIN_SQL,
] as const;

// All recognized built-in tool names. Used wherever a tool name needs to be
// identified as "built-in" (skip custom-tool validation, reserve the naming
// pattern). Currently identical to BUILTIN_TOOLS — kept as a separate alias
// so future opt-in tools can be added without touching default-enable logic.
export const ALL_BUILTIN_TOOL_NAMES = [
  ...BUILTIN_TOOLS,
] as const;
