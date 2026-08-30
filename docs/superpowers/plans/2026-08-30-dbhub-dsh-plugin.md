# DBHub 作为 DSH 数据库工具插件 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 DBHub 的 MCP 能力接入 DSH，做成一个动态 Cordis 插件：DSH 智能体可调用 `execute_sql` / `search_objects` / `explain_sql` 三个统一工具（带 `source_id` 路由），设置页新增「数据库」页支持多数据源配置、SQL 工作台与表结构浏览。

**Architecture:** 插件是纯 JS 的 Host + Client 两半。Host 半以「桥」形态工作：把当前源列表写成 TOML → `subprocess.spawn` 启动 `node <dbhub>/dist/index.js --config=<toml>`（stdio MCP 子进程，DBHub 零改动）→ 自实现行分帧 MCP 客户端（`initialize` / `tools/list` / `tools/call`）→ 注册 3 个统一模型工具 + `source_id` 路由 + `harness.handle` RPC。Client 半在 `settings.section` 注册「数据库」页，通过 `host.call` 驱动 Host。

**Tech Stack:** 动态 Cordis 插件（纯 JS，无 import/TS/JSX）；Host Services：`subprocess` / `fs` / `credentials` / `timer`；Client：`React.createElement` + `host.call` + `styles.insert` + `slots`。DBHub 以 `dist/index.js` 标准 MCP server 形态被消费。

**Spec:** `docs/superpowers/specs/2026-08-30-dbhub-dsh-plugin-design.md`

## Global Constraints

- 纯 JS：Host/Client 代码**不能**用 `import`/`require`/TypeScript/JSX/打包器；不能假设 `fetch`/`process`/`window`/`setTimeout` 等全局存在。
- 零改动主项目：不修改 DBHub 源码/配置/目录结构；只读消费 `dist/index.js`；插件代码不落盘到 DBHub 仓库。
- DBHub 以独立子进程运行（stdio MCP），插件是桥，不是通用 MCP 客户端。
- 动态插件进程内临时：不跨 DSH 进程重启；所有副作用归 `ctx.effect`，stop/update 时释放（子进程、工具、RPC、临时 TOML）。
- **源 id 语法（本计划对 spec §5.3 的收紧）：`^[a-z][a-z0-9]*$`（小写字母开头 + 小写字母数字，无下划线无连字符）。** 依据：DBHub `normalizeSourceId` 把 `[^a-zA-Z0-9]` 全部替换为 `_`（非单射，`prod-db` 与 `prod.db` 会撞车）；credentials 的 `CredentialKey` 段语法是 `/^[a-z][a-z0-9-]*$/`（小写、字母开头、允许连字符、**不允许下划线**）。二者的交集 `^[a-z][a-z0-9]*$` 同时保证：工具名映射确定、credential key 合法。spec §5.3 原写 `[a-z0-9_]+`，此处按收紧后语法实现。
- **配置持久化走回退方案（spec §12 已预留）：Host 无 schemastery `z` Builtin，`settings.register(ns, schema: z<T>)` 不可用** → 非敏感字段用 `fs` 写 JSON，密码用 `credentials`（CredentialKey `dbhub/<id>`）。
- 密码绝不回显、不落 `[[sources]]` 以外的持久层；临时 TOML 含明文密码，stop 时清空。
- 统一工具名 `execute_sql` / `search_objects` / `explain_sql` + `source_id` 参数；多源时 `source_id` 必填，单源时可省略（默认第一源）。
- 范围外（第一版不做）：SSH 隧道、AWS IAM、自定义 `[[tools]]`、内嵌 DBHub Workbench、正式组合插件持久化。`readonly`/`max_rows` 在源数据里预留字段但 v1 不生成 `[[tools]]`。

---

## 执行模型说明（动态插件 vs 传统代码库）

本计划没有「仓库文件 + git commit」。交付物是 **Package**（`code.host` / `code.client` 各一段纯 JS 函数体），版本化与提交由 `cordis_define`（产生不可变 packageId）+ `cordis_run`（激活）完成。TDD 的「写测试→跑→实现→跑→提交」映射为：**写代码 → `cordis_define` → `cordis_run` → 用 `Tool.listTools` / 模型调用 / 浏览器验证 → （define 即已提交该不可变版本）**。每个 Task 产出该版本完整的 `code.host`（或 `code.client`），后一版本是前一版本的超集。

## 已确认的运行时契约（执行者不必重新发现，但写码前仍可复验）

**Host Builtins（`code.host` 可用）：** `ctx`（get/on/provide/effect）、`harness`（`handle(method,handler):disposer`、`defineTool(def)`、`registerTool(ctx,tool):disposer`）、`console`、`btoa/atob`、`TextEncoder/TextDecoder`。**无** `fetch`/`process`/`require`/`setTimeout`/`z`。

**Host Services（`ctx.get` 或 `inject`）：**
- `subprocess.spawn(spec): SubprocessHandle`；`spec = { argv: string[], cwd: string, stdio: { stdin:'ignore'|'pipe'|{data}, stdout:'pipe'|'inherit'|{maxBytes,spill?}, stderr: 同上 }, graceMs: number, signal?, env? }`。
- `SubprocessHandle = { pid, stdin: Writable|undefined, stdout: Readable|undefined, stderr: Readable|undefined, collected, done: Promise<{exitCode,signal}>, terminate(): void, waitForExit(signal?): Promise<boolean> }`（`stdin/stdout/stderr` 仅在 `'pipe'` 模式下存在）。
- `fs.resolve(path, {cwd?}): Promise<FsTarget>`、`fs.processPath(target): string`（子进程可打开的标准绝对路径）、`fs.stat/readText/writeText(target, content)`、`fs.listDir`。**注意：`fs` 无 `mkdir`/`unlink`** —— 因此运行时文件直接写在 workspace 根目录（点文件），且用「写空串」清 TOML 而非删除。
- `credentials.readRecord(key)/modifyRecord(key, mutate)/deleteRecord(key)`；`CredentialRecord = {kind:'api-key', key?, env?} | {kind:'grant', payload}`；key 为 `<scope>/<id>` 字符串。
- `timer.timeout(cb, delay): disposer`（`inject:['timer']` 后 `ctx.timeout(...)`）。
- `sandboxPolicy.workspaceRoot: string`（插件私有文件基准路径，`ctx.get('sandboxPolicy')`）。

**Client Builtins：** `ctx`、`React`（createElement/useState/useEffect）、`host.call(method, args?)`、`styles.insert(css):disposer`、`console`。

**Client 槽位 `settings.section`（list, scope=root）：** 注册项 `{ name:'settings.section', id, order?, label? }`；渲染函数收到的 ownerProps 为 `{ close: () => void }`。注册写法：`const slots = ctx.get('slots'); slots.inject('settings.section', () => slots.register({name:'settings.section', id:'dbhub', order:25, label:'数据库'}, (props) => React.createElement(...)))`。

