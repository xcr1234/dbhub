# DBHub 作为 DSH 数据库工具插件 — 设计规格

- 日期：2026-08-30
- 状态：已评审通过，待实现
- 目标形态：DSH 动态 Cordis 插件（第一阶段），后续可选提升为正式组合插件

## 1. 背景与目标

DBHub 是一个零依赖、token 高效的数据库 MCP server，支持 PostgreSQL / MySQL / MariaDB / SQL Server / SQLite / Oracle，内置 `execute_sql`、`search_objects`、`explain_sql` 三个 MCP 工具，支持 stdio 与 HTTP 两种 transport，并自带一套 React「Workbench」前端。DBHub 原生支持**多数据源**（TOML `[[sources]]`）。

本设计把 DBHub 的能力接入 DeepSeek Harness（DSH），做成插件，满足三件事：

1. **让 DSH 系统使用 MCP**：把 DBHub 的数据库工具注册成 DSH 智能体可调用的模型工具（窄范围——插件是 DBHub 的 MCP 客户端桥，不做通用 MCP 客户端框架）。
2. **在设置菜单里配置连接信息**：DSH 设置页新增「数据库」页，配置**多个**数据源连接。
3. **在页面上执行 SQL、查看表结构**：DSH 原生 UI 提供 SQL 工作台，按源切换。

## 2. 已确认的关键决策

| 决策点 | 结论 |
|--------|------|
| MCP 范围 | 窄范围：DBHub 作为 DSH 的数据库工具，不做通用 MCP 客户端 |
| SQL 控制台 UI | DSH 原生 UI（不内嵌 DBHub 自带 Workbench） |
| 连接配置范围 | **直接支持多数据源**（DBHub 原生能力，UI 做源列表 + 增删改） |
| 通信方案 | 方案 A：真 MCP 客户端，spawn 标准 `dbhub`（stdio MCP），DBHub 零改动 |
| 模型工具形态 | **统一工具 + `source_id` 参数**（3 个稳定工具名，内部路由到按源命名的 MCP 工具） |

## 3. 硬约束

DSH 动态 Cordis 插件是纯 JavaScript：

- Host / Client 代码**不能用 `import` / `require`**，也没有 TypeScript / 打包器。
- 因此 DBHub 的 TypeScript 源码及其驱动依赖（`pg`、`mysql2`、`mssql`、`mariadb`、`oracledb`、`sql.js`、`@modelcontextprotocol/sdk`、`ssh2` 等，含原生模块）**不能被插件直接加载**。

推论：DBHub 必须以**独立子进程**运行，插件作为「桥」通过 stdio 与它通信。

其他约束：

- 动态插件是**进程内临时**的：不跨 DSH 进程重启；`settings` 命名空间注册随插件 fiber 移除。
- Host 没有 `fetch` 内置（Builtins 仅 `ctx/harness/console/btoa/atob/TextEncoder/TextDecoder`），出站 HTTP 不可用——确认走 stdio 管道。
- DSH 无现成 MCP 客户端服务，需在插件内实现 MCP 客户端协议。
- 多源下 DBHub 按源命名工具（`execute_sql_<id>`），无统一 `source_id` 参数；统一工具名 + `source_id` 由插件这一层补齐。

## 4. 总体架构

```
┌─ DSH 浏览器（Client，React via React.createElement）─────────────────┐
│  settings.section "数据库"（id: dbhub）                                │
│   ├─ 数据源列表 + 源表单（增/删/改/设默认/测试连接）                     │
│   ├─ SQL 工作台（源下拉 + 编辑器 + 运行 + 结果表）                      │
│   └─ 表结构（源下拉 + 对象类型 + 搜索 + 结构树/表）                     │
│        ↓ host.call(method, args)  （Package 私有 JSON RPC）           │
┌─ DSH Node 进程（Host，纯 JS）────────────────────────────────────────┐
│  1. DBHub 进程管理 ── 写 TOML → spawn node <dbhub>/dist/index.js     │
│                      --config=<toml>（stdio）                        │
│  2. MCP 客户端 ── 行分帧 / initialize / tools/list / tools/call      │
│  3. 模型工具 ── execute_sql / search_objects / explain_sql（统一名）   │
│  4. 配置持久化 ── settings(sources[]) + credentials(各源密码)          │
│  5. Client RPC ── harness.handle(...)                                │
└───────────────────────────↓ stdio MCP（JSON-RPC 2.0）────────────────┘
                    DBHub 子进程（标准 MCP server，零改动）
```

## 5. Host 组件

### 5.1 DBHub 进程管理

