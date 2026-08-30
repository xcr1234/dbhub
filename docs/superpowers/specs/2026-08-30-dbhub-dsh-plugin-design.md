# DBHub 作为 DSH 数据库工具插件 — 设计规格

- 日期：2026-08-30
- 状态：已评审通过，待实现
- 目标形态：DSH 动态 Cordis 插件（第一阶段），后续可选提升为正式组合插件

## 1. 背景与目标

DBHub 是一个零依赖、token 高效的数据库 MCP server，支持 PostgreSQL / MySQL / MariaDB / SQL Server / SQLite / Oracle，内置 `execute_sql`、`search_objects`、`explain_sql` 三个 MCP 工具，支持 stdio 与 HTTP 两种 transport，并自带一套 React「Workbench」前端。

本设计的目标是把 DBHub 的能力接入 DeepSeek Harness（DSH），做成一个插件，满足三件事：

1. **让 DSH 系统使用 MCP**：把 DBHub 的数据库工具注册成 DSH 智能体可调用的模型工具（窄范围——插件是 DBHub 的 MCP 客户端桥，不做通用 MCP 客户端框架）。
2. **在设置菜单里配置连接信息**：DSH 设置页新增「数据库」页，配置数据源连接。
3. **在页面上执行 SQL、查看表结构**：DSH 原生 UI 提供 SQL 工作台。

## 2. 已确认的关键决策

| 决策点 | 结论 |
|--------|------|
| MCP 范围 | 窄范围：DBHub 作为 DSH 的数据库工具，不做通用 MCP 客户端 |
| SQL 控制台 UI | DSH 原生 UI（不内嵌 DBHub 自带 Workbench） |
| 连接配置范围 | 先单连接，数据结构用列表表示、预留多源 |
| 通信方案 | 方案 A：真 MCP 客户端，spawn 标准 `dbhub`（stdio MCP），DBHub 零改动 |

## 3. 硬约束

DSH 动态 Cordis 插件是纯 JavaScript：

- Host / Client 代码**不能用 `import` / `require`**，也没有 TypeScript / 打包器。
- 因此 DBHub 的 TypeScript 源码及其驱动依赖（`pg`、`mysql2`、`mssql`、`mariadb`、`oracledb`、`sql.js`、`@modelcontextprotocol/sdk`、`ssh2` 等，含原生模块）**不能被插件直接加载**。

推论：DBHub 必须以**独立子进程**运行，插件作为「桥」通过 stdio 与它通信。这是整个架构的基石。

其他约束：

- 动态插件是**进程内临时**的：不跨 DSH 进程重启；`settings` 命名空间注册随插件 fiber 移除。
- Host 没有 `fetch` 内置（Builtins 仅 `ctx/harness/console/btoa/atob/TextEncoder/TextDecoder`），所以出站 HTTP 不可用——这进一步确认走 stdio 管道而非 HTTP。
- DSH 无现成的 MCP 客户端服务，需在插件内实现 MCP 客户端协议。

## 4. 总体架构

```
┌─ DSH 浏览器（Client，React via React.createElement）─────────────────┐
│  settings.section "数据库"（id: dbhub）                                │
│   ├─ 连接配置表单（类型/主机/端口/用户/密码/库名/只读）                 │
│   └─ SQL 工作台（编辑器 + 运行 + 结果表 + 表结构）                     │
│        ↓ host.call(method, args)  （Package 私有 JSON RPC）           │
┌─ DSH Node 进程（Host，纯 JS）────────────────────────────────────────┐
│  1. DBHub 进程管理 ── subprocess.spawn node <dbhub>/dist/index.js    │
│  2. MCP 客户端 ── 行分帧 / initialize / tools/list / tools/call      │
│  3. 模型工具 ── execute_sql / search_objects / explain_sql           │
│  4. 配置持久化 ── settings(ns) + credentials(密码)                   │
│  5. Client RPC ── harness.handle(...)                                │
└───────────────────────────↓ stdio MCP（JSON-RPC 2.0）────────────────┘
                        DBHub 子进程（标准 MCP server，零改动）
```

## 5. Host 组件

### 5.1 DBHub 进程管理

- 用 `subprocess.spawn` 启动 `node <dbhub>/dist/index.js`，stdio 管道分离：
  - **stdout**：MCP JSON-RPC 消息流（逐行）。
  - **stderr**：DBHub 日志（DBHub 全部日志走 `console.error`），单独消费、用于诊断，不与协议流混合。
- 单连接时通过环境变量 `DSN` 注入连接串（DBHub 单连接模式读取 `DSN` env）。
- 保存一个进程句柄引用；插件 stop / update 时终止进程树（`ctx.effect` 内做清理）。
- 配置变更 = 终止旧进程 + 用新 DSN 重新 spawn（DBHub 启动时连库）。

> 实现前必查：`subprocess.spawn` 的 `SubprocessSpawnSpec`（stdio 分置写法）与 `SubprocessHandle`（stdin 写、stdout/stderr 读、terminate、done）的确切字段。目录查询返回的 `referencedTypes` 为空，这是唯一必须在写代码前补齐的 API 细节。

### 5.2 MCP 客户端

- 行分隔 JSON-RPC 2.0：每条请求写一行（JSON + `\n`）到子进程 stdin；从 stdout 按行读，按 `id` 关联响应。
- 握手：`initialize` → 读 `protocolVersion` / `capabilities` / `serverInfo` / `instructions` → `notifications/initialized`。
- `tools/list` → 取 `execute_sql` / `search_objects` / `explain_sql` 的 `name` / `description` / `inputSchema`。
- `tools/call` → 执行工具，解析 `result.content`（text 与/或 structuredContent），抽成 UI/模型都能用的普通 JSON。
- 请求级超时；单请求失败 reject 并重置行缓冲，不影响后续请求。