**模型工具（`harness.defineTool` 接受的第一方 `DefineToolOptions` 形状）：** `{ name, description, parameters: { <param>: {type, required?, enum?, description?} }, output: { schema: {type:'json'}, render:(args,value)=>[{type:'text',text:JSON.stringify(value,null,2)}] }, timeoutMs?, execute(args, exec) }`。动态工具必须用 `harness.defineTool(...)` 返回的对象传给 `harness.registerTool(ctx, tool)`。

**DBHub 侧事实（已从源码核实）：**
- `dist/index.js` 存在；`bin` 即 `node dist/index.js`；`--config=<toml>`；`--transport` 默认 `stdio`。
- 多源工具命名：`execute_sql_<normalizeSourceId(id)>` / `search_objects_<id>` / `explain_sql_<id>`；单源时无后缀（`execute_sql`）。`normalizeSourceId = id.replace(/[^a-zA-Z0-9]/g,'_')`。
- 工具输入 schema：`execute_sql`=`{sql:string 必填}`；`search_objects`=`{object_type:enum(schema|table|column|procedure|function|index) 必填, pattern?:string(默认%), schema?:string, table?:string, detail_level:enum(names|summary|full) 默认names, limit?:int 默认100 上限1000}`；`explain_sql`=`{sql:string 必填 单条}`。
- `tools/call` 响应：`{content:[{type:'text', text, mimeType}], isError?}`，其中 `text` = `JSON.stringify({success:true,data})` 或 `JSON.stringify({success:false,error,code})`。`execute_sql` 的 `data={rows,count,source_id}`；`search_objects` 的 `data={object_type,pattern,schema,table,detail_level,count,results,truncated}`；`explain_sql` 的 `data={rows,count,source_id}`。
- TOML `[[sources]]` 字段（`src/types/config.ts`）：`id,type,host,port,database,user,password,sslmode,description,connection_timeout,query_timeout,lazy,search_path`；SQLite 用 `type:"sqlite"` + `database`（路径或 `:memory:`）。

---

## Task 1: Host 桥 —— 持久化 + 子进程 + MCP 客户端 + `dbhub_status` 诊断工具

**Files:**
- Create: `code.host`（Package 第一个版本，Host 半）
- （无仓库文件；`code.client` 本任务为空）

**Interfaces:**
- Consumes: `subprocess` / `fs` / `credentials` / `timer`（硬依赖，`inject`）、`sandboxPolicy`（可选，`ctx.get`）、`harness`（Builtin）。
- Produces（供后续 Task 使用，保持签名一致）：
  - `loadSources(): Promise<SourceConfigLike[]>`（从 `.dbhub-sources.json` 读）
  - `saveSources(sources): Promise<void>`
  - `getPassword(id) / setPassword(id,pw) / deletePassword(id)`（走 `credentials`，key=`dbhub/<id>`）
  - `writeToml(sources): Promise<string>`（返回 TOML 绝对路径，密码已并入 `[[sources]]`）
  - `createMcpClient(handle): { call(method,params,timeoutMs), notify(method,params) }`
  - `start() / stopProcess() / handshake()`
  - `routeToolName(base, sourceId, sources): string`（单源 `base`，多源 `base_<id>`）
  - `callMcpTool(toolName, args, timeoutMs): Promise<data>`
  - 状态字段：`handle` / `running` / `error` / `mcp` / `toolsByName` / `sourcesCache` / `lastStderr`

- [ ] **Step 1: 写 `code.host`（桥版本：持久化 + 进程 + MCP + 诊断工具）**