- 多源必须走 TOML：插件用 `fs` 把当前源列表写成一份 `dbhub.toml`（`[[sources]]`），再 `subprocess.spawn` 启动 `node <dbhub>/dist/index.js --config=<toml 路径>`，stdio 管道分离：
  - **stdout**：MCP JSON-RPC 消息流（逐行）。
  - **stderr**：DBHub 日志（DBHub 全部日志走 `console.error`），单独消费、用于诊断。
- 保存一个进程句柄；插件 stop / update 时终止进程树（`ctx.effect` 内清理）。
- 配置变更（增/删/改源、改密码）= 重写 TOML → 终止旧进程 → 重新 spawn（DBHub 启动时连库）。
- 源列表为空：不 spawn，状态条显示「未配置数据源」。

> 实现前必查：`subprocess.spawn` 的 `SubprocessSpawnSpec`（stdio 分置写法）与 `SubprocessHandle`（stdin 写、stdout/stderr 读、terminate、done）的确切字段；`fs.writeText` 的写路径与 sandbox 限制。目录查询返回的 `referencedTypes` 为空，需在写代码前补齐。

### 5.2 MCP 客户端

- 行分隔 JSON-RPC 2.0：每条请求写一行（JSON + `\n`）到子进程 stdin；从 stdout 按行读，按 `id` 关联响应。
- 握手：`initialize` → 读 `protocolVersion` / `capabilities` / `serverInfo` / `instructions` → `notifications/initialized`。
- `tools/list` → 取按源命名的工具（`execute_sql_<id>` 等）的 `name` / `description` / `inputSchema`。
- `tools/call` → 执行工具，解析 `result.content`（text 与/或 structuredContent），抽成普通 JSON。
- 请求级超时；单请求失败 reject 并重置行缓冲，不影响后续请求。

### 5.3 模型工具（统一名 + source_id）

- 注册 3 个稳定 DSH 工具：`execute_sql`、`search_objects`、`explain_sql`。
- 每个工具的 schema = DBHub 原生 schema **外加** `source_id` 参数（enum 为已配置源 id；源数 >1 时必填，=1 或 0 时省略/默认第一个源）。
- execute 时：`source_id` → DBHub 按源工具名（`<tool>_<normalizedId>`）→ `tools/call`。工具名映射由插件从 `tools/list` 结果 + 源 id 规范化规则建立（见 §12）。
- 为保持映射简单，插件对源 id 强制约束 `[a-z0-9_]+`（DBHub 用 `normalizeSourceId` 生成工具名后缀，源 id 合法则映射确定）。
- DBHub 的 readonly / allowed-keywords 校验原样透传；DSH 端可选再加只读声明。
- 备选（记录在案、暂不采用）：忠实镜像 DBHub 按源工具名（`execute_sql_prod`…）。缺点：工具名随源增删而变、数量随源线性增长；优点：零映射。统一名 + `source_id` 更稳、更贴合 DBHub 文档所述 `source_id` 路由意图。

### 5.4 配置持久化

- 非敏感字段存 DSH `settings` 命名空间 `dbhub`，值为 `{ sources: SourceConfigLike[] }`：
  - 必填：`id`（`[a-z0-9_]+`）、`type`（postgres/mysql/mariadb/sqlserver/sqlite/oracle）。
  - 常见：`host`、`port`、`database`、`user`、`description`、`sslmode`。
  - 高级（可选）：`connection_timeout`、`query_timeout`、`lazy`、`search_path`、`readonly`（execute_sql）、`max_rows`。
  - SQLite：用 `database` 存文件路径，忽略 host/port/user。
- **密码**：每个源一条，存 DSH `credentials`（键 = 源 id），`resolve` 每次现读、不回显到 UI。
- 生成 TOML 时把 settings + credentials 合并写入（密码进 `[[sources]]` 的 `password` 字段），供 DBHub 连接；该 TOML 为运行时临时产物，插件 stop 时清理。
- 首个源视为默认源（DBHub 语义：第一个源是 default）。

### 5.5 Client RPC

`harness.handle` 暴露（均为 JSON、Client→Host）：

- `getStatus()`：子进程 / 各源连接状态、默认源、错误信息。
- `listSources()`：返回源列表（含已脱敏字段，密码只回「是否已配置」）。
- `saveSource(source)`：新增/更新一个源，写 settings + credentials → 重建 TOML → 重启子进程。
- `deleteSource(id)` / `setDefault(id)`：改列表 → 重建 TOML → 重启。
- `testConnection(id)`：对该源 `tools/call search_objects`（detail=names, limit=1）验证连通。
- `runSql({ sourceId, sql })`：`tools/call execute_sql_<id>`，返回 `{ columns, rows, rowCount }`。
- `searchObjects({ sourceId, objectType, pattern, schema, table, detailLevel, limit })`：`tools/call search_objects_<id>`，返回结构对象。