### 5.3 模型工具

- 用 `harness.registerTool` 注册 `execute_sql`、`search_objects`、`explain_sql`。
- 工具 schema 直接来自 MCP `tools/list` 的 `inputSchema`（避免手写漂移）；注册前用 `Tool.listTools` 检查命名冲突，必要时加前缀。
- 每个工具 execute：确保子进程存活 → `tools/call` → 解析 content → 返回 JSON。
- DBHub 的 readonly / allowed-keywords 校验原样透传；DSH 端可选再加只读声明。

### 5.4 配置持久化

- 非敏感字段（`type`/`host`/`port`/`user`/`database`/`readonly`/`max_rows`）存 DSH `settings` 命名空间 `dbhub`（zod schema，`register`）。
- **密码**存 DSH `credentials`（`set` 持久化、`resolve` 每次现读、不回显到 UI）。
- 保存时：settings + credentials 拼 DSN → 作为 `DSN` env 重启子进程。
- 结构上把「源」建模为列表（`sources: [{...}]`），第一版只允许一个元素，多源留作后续扩展。
- 回退方案：若动态插件无法构造 `settings.register` 需要的 schema（见 §12），则改为用 `fs` 在 workspace 写一个 JSON 配置文件（如 `.dbhub/dsh-config.json`），密码仍存 `credentials`。

### 5.5 Client RPC

`harness.handle` 暴露（均为 JSON、Client→Host）：

- `getStatus()`：子进程 / 连接状态、当前源、错误信息。
- `saveConfig(config)`：写 settings + credentials，重建 DSN 并重启子进程，返回状态。
- `testConnection()`：触发一次轻量 `search_objects`（pattern 空、detail names）验证连通。
- `runSql({ sql, sourceId? })`：`tools/call` `execute_sql`，返回 `{ columns, rows, rowCount }`。
- `describeTable({ sourceId? })` / `searchObjects({ pattern, detail })`：走 `search_objects`，返回 schema/表/列结构。

## 6. Client 组件

- 注册 `settings.section`，`id: "dbhub"`，`label: "数据库"`。
- 页面内两个区块：
  1. **连接配置**：类型下拉（postgres/mysql/mariadb/sqlserver/sqlite/oracle）、host/port/user/database 输入、密码框（已存则掩码占位）、只读开关、`max_rows`；「保存」与「测试连接」按钮。
  2. **SQL 工作台**：`textarea` 编辑器 + 「运行」按钮 + 结果 `table`；「表结构」区用 `search_objects`（detail=full）渲染成表/树。
- 顶部状态条：显示子进程 / 连接状态（运行中 / 未连接 / 错误信息）。
- 全部用 `React.createElement`（无 JSX）；数据只取叶子字段，不回显完整 props。

## 7. 数据流

- **配置**：表单保存 → `host.call('saveConfig')` → Host 写 settings + credentials → 重建 DSN → 重启 DBHub → 返回状态 → UI 刷新状态条。
- **SQL**：编辑器输入 → 运行 → `host.call('runSql')` → MCP `tools/call execute_sql` → 解析 → 返回表格数据 → UI 渲染。
- **表结构**：`host.call('searchObjects', {detail:'full'})` → MCP `tools/call search_objects` → 返回结构 → UI 渲染。
- **智能体调用**：模型直接调 `execute_sql` 等 DSH 工具 → 同一座 MCP 桥 → 结果回模型。

## 8. 错误处理

- spawn 失败（dbhub 未 build / 缺 node）：状态条报错；工具返回明确错误。
- 连库失败：MCP call 返回错误 → 工具/RPC 透出。
- 协议错误 / 超时：单请求 reject + 行缓冲重置，不影响下一次请求。
- 密码缺失：保存时校验，提示补全。

## 9. 生命周期

- 全部副作用归 `ctx.effect` / `ctx.on`：子进程句柄、工具注册、settings 命名空间、RPC handler 都随插件 fiber 释放。
- stop / update：终止子进程树、注销工具与 RPC、移除命名空间。

## 10. 测试与验证

- MCP 分帧（编/解码、id 关联、多行/粘包）先用 DBHub 自带 SQLite demo（`--demo`，内存库）做端到端验证，成本最低。
- 验收清单：
  1. 智能体调用 `execute_sql` 拿到正确结果。
  2. 设置页保存后连接生效（状态条变「运行中」）。
  3. SQL 工作台跑查询、看表结构正确。
  4. 插件 stop 后子进程被终止、无残留。

## 11. 部署路径

- **第一阶段（本次）**：动态 Cordis 插件，进程内临时，跑通全部能力。
- **第二阶段（可选，另开）**：提升为正式组合插件——持久化跨重启、可捆绑或依赖 DBHub；涉及 `editing-cordis-compositions` 与宿主组合，不在本次实现范围。

## 12. 待实现前确认

- `subprocess.spawn` / `SubprocessHandle` 的确切 stdio 与读写字段（见 5.1）。
- DBHub `execute_sql` / `search_objects` / `explain_sql` 的 `inputSchema` 与结果 content 形态（实现时读 `src/tools/*.ts` 确认，用于工具 schema 与结果解析）。
- `harness.registerTool` 的 `ToolDefinition` 结构（用 `Tool.listTools` 参考现有工具）。
- `settings.register` 需要的 schema（schemastery/zod）在动态插件（无 `z` Builtin）里如何构造；若不可行则走 §5.4 的 `fs` JSON 回退方案。

## 13. 范围外（明确不做）

- 通用 MCP 客户端框架、接入任意 MCP server。
- 内嵌 DBHub 自带 Workbench。
- 多数据源 UI（结构预留，第一版只单连接）。
- 正式组合插件的持久化/捆绑。