```js
return {
  name: 'dbhub',
  inject: ['subprocess', 'fs', 'credentials', 'timer'],
  apply(ctx) {
    const DB_TYPES = ['postgres', 'mysql', 'mariadb', 'sqlserver', 'sqlite', 'oracle']
    const ID_RE = /^[a-z][a-z0-9]*$/
    const DBHUB_DIST = 'E:/dev/dbhub/dist/index.js'   // DBHub 仓库 dist 绝对路径，按本机调整
    const SOURCES_FILE = '.dbhub-sources.json'
    const TOML_FILE = '.dbhub-runtime.toml'
    const CRED_SCOPE = 'dbhub'

    let workspaceRoot = ''
    const sp = ctx.get('sandboxPolicy')
    if (sp && typeof sp.workspaceRoot === 'string') workspaceRoot = sp.workspaceRoot

    let handle = undefined
    let running = false
    let error = null
    let mcp = undefined
    let toolsByName = new Map()
    let lastStderr = ''
    let sourcesCache = []

    // ---------- 持久化 ----------
    async function loadSources() {
      try {
        const t = await ctx.fs.resolve(SOURCES_FILE, { cwd: workspaceRoot })
        const info = await ctx.fs.stat(t)
        if (info === undefined) return []
        const arr = JSON.parse(await ctx.fs.readText(t))
        return Array.isArray(arr) ? arr : []
      } catch { return [] }
    }
    async function saveSources(sources) {
      const t = await ctx.fs.resolve(SOURCES_FILE, { cwd: workspaceRoot })
      await ctx.fs.writeText(t, JSON.stringify(sources, null, 2))
    }
    async function getPassword(id) {
      const rec = await ctx.credentials.readRecord(CRED_SCOPE + '/' + id)
      return rec && rec.kind === 'api-key' ? (rec.key || '') : ''
    }
    async function setPassword(id, pw) {
      await ctx.credentials.modifyRecord(CRED_SCOPE + '/' + id, () => ({ kind: 'api-key', key: pw }))
    }
    async function deletePassword(id) {
      await ctx.credentials.deleteRecord(CRED_SCOPE + '/' + id)
    }
    function validateSource(s) {
      if (!s || typeof s.id !== 'string' || !ID_RE.test(s.id)) return 'id 必须匹配 ^[a-z][a-z0-9]*$'
      if (!DB_TYPES.includes(s.type)) return 'type 必须是 ' + DB_TYPES.join('/')
      if (s.type === 'sqlite') { if (!s.database) return 'sqlite 需要 database（路径或 :memory:）' }
      else { if (!s.host || !s.database) return '网络数据库需要 host 与 database' }
      return null
    }

    // ---------- TOML ----------
    async function writeToml(sources) {
      const lines = []
      for (const s of sources) {
        const pw = await getPassword(s.id)
        lines.push('[[sources]]')
        lines.push('id = ' + JSON.stringify(s.id))
        lines.push('type = ' + JSON.stringify(s.type))
        if (s.description) lines.push('description = ' + JSON.stringify(s.description))
        if (s.type === 'sqlite') {
          lines.push('database = ' + JSON.stringify(s.database))
        } else {
          if (s.host) lines.push('host = ' + JSON.stringify(s.host))
          if (s.port) lines.push('port = ' + s.port)
          if (s.database) lines.push('database = ' + JSON.stringify(s.database))
          if (s.user) lines.push('user = ' + JSON.stringify(s.user))
          if (pw) lines.push('password = ' + JSON.stringify(pw))
          if (s.sslmode) lines.push('sslmode = ' + JSON.stringify(s.sslmode))
        }
        if (s.connection_timeout) lines.push('connection_timeout = ' + s.connection_timeout)
        if (s.query_timeout) lines.push('query_timeout = ' + s.query_timeout)
        if (s.lazy !== undefined) lines.push('lazy = ' + (s.lazy ? 'true' : 'false'))
        if (s.search_path) lines.push('search_path = ' + JSON.stringify(s.search_path))
        lines.push('')
      }
      const t = await ctx.fs.resolve(TOML_FILE, { cwd: workspaceRoot })
      await ctx.fs.writeText(t, lines.join('\n'))
      return ctx.fs.processPath(t)
    }

    // ---------- MCP 客户端（行分帧 JSON-RPC 2.0） ----------
    function createMcpClient(h) {
      let nextId = 1
      const pending = new Map()
      let buffer = ''
      h.stdout.on('data', (chunk) => {
        buffer += String(chunk)
        let i
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i).trim()
          buffer = buffer.slice(i + 1)
          if (!line) continue
          let msg
          try { msg = JSON.parse(line) } catch { continue }
          if (msg.id != null && pending.has(msg.id)) {
            const p = pending.get(msg.id)
            pending.delete(msg.id)
            if (p.cancel) p.cancel()
            if (msg.error) p.reject(new Error((msg.error && msg.error.message) || 'MCP 错误'))
            else p.resolve(msg.result)
          }
        }
      })
      function write(obj) { h.stdin.write(JSON.stringify(obj) + '\n') }
      function call(method, params, timeoutMs) {
        return new Promise((resolve, reject) => {
          const id = nextId++
          let cancel
          if (timeoutMs > 0) {
            cancel = ctx.timeout(() => { pending.delete(id); reject(new Error('MCP 超时: ' + method)) }, timeoutMs)
          }
          pending.set(id, { resolve, reject, cancel })
          write({ jsonrpc: '2.0', id, method, params })
        })
      }
      function notify(method, params) { write({ jsonrpc: '2.0', method, params }) }
      return { call, notify }
    }

    // ---------- 进程 ----------
    async function start() {
      await stopProcess()
      const sources = await loadSources()
      sourcesCache = sources
      if (sources.length === 0) { running = false; error = '未配置数据源'; return }
      try {
        const tomlPath = await writeToml(sources)
        const spec = {
          argv: ['node', DBHUB_DIST, '--config=' + tomlPath],
          cwd: workspaceRoot,
          stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
          graceMs: 5000,
        }
        handle = ctx.subprocess.spawn(spec)
        running = true
        error = null
        mcp = createMcpClient(handle)
        handle.stderr.on('data', (c) => { lastStderr = (lastStderr + String(c)).slice(-4000) })
        await handshake()
      } catch (e) {
        running = false
        error = String((e && e.message) || e)
      }
    }
    async function stopProcess() {
      if (handle) { try { handle.terminate() } catch {} ; handle = undefined }
      running = false
      mcp = undefined
      toolsByName = new Map()
    }
    async function handshake() {
      const init = await mcp.call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'dbhub-dsh-plugin', version: '1.0.0' },
      }, 15000)
      mcp.notify('notifications/initialized', undefined)
      const listed = await mcp.call('tools/list', undefined, 15000)
      toolsByName = new Map()
      for (const t of (listed && listed.tools) || []) toolsByName.set(t.name, t)
      return init && init.serverInfo
    }

    // ---------- 路由 / 调用 ----------
    function routeToolName(base, sourceId, sources) {
      const n = sources.length
      if (n === 0) throw new Error('未配置数据源')
      let id
      if (sourceId !== undefined && sourceId !== '') id = sourceId
      else if (n === 1) id = sources[0].id
      else throw new Error('多数据源时 source_id 必填')
      if (!sources.some((s) => s.id === id)) throw new Error('未知数据源: ' + id)
      return n === 1 ? base : base + '_' + id
    }
    async function callMcpTool(toolName, args, timeoutMs) {
      if (!mcp) throw new Error('DBHub 未运行')
      const res = await mcp.call('tools/call', { name: toolName, arguments: args }, timeoutMs)
      const content = (res && res.content) || []
      const textBlock = content.find((c) => c.type === 'text')
      if (!textBlock) throw new Error('tools/call 无文本内容')
      const parsed = JSON.parse(textBlock.text)
      if (parsed.success === false) throw new Error(parsed.error || 'DBHub 工具执行失败')
      return parsed.data
    }

    // ---------- 诊断工具 ----------
    const jsonOutput = {
      schema: { type: 'json' },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    }
    harness.registerTool(ctx, harness.defineTool({
      name: 'dbhub_status',
      description: '查看 DBHub 插件状态：子进程、数据源列表、按源 MCP 工具名。',
      parameters: {},
      output: jsonOutput,
      async execute() {
        const sources = await loadSources()
        return {
          running,
          error,
          pid: handle ? handle.pid : null,
          sources: sources.map((s) => ({ id: s.id, type: s.type, description: s.description || '' })),
          tools: Array.from(toolsByName.keys()),
          stderrTail: lastStderr.slice(-1500),
        }
      },
    }))

    // ---------- 生命周期 ----------
    ctx.effect(() => {
      start()
      return () => {
        stopProcess()
        // 清空含明文密码的临时 TOML
        ctx.fs.resolve(TOML_FILE, { cwd: workspaceRoot })
          .then((t) => ctx.fs.writeText(t, '').catch(() => {}))
          .catch(() => {})
      }
    })
  },
}
```

- [ ] **Step 2: `cordis_define` 定义第一个 Package**

`plugin: { kind: 'new', idPrefix: 'dbhub' }`，`name: 'dbhub-bridge'`，`purpose: 'DBHub MCP 桥：子进程 + 行分帧 MCP 客户端 + 诊断工具'`，`code: { host: <上面代码> }`。记录返回的 `pluginId` / `packageId`。

- [ ] **Step 3: `cordis_run` 激活**

`mode: 'run'`。若无 Client 半且已授权应返回 `starting`；若返回 `awaiting-approval`，向用户说明需在 UI 放行，然后等待系统报告最终结果（不要在工具里空等）。

- [ ] **Step 4: 验证子进程 + MCP 握手**

先配置一个 SQLite 源（通过临时 JSON 写入 workspace 的 `.dbhub-sources.json`，或先接受「未配置数据源」状态）：
`[{"id":"mem1","type":"sqlite","database":":memory:"}]`

然后 `cordis_inspect_query` host `Tool.listTools` → 应出现 `dbhub_status`。随后让模型调用 `dbhub_status`，期望 `running: true` 且 `tools` 含 `execute_sql_mem1` / `search_objects_mem1` / `explain_sql_mem1`（证明 spawn + MCP `tools/list` 全链路通）。

- [ ] **Step 5: 验证 MCP `tools/call` 分帧往返**