## 6. Client 组件

- 注册 `settings.section`，`id: "dbhub"`，`label: "数据库"`。
- 页面三段：
  1. **数据源**：源列表（每行 = 类型图标 + id + default 徽标 + 连接状态），「新增 / 编辑 / 删除 / 设为默认 / 测试连接」。编辑态显示表单：类型下拉、id、description、host/port/database/user、password（已存则掩码占位）、sslmode 下拉、只读开关；高级字段折叠。表单按 `type` 自适应（SQLite 只显示文件路径）。
  2. **SQL 工作台**：源下拉 + `textarea` 编辑器 + 「运行」+ 结果 `table`。
  3. **表结构**：源下拉 + 对象类型（schema/table/column/procedure/function/index）+ 搜索框 + 详情级别（names/summary/full）+ 结构树/表。
- 顶部状态条：子进程 / 连接状态（运行中 / 未连接 / 错误信息）。
- 全部用 `React.createElement`（无 JSX）；数据只取叶子字段，不回显完整 props。

## 7. 数据流

- **配置**：表单保存 → `host.call('saveSource')` → Host 写 settings + credentials → 重建 TOML → 重启 DBHub → 返回状态 → UI 刷新源列表与状态条。
- **SQL**：选源 + 输入 → `host.call('runSql', {sourceId, sql})` → `tools/call execute_sql_<id>` → 解析 → 表格数据 → UI 渲染。
- **表结构**：`host.call('searchObjects', {sourceId, ...})` → `tools/call search_objects_<id>` → 结构 → UI 渲染。
- **智能体调用**：模型调 `execute_sql`（带 `source_id`）→ 同一座 MCP 桥 → 结果回模型。

## 8. 错误处理

- spawn 失败（dbhub 未 build / 缺 node）：状态条报错；工具返回明确错误。
- 单个源连库失败：该源标记「未连接」，不影响其它源；工具调用该源时透出错误。
- 协议错误 / 超时：单请求 reject + 行缓冲重置，不影响后续请求。
- 密码缺失 / 源 id 非法 / 重名：保存时校验，提示修正。

## 9. 生命周期

- 全部副作用归 `ctx.effect` / `ctx.on`：子进程句柄、工具注册、settings 命名空间、RPC handler、临时 TOML 文件都随插件 fiber 释放。
- stop / update：终止子进程树、注销工具与 RPC、移除命名空间、清理临时 TOML。

## 10. 测试与验证

- MCP 分帧（编/解码、id 关联、多行/粘包）先用 DBHub SQLite 内存库做端到端验证（两个 SQLite 源即可覆盖多源命名与路由）。
- 验收清单：
  1. 配置两个源后，`tools/list` 返回按源命名的工具，DSH 侧 3 个统一工具 + `source_id` 枚举正确。
  2. 智能体调用 `execute_sql(sql, source_id=...)` 命中正确源。
  3. 设置页增/删/改/设默认/测试连接，状态与源列表正确刷新。
  4. SQL 工作台按源切换跑查询、看表结构正确。
  5. 插件 stop 后子进程终止、临时 TOML 清理、无残留。

## 11. 部署路径

- **第一阶段（本次）**：动态 Cordis 插件，进程内临时，跑通全部能力。
- **第二阶段（可选，另开）**：提升为正式组合插件——持久化跨重启、可捆绑或依赖 DBHub；涉及 `editing-cordis-compositions` 与宿主组合，不在本次实现范围。

## 12. 待实现前确认

- `subprocess.spawn` / `SubprocessHandle` 的 stdio 与读写字段（见 5.1）。
- `fs.writeText` 的写路径与 sandbox 策略（TOML 落盘位置）。
- `settings.register` 需要的 schema（schemastery/zod）在动态插件（无 `z` Builtin）里如何构造；若不可行则用 `fs` 写 JSON 配置 + `credentials` 存密码的回退方案。
- `credentials` 服务存「按源密码」用 CredentialRef 还是 CredentialKey 的确切写法（`set`/`unset` vs `modifyRecord`）。
- `harness.registerTool` 的 `ToolDefinition` 结构（用 `Tool.listTools` 参考现有工具）。
- DBHub 工具结果 content 形态（`createToolSuccessResponse` 的 structuredContent），用于结果解析。

## 13. 范围外（明确不做）

- 通用 MCP 客户端框架、接入任意 MCP server。
- 内嵌 DBHub 自带 Workbench。
- SSH 隧道、AWS IAM 认证、自定义 SQL 工具（`[[tools]]` custom tools）——第一版不做，但源数据结构与 TOML 生成预留字段。
- 正式组合插件的持久化/捆绑。