模型调用 `dbhub_status` 之外，临时以 `execute_sql` 直连方式尚未就绪；本任务用 `dbhub_status` 的 `tools` 字段即可证明 `initialize`/`tools/list` 分帧正确。`tools/call` 在 Task 2 由真实工具验证。

---

## Task 2: Host 模型工具 + Client RPC

**Files:**
- Modify: `code.host`（在 Task 1 基础上追加 3 个模型工具 + `harness.handle` RPC；下面给出**完整** `code.host`，直接整体替换）

**Interfaces:**
- Consumes: Task 1 的 `loadSources/saveSources/getPassword/setPassword/deletePassword/writeToml/start/stopProcess/handshake/routeToolName/callMcpTool/mcp/handle/toolsByName`。
- Produces（Client 依赖的 RPC 方法，Client→Host，全 JSON）：
  - `getStatus()` → `{ running, error, pid, sourceCount, tools: string[], stderrTail }`
  - `listSources()` → `[{id,type,description,host,port,database,user,sslmode,...,hasPassword:boolean}]`（无明文密码）
  - `saveSource(source)` → `{ ok, error? }`（`source.password` 仅在非空时写 credentials）
  - `deleteSource({id})` → `{ ok }`
  - `setDefault({id})` → `{ ok }`（把该源移到首位 = DBHub 默认源）
  - `testConnection({id})` → `{ ok }`（内部 `search_objects(object_type=schema, limit=1)`）
  - `runSql({sourceId, sql})` → `{ columns, rows, rowCount }`
  - `searchObjects({sourceId, objectType, pattern?, schema?, table?, detailLevel?, limit?})` → 透传 DBHub `data`

- [ ] **Step 1: 写完整 `code.host`（Task 1 + 模型工具 + RPC）**

```js
return {
  name: 'dbhub',
  inject: ['subprocess', 'fs', 'credentials', 'timer'],
  apply(ctx) {
    const DB_TYPES = ['postgres', 'mysql', 'mariadb', 'sqlserver', 'sqlite', 'oracle']
    const ID_RE = /^[a-z][a-z0-9]*$/
    const DBHUB_DIST = 'E:/dev/dbhub/dist/index.js'
    const SOURCES_FILE = '.dbhub-sources.json'
    const TOML_FILE = '.dbhub-runtime.toml'
    const CRED_SCOPE = 'dbhub'

    let workspaceRoot = ''
    const sp = ctx.get('sandboxPolicy')
    if (sp && typeof sp.workspaceRoot === 'string') workspaceRoot = sp.workspaceRoot

    let handle = undefined
    let running = false
    let error = null
    let mcp = undefined
    let toolsByName = new Map()
    let lastStderr = ''
    let sourcesCache = []
    let toolDisposers = []

    // ---------- 持久化 ----------
    async function loadSources() {
      try {
        const t = await ctx.fs.resolve(SOURCES_FILE, { cwd: workspaceRoot })
        const info = await ctx.fs.stat(t)
        if (info === undefined) return []
        const arr = JSON.parse(await ctx.fs.readText(t))
        return Array.isArray(arr) ? arr : []
      } catch { return [] }
    }
    async function saveSources(sources) {
      const t = await ctx.fs.resolve(SOURCES_FILE, { cwd: workspaceRoot })
      await ctx.fs.writeText(t, JSON.stringify(sources, null, 2))
    }
    async function getPassword(id) {
      const rec = await ctx.credentials.readRecord(CRED_SCOPE + '/' + id)
      return rec && rec.kind === 'api-key' ? (rec.key || '') : ''
    }
    async function setPassword(id, pw) {
      await ctx.credentials.modifyRecord(CRED_SCOPE + '/' + id, () => ({ kind: 'api-key', key: pw }))
    }
    async function deletePassword(id) {
      await ctx.credentials.deleteRecord(CRED_SCOPE + '/' + id)
    }
    function validateSource(s) {
      if (!s || typeof s.id !== 'string' || !ID_RE.test(s.id)) return 'id 必须匹配 ^[a-z][a-z0-9]*$'
      if (!DB_TYPES.includes(s.type)) return 'type 必须是 ' + DB_TYPES.join('/')
      if (s.type === 'sqlite') { if (!s.database) return 'sqlite 需要 database（路径或 :memory:）' }
      else { if (!s.host || !s.database) return '网络数据库需要 host 与 database' }
      return null
    }

    // ---------- TOML ----------
    async function writeToml(sources) {
      const lines = []
      for (const s of sources) {
        const pw = await getPassword(s.id)
        lines.push('[[sources]]')
        lines.push('id = ' + JSON.stringify(s.id))
        lines.push('type = ' + JSON.stringify(s.type))
        if (s.description) lines.push('description = ' + JSON.stringify(s.description))
        if (s.type === 'sqlite') {
          lines.push('database = ' + JSON.stringify(s.database))
        } else {
          if (s.host) lines.push('host = ' + JSON.stringify(s.host))
          if (s.port) lines.push('port = ' + s.port)
          if (s.database) lines.push('database = ' + JSON.stringify(s.database))
          if (s.user) lines.push('user = ' + JSON.stringify(s.user))
          if (pw) lines.push('password = ' + JSON.stringify(pw))
          if (s.sslmode) lines.push('sslmode = ' + JSON.stringify(s.sslmode))
        }
        if (s.connection_timeout) lines.push('connection_timeout = ' + s.connection_timeout)
        if (s.query_timeout) lines.push('query_timeout = ' + s.query_timeout)
        if (s.lazy !== undefined) lines.push('lazy = ' + (s.lazy ? 'true' : 'false'))
        if (s.search_path) lines.push('search_path = ' + JSON.stringify(s.search_path))
        lines.push('')
      }
      const t = await ctx.fs.resolve(TOML_FILE, { cwd: workspaceRoot })
      await ctx.fs.writeText(t, lines.join('\n'))
      return ctx.fs.processPath(t)
    }

    // ---------- MCP 客户端 ----------
    function createMcpClient(h) {
      let nextId = 1
      const pending = new Map()
      let buffer = ''
      h.stdout.on('data', (chunk) => {
        buffer += String(chunk)
        let i
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i).trim()
          buffer = buffer.slice(i + 1)
          if (!line) continue
          let msg
          try { msg = JSON.parse(line) } catch { continue }
          if (msg.id != null && pending.has(msg.id)) {
            const p = pending.get(msg.id)
            pending.delete(msg.id)
            if (p.cancel) p.cancel()
            if (msg.error) p.reject(new Error((msg.error && msg.error.message) || 'MCP 错误'))
            else p.resolve(msg.result)
          }
        }
      })
      function write(obj) { h.stdin.write(JSON.stringify(obj) + '\n') }
      function call(method, params, timeoutMs) {
        return new Promise((resolve, reject) => {
          const id = nextId++
          let cancel
          if (timeoutMs > 0) {
            cancel = ctx.timeout(() => { pending.delete(id); reject(new Error('MCP 超时: ' + method)) }, timeoutMs)
          }
          pending.set(id, { resolve, reject, cancel })
          write({ jsonrpc: '2.0', id, method, params })
        })
      }
      function notify(method, params) { write({ jsonrpc: '2.0', method, params }) }
      return { call, notify }
    }

    // ---------- 进程 ----------
    async function start() {
      await stopProcess()
      const sources = await loadSources()
      sourcesCache = sources
      if (sources.length === 0) { running = false; error = '未配置数据源'; registerTools(sources); return }
      try {
        const tomlPath = await writeToml(sources)
        const spec = {
          argv: ['node', DBHUB_DIST, '--config=' + tomlPath],
          cwd: workspaceRoot,
          stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
          graceMs: 5000,
        }
        handle = ctx.subprocess.spawn(spec)
        running = true
        error = null
        mcp = createMcpClient(handle)
        handle.stderr.on('data', (c) => { lastStderr = (lastStderr + String(c)).slice(-4000) })
        await handshake()
        registerTools(sources)
      } catch (e) {
        running = false
        error = String((e && e.message) || e)
        registerTools(sources)
      }
    }
    async function stopProcess() {
      if (handle) { try { handle.terminate() } catch {} ; handle = undefined }
      running = false
      mcp = undefined
      toolsByName = new Map()
    }
    async function handshake() {
      const init = await mcp.call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'dbhub-dsh-plugin', version: '1.0.0' },
      }, 15000)
      mcp.notify('notifications/initialized', undefined)
      const listed = await mcp.call('tools/list', undefined, 15000)
      toolsByName = new Map()
      for (const t of (listed && listed.tools) || []) toolsByName.set(t.name, t)
      return init && init.serverInfo
    }

    // ---------- 路由 / 调用 ----------
    function routeToolName(base, sourceId, sources) {
      const n = sources.length
      if (n === 0) throw new Error('未配置数据源')
      let id
      if (sourceId !== undefined && sourceId !== '') id = sourceId
      else if (n === 1) id = sources[0].id
      else throw new Error('多数据源时 source_id 必填')
      if (!sources.some((s) => s.id === id)) throw new Error('未知数据源: ' + id)
      return n === 1 ? base : base + '_' + id
    }
    async function callMcpTool(toolName, args, timeoutMs) {
      if (!mcp) throw new Error('DBHub 未运行')
      const res = await mcp.call('tools/call', { name: toolName, arguments: args }, timeoutMs)
      const content = (res && res.content) || []
      const textBlock = content.find((c) => c.type === 'text')
      if (!textBlock) throw new Error('tools/call 无文本内容')
      const parsed = JSON.parse(textBlock.text)
      if (parsed.success === false) throw new Error(parsed.error || 'DBHub 工具执行失败')
      return parsed.data
    }
    function normalizeRows(data) {
      const rows = Array.isArray(data.rows) ? data.rows : []
      const columns = rows.length ? Object.keys(rows[0]) : []
      return { columns, rows, rowCount: data.count, source_id: data.source_id }
    }

    // ---------- 模型工具（每次配置变更后重注册，刷新 source_id enum） ----------
    const jsonOutput = {
      schema: { type: 'json' },
      render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }],
    }
    function registerTools(sources) {
      for (const d of toolDisposers) d()
      toolDisposers = []
      const ids = sources.map((s) => s.id)
      const sourceParam = ids.length > 0
        ? { type: 'string', enum: ids, description: ids.length > 1 ? '数据源 id（多源时必填）' : '数据源 id（单源时可省略）' }
        : { type: 'string', description: '数据源 id' }

      toolDisposers.push(harness.registerTool(ctx, harness.defineTool({
        name: 'execute_sql',
        description: '在指定数据源执行 SQL（多条语句用 ; 分隔），返回列名与行数据。',
        parameters: {
          sql: { type: 'string', required: true, description: 'SQL to execute (multiple statements separated by ;)' },
          source_id: sourceParam,
        },
        output: jsonOutput,
        timeoutMs: 60000,
        async execute(args) {
          const sources = await loadSources()
          const name = routeToolName('execute_sql', args.source_id, sources)
          return normalizeRows(await callMcpTool(name, { sql: args.sql }, 30000))
        },
      })))

      toolDisposers.push(harness.registerTool(ctx, harness.defineTool({
        name: 'search_objects',
        description: '搜索/列出数据库对象（schema/table/column/procedure/function/index），渐进式详情。',
        parameters: {
          object_type: { type: 'string', required: true, enum: ['schema', 'table', 'column', 'procedure', 'function', 'index'], description: 'Object type to search' },
          pattern: { type: 'string', description: 'LIKE pattern (% = any chars, _ = one char). Default: %' },
          schema: { type: 'string', description: 'Filter to schema' },
          table: { type: 'string', description: 'Filter to table (requires schema; column/index only)' },
          detail_level: { type: 'string', enum: ['names', 'summary', 'full'], description: 'Detail: names (minimal), summary (metadata), full (all)' },
          limit: { type: 'number', description: 'Max results (default: 100, max: 1000)' },
          source_id: sourceParam,
        },
        output: jsonOutput,
        timeoutMs: 60000,
        async execute(args) {
          const sources = await loadSources()
          const name = routeToolName('search_objects', args.source_id, sources)
          const params = { object_type: args.object_type }
          if (args.pattern !== undefined) params.pattern = args.pattern
          if (args.schema !== undefined) params.schema = args.schema
          if (args.table !== undefined) params.table = args.table
          if (args.detail_level !== undefined) params.detail_level = args.detail_level
          if (args.limit !== undefined) params.limit = args.limit
          return await callMcpTool(name, params, 30000)
        },
      })))

      toolDisposers.push(harness.registerTool(ctx, harness.defineTool({
        name: 'explain_sql',
        description: '解释单条 SQL 语句的执行计划（不实际执行语句）。',
        parameters: {
          sql: { type: 'string', required: true, description: 'Single SQL statement to explain' },
          source_id: sourceParam,
        },
        output: jsonOutput,
        timeoutMs: 60000,
        async execute(args) {
          const sources = await loadSources()
          const name = routeToolName('explain_sql', args.source_id, sources)
          return normalizeRows(await callMcpTool(name, { sql: args.sql }, 30000))
        },
      })))
    }

    // ---------- 诊断工具 ----------
    harness.registerTool(ctx, harness.defineTool({
      name: 'dbhub_status',
      description: '查看 DBHub 插件状态：子进程、数据源列表、按源 MCP 工具名。',
      parameters: {},
      output: jsonOutput,
      async execute() {
        const sources = await loadSources()
        return {
          running,
          error,
          pid: handle ? handle.pid : null,
          sources: sources.map((s) => ({ id: s.id, type: s.type, description: s.description || '' })),
          tools: Array.from(toolsByName.keys()),
          stderrTail: lastStderr.slice(-1500),
        }
      },
    }))

    // ---------- Client RPC ----------
    harness.handle('getStatus', async () => ({
      running,
      error,
      pid: handle ? handle.pid : null,
      sourceCount: sourcesCache.length,
      tools: Array.from(toolsByName.keys()),
      stderrTail: lastStderr.slice(-1500),
    }))
    harness.handle('listSources', async () => {
      const sources = await loadSources()
      const out = []
      for (const s of sources) out.push(Object.assign({}, s, { hasPassword: !!(await getPassword(s.id)) }))
      return out
    })
    harness.handle('saveSource', async (args) => {
      const err = validateSource(args)
      if (err) return { ok: false, error: err }
      const password = args.password
      const clean = {}
      for (const k of Object.keys(args)) if (k !== 'password') clean[k] = args[k]
      let sources = await loadSources()
      const idx = sources.findIndex((x) => x.id === clean.id)
      if (idx >= 0) sources[idx] = clean
      else sources.push(clean)
      await saveSources(sources)
      if (typeof password === 'string' && password !== '') await setPassword(clean.id, password)
      await start()
      return { ok: true }
    })
    harness.handle('deleteSource', async (args) => {
      let sources = await loadSources()
      sources = sources.filter((x) => x.id !== args.id)
      await saveSources(sources)
      await deletePassword(args.id)
      await start()
      return { ok: true }
    })
    harness.handle('setDefault', async (args) => {
      let sources = await loadSources()
      const idx = sources.findIndex((x) => x.id === args.id)
      if (idx > 0) {
        const s = sources.splice(idx, 1)[0]
        sources.unshift(s)
        await saveSources(sources)
        await start()
      }
      return { ok: true }
    })
    harness.handle('testConnection', async (args) => {
      const name = routeToolName('search_objects', args.id, await loadSources())
      await callMcpTool(name, { object_type: 'schema', limit: 1 }, 15000)
      return { ok: true }
    })
    harness.handle('runSql', async (args) => {
      const name = routeToolName('execute_sql', args.sourceId, await loadSources())
      const data = await callMcpTool(name, { sql: args.sql }, 30000)
      const rows = Array.isArray(data.rows) ? data.rows : []
      const columns = rows.length ? Object.keys(rows[0]) : []
      return { columns, rows, rowCount: data.count }
    })
    harness.handle('searchObjects', async (args) => {
      const name = routeToolName('search_objects', args.sourceId, await loadSources())
      const params = { object_type: args.objectType }
      if (args.pattern !== undefined) params.pattern = args.pattern
      if (args.schema !== undefined) params.schema = args.schema
      if (args.table !== undefined) params.table = args.table
      if (args.detailLevel !== undefined) params.detail_level = args.detailLevel
      if (args.limit !== undefined) params.limit = args.limit
      return await callMcpTool(name, params, 30000)
    })

    // ---------- 生命周期 ----------
    ctx.effect(() => {
      start()
      return () => {
        stopProcess()
        for (const d of toolDisposers) d()
        toolDisposers = []
        ctx.fs.resolve(TOML_FILE, { cwd: workspaceRoot })
          .then((t) => ctx.fs.writeText(t, '').catch(() => {}))
          .catch(() => {})
      }
    })
  },
}
```

- [ ] **Step 2: `cordis_define` 追加 Package（同 pluginId）**

`plugin: { kind: 'existing', pluginId: <Task1 返回的 pluginId> }`，`name: 'dbhub-tools-rpc'`，`code: { host: <上面完整代码> }`。记录新 `packageId`。

- [ ] **Step 3: `cordis_run` 用 `update` 切换**

`mode: 'update'`（已有 current）。等待系统报告结果。

- [ ] **Step 4: 验证 3 个模型工具 + source_id 枚举**

`cordis_inspect_query` host `Tool.listTools` → 应含 `execute_sql` / `search_objects` / `explain_sql`（每个 `parameters.properties.source_id.enum` 为当前源 id 列表）+ `dbhub_status`。

- [ ] **Step 5: 验证路由与结果归一化（SQLite 双源）**

把 `.dbhub-sources.json` 设为两个 SQLite 源后重启插件（或经 RPC `saveSource`），然后让模型：
1. `execute_sql(sql="SELECT 1 AS one", source_id="mem1")` → 期望 `{columns:["one"], rows:[{one:1}], rowCount:1, source_id:"mem1"}`。
2. `search_objects(object_type="schema", source_id="mem1")` → 期望返回 `{object_type:"schema", count:..., results:[], truncated:false}`。
3. 多源时省略 `source_id` 调用 → 期望报错「多数据源时 source_id 必填」。
4. `dbhub_status` → `tools` 含 `execute_sql_mem1` / `execute_sql_mem2`（多源命名正确）。

---

## Task 3: Client 设置页 UI（`settings.section`）

**Files:**
- Create: `code.client`（Client 半；`code.host` 保持不变，复用 Task 2 版本）

**Interfaces:**
- Consumes: `slots`（`ctx.get('slots')`，`inject`+`register`）、`React`/`host`/`styles`（Builtin）、Task 2 的 RPC 方法（`getStatus`/`listSources`/`saveSource`/`deleteSource`/`setDefault`/`testConnection`/`runSql`/`searchObjects`）。
- Produces: `settings.section` 条目 `id:'dbhub'`（`label:'数据库'`），含三页签：数据源 CRUD、SQL 工作台、表结构。

- [ ] **Step 1: 写 `code.client`**

```js
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    ctx.effect(() => styles.insert(
      '.dbhub-wrap{padding:16px;font-size:13px}' +
      '.dbhub-bar{display:flex;gap:10px;align-items:center;padding:8px;border:1px solid #30363d;border-radius:6px;margin-bottom:12px}' +
      '.dbhub-tab{padding:6px 12px;cursor:pointer;border:none;background:transparent;color:#8b949e}' +
      '.dbhub-tab.on{border-bottom:2px solid #58a6ff;color:#e6edf3}' +
      '.dbhub-row{display:flex;gap:8px;align-items:center;margin:6px 0;flex-wrap:wrap}' +
      '.dbhub-grid{display:grid;grid-template-columns:110px 1fr;gap:6px;max-width:560px;margin:12px 0}' +
      '.dbhub-grid label{color:#8b949e;align-self:center}' +
      '.dbhub-in,button,select{background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:5px 8px}' +
      'textarea.dbhub-in{width:100%;min-height:140px;font-family:monospace}' +
      'button:hover{border-color:#58a6ff}' +
      '.dbhub-table{border-collapse:collapse;margin-top:8px}' +
      '.dbhub-table th,.dbhub-table td{border:1px solid #30363d;padding:4px 8px;font-size:12px;max-width:360px;overflow:hidden;text-align:left}' +
      '.dbhub-mut{color:#8b949e;font-size:12px}' +
      '.dbhub-err{color:#f85149;font-size:12px}'
    ))
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'dbhub', order: 25, label: '数据库' },
      (props) => React.createElement(DbHubSettings, { close: props.close }),
    ))
  },
}

function el(type, props) {
  const kids = []
  for (let i = 2; i < arguments.length; i++) {
    const k = arguments[i]
    if (k !== null && k !== undefined && k !== false) kids.push(k)
  }
  return React.createElement.apply(null, [type, props].concat(kids))
}

function DbHubSettings() {
  const [status, setStatus] = React.useState(null)
  const [sources, setSources] = React.useState([])
  const [tab, setTab] = React.useState('sources')
  const [editing, setEditing] = React.useState(null)
  const [form, setForm] = React.useState({ type: 'sqlite', database: ':memory:' })
  const [msg, setMsg] = React.useState('')
  const [sql, setSql] = React.useState('SELECT 1 AS one')
  const [sqlSource, setSqlSource] = React.useState('')
  const [sqlResult, setSqlResult] = React.useState(null)
  const [sqlError, setSqlError] = React.useState('')
  const [objType, setObjType] = React.useState('table')
  const [objPattern, setObjPattern] = React.useState('%')
  const [objLevel, setObjLevel] = React.useState('names')
  const [objSource, setObjSource] = React.useState('')
  const [objResult, setObjResult] = React.useState(null)

  async function refresh() {
    setStatus(await host.call('getStatus', {}))
    setSources(await host.call('listSources', {}))
  }
  React.useEffect(() => { refresh() }, [])

  async function save() {
    setMsg('')
    try {
      const r = await host.call('saveSource', form)
      if (r && r.ok === false) { setMsg(r.error); return }
      setEditing(null); await refresh()
    } catch (e) { setMsg(String((e && e.message) || e)) }
  }
  async function del(id) { await host.call('deleteSource', { id }); await refresh() }
  async function setDefault(id) { await host.call('setDefault', { id }); await refresh() }
  async function test(id) {
    setMsg('测试连接 ' + id + ' …')
    try { const r = await host.call('testConnection', { id }); setMsg(r.ok ? (id + ' 连接成功') : '连接失败') }
    catch (e) { setMsg('连接失败: ' + String((e && e.message) || e)) }
  }
  function startEdit(s) {
    setForm(s ? Object.assign({}, s) : { type: 'sqlite', database: ':memory:' })
    setEditing(s ? s.id : 'new')
  }
  function setF(k, v) { setForm(Object.assign({}, form, { [k]: v })) }

  async function doRunSql() {
    setSqlError(''); setSqlResult(null)
    try { setSqlResult(await host.call('runSql', { sourceId: sqlSource, sql })) }
    catch (e) { setSqlError(String((e && e.message) || e)) }
  }
  async function doSearch() {
    setObjResult(null)
    try {
      setObjResult(await host.call('searchObjects', {
        sourceId: objSource, objectType: objType, pattern: objPattern, detailLevel: objLevel, limit: 100,
      }))
    } catch (e) { setObjResult({ error: String((e && e.message) || e) }) }
  }

  const bar = el('div', { className: 'dbhub-bar' },
    el('span', null, '状态: ' + (status ? (status.running ? ('运行中 (pid ' + status.pid + ')') : '未运行') : '加载中…')),
    status && status.error ? el('span', { className: 'dbhub-err' }, String(status.error)) : null,
    status && status.sourceCount !== undefined ? el('span', { className: 'dbhub-mut' }, status.sourceCount + ' 个数据源') : null,
  )
  const tabs = el('div', { className: 'dbhub-row' },
    el('button', { className: 'dbhub-tab' + (tab === 'sources' ? ' on' : ''), onClick: () => setTab('sources') }, '数据源'),
    el('button', { className: 'dbhub-tab' + (tab === 'workbench' ? ' on' : ''), onClick: () => setTab('workbench') }, 'SQL 工作台'),
    el('button', { className: 'dbhub-tab' + (tab === 'schema' ? ' on' : ''), onClick: () => setTab('schema') }, '表结构'),
  )

  let body = null
  if (tab === 'sources') {
    const rows = sources.map((s) => el('div', { className: 'dbhub-row', key: s.id },
      el('span', null, s.id),
      el('span', { className: 'dbhub-mut' }, s.type + (s.description ? (' — ' + s.description) : '') + (s.hasPassword ? ' · 已存密码' : '')),
      el('button', { onClick: () => startEdit(s) }, '编辑'),
      el('button', { onClick: () => del(s.id) }, '删除'),
      el('button', { onClick: () => setDefault(s.id) }, '设为默认'),
      el('button', { onClick: () => test(s.id) }, '测试'),
    ))
    body = el('div', null,
      el('div', { className: 'dbhub-row' }, el('button', { onClick: () => startEdit(null) }, '新增数据源')),
      el('div', null, rows),
      msg ? el('div', { className: 'dbhub-mut' }, msg) : null,
      editing !== null ? sourceForm(form, setF, save, () => setEditing(null)) : null,
    )
  } else if (tab === 'workbench') {
    body = el('div', null,
      el('div', { className: 'dbhub-row' },
        el('label', null, '数据源 '),
        el('select', { value: sqlSource, onChange: (e) => setSqlSource(e.target.value) },
          sources.map((s) => el('option', { value: s.id, key: s.id }, s.id)),
        ),
        el('button', { onClick: doRunSql }, '运行'),
      ),
      el('textarea', { className: 'dbhub-in', value: sql, onChange: (e) => setSql(e.target.value) }),
      sqlError ? el('div', { className: 'dbhub-err' }, sqlError) : null,
      sqlResult ? resultTable(sqlResult.columns, sqlResult.rows) : null,
    )
  } else {
    body = el('div', null,
      el('div', { className: 'dbhub-row' },
        el('label', null, '数据源 '),
        el('select', { value: objSource, onChange: (e) => setObjSource(e.target.value) },
          sources.map((s) => el('option', { value: s.id, key: s.id }, s.id)),
        ),
        el('label', null, '类型 '),
        el('select', { value: objType, onChange: (e) => setObjType(e.target.value) },
          ['schema', 'table', 'column', 'procedure', 'function', 'index'].map((t) => el('option', { value: t, key: t }, t)),
        ),
        el('label', null, '详情 '),
        el('select', { value: objLevel, onChange: (e) => setObjLevel(e.target.value) },
          ['names', 'summary', 'full'].map((t) => el('option', { value: t, key: t }, t)),
        ),
        el('button', { onClick: doSearch }, '搜索'),
      ),
      el('input', { className: 'dbhub-in', value: objPattern, onChange: (e) => setObjPattern(e.target.value), placeholder: 'pattern（默认 %）' }),
      objResult && objResult.error ? el('div', { className: 'dbhub-err' }, objResult.error) : null,
      objResult && !objResult.error ? el('pre', null, JSON.stringify(objResult, null, 2)) : null,
    )
  }

  return el('div', { className: 'dbhub-wrap' }, bar, tabs, body)
}

function sourceForm(form, setF, save, cancel) {
  const isSqlite = form.type === 'sqlite'
  return el('div', null,
    el('div', { className: 'dbhub-grid' },
      el('label', null, '类型'),
      el('select', { value: form.type || 'postgres', onChange: (e) => setF('type', e.target.value) },
        ['postgres', 'mysql', 'mariadb', 'sqlserver', 'sqlite', 'oracle'].map((t) => el('option', { value: t, key: t }, t)),
      ),
      el('label', null, 'id'),
      el('input', { className: 'dbhub-in', value: form.id || '', onChange: (e) => setF('id', e.target.value), placeholder: '小写字母开头，仅小写字母数字' }),
      el('label', null, '描述'),
      el('input', { className: 'dbhub-in', value: form.description || '', onChange: (e) => setF('description', e.target.value) }),
      isSqlite ? null : el('label', null, 'host'),
      isSqlite ? null : el('input', { className: 'dbhub-in', value: form.host || '', onChange: (e) => setF('host', e.target.value) }),
      isSqlite ? null : el('label', null, 'port'),
      isSqlite ? null : el('input', { className: 'dbhub-in', value: form.port || '', onChange: (e) => setF('port', e.target.value) }),
      el('label', null, isSqlite ? '文件路径' : 'database'),
      el('input', { className: 'dbhub-in', value: form.database || '', onChange: (e) => setF('database', e.target.value), placeholder: isSqlite ? ':memory: 或路径' : '库名' }),
      isSqlite ? null : el('label', null, 'user'),
      isSqlite ? null : el('input', { className: 'dbhub-in', value: form.user || '', onChange: (e) => setF('user', e.target.value) }),
      isSqlite ? null : el('label', null, 'password'),
      isSqlite ? null : el('input', { className: 'dbhub-in', type: 'password', value: form.password || '', onChange: (e) => setF('password', e.target.value), placeholder: '留空则保留原密码' }),
    ),
    el('div', { className: 'dbhub-row' },
      el('button', { onClick: save }, '保存'),
      el('button', { onClick: cancel }, '取消'),
    ),
  )
}

function resultTable(columns, rows) {
  if (!columns || !columns.length) return el('div', { className: 'dbhub-mut' }, '0 行')
  return el('table', { className: 'dbhub-table' },
    el('thead', null, el('tr', null, columns.map((c) => el('th', { key: c }, String(c))))),
    el('tbody', null, (rows || []).map((r, i) => el('tr', { key: i },
      columns.map((c) => el('td', { key: c }, r[c] == null ? '' : String(r[c]))),
    ))),
  )
}
```

- [ ] **Step 2: `cordis_define` 追加 Client Package**

`plugin: { kind: 'existing', pluginId: <pluginId> }`，`name: 'dbhub-client-ui'`，`code: { client: <上面代码>, host: <Task 2 的完整 code.host> }`（Host 保持不变，需一并携带，因为 Package 是 Host+Client 一体版本）。记录新 `packageId`。

- [ ] **Step 3: `cordis_run` 用 `update` 切换**

Client Package 可能触发审批（`awaiting-approval`）——向用户说明并等待放行。

- [ ] **Step 4: 浏览器验证设置页**

打开设置 → 应出现「数据库」页（`order:25`，排在 mcp 之后）。进入后：状态条显示「未运行/运行中」，「数据源」页签可增删改、设默认、测试连接；「SQL 工作台」可跑查询看到表格；「表结构」可搜索看到结果。

---

## Task 4: 端到端验收 + 生命周期清理

**Files:** 无新代码（复用 Task 3 的 Package）。

- [ ] **Step 1: 配置两个 SQLite 源**

通过设置页新增 `mem1`（`type:sqlite`, `database::memory:`）与 `mem2`（同）。保存后状态条应为「运行中」，`dbhub_status` 的 `tools` 应含 `execute_sql_mem1` / `execute_sql_mem2`。

- [ ] **Step 2: 逐条过 spec §10 验收清单**

1. ✅ 两个源后 `tools/list` 返回按源命名工具；DSH 侧 3 个统一工具 + `source_id.enum` 正确（`Tool.listTools` 核对）。
2. ✅ 模型调 `execute_sql(sql="SELECT 1 AS one", source_id="mem1")` 命中 mem1；再 `source_id="mem2"` 结果一致（证明路由不串源）。
3. ✅ 设置页增/删/改/设默认/测试连接，状态与源列表刷新正确。
4. ✅ SQL 工作台按源切换跑查询、表结构正确（先 `execute_sql(sql="CREATE TABLE t(id int)")` 再 `search_objects(object_type="table")` 应见 `t`）。
5. ✅ 单源（删掉 mem2 只剩一个）时 `source_id` 可省略、工具名退化为无后缀 `execute_sql`。

- [ ] **Step 3: 验证 stop 清理**

`cordis_stop` 后：`Tool.listTools` 不再含 `execute_sql`/`dbhub_status`；`dbhub_status` 已消失；`.dbhub-runtime.toml` 被清空（含明文密码的临时产物已清）。`credentials` 里 `dbhub/mem1` 等记录保留（配置持久化，供下次重跑读取）。

- [ ] **Step 4: 记录残余风险 / 待办**

- MCP `initialize` 的 `protocolVersion` 用了 `'2025-06-18'`；若 DBHub（SDK 1.25.1）报协议不符，回退 `'2024-11-05'` 或 `'2025-03-26'`。
- `fs` 无 `mkdir`：运行时文件直接写在 workspace 根（点文件）；如需子目录，用 `subprocess` 跑 `mkdir -p` 或改用 workspace 根。
- 明文密码临时 TOML 的清理是「写空串」而非删除（`fs` 无 unlink），若要求彻底删除需 `subprocess` 删除或后续提升为正式组合插件时改用正式设置/凭据管道。
- `exec.signal` 未转发到 MCP 请求（v1 用 `timeoutMs` + `ctx.timeout` 兜底）；如需协同取消，后续在 `callMcpTool` 里接入 AbortSignal。

---

## 自审记录

- **Spec 覆盖**：§5.1 进程管理 → Task 1；§5.2 MCP 客户端 → Task 1；§5.3 模型工具 → Task 2；§5.4 配置持久化 → Task 1/2（fs JSON + credentials）；§5.5 RPC → Task 2；§6 Client UI → Task 3；§8 错误处理 → 各 Task 的 error 字段/拒绝路径；§9 生命周期 → 各 Task 的 `ctx.effect`；§10 验收 → Task 4；§11/§13 范围 → Global Constraints。
- **类型一致性**：`routeToolName(base, sourceId, sources)`、`callMcpTool(name, args, timeoutMs)`、`normalizeRows(data)` 在 Task 1/2 签名一致；RPC 方法名与 Task 3 Client 的 `host.call` 调用一一对应（`getStatus/listSources/saveSource/deleteSource/setDefault/testConnection/runSql/searchObjects`）；`listSources` 返回的 `hasPassword` 与 Client 展示一致。
- **占位符扫描**：无 TBD/TODO；唯一待定值（`DBHUB_DIST`、`protocolVersion`）均给出默认值与回退说明，非占位。
