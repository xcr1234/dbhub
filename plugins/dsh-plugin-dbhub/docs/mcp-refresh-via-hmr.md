# dbhub MCP 刷新机制重构

## 背景

dbhub 插件通过 settings UI 写入 `dbhub.toml`，dbhub 子进程读取并连接数据库，然后通过 streamable-HTTP 把工具列表暴露在 `http://127.0.0.1:<port>/mcp`。`@deepseek-ai/dsh-mcp-client` row 连接这个端点并把工具注册到 `ctx.tools`。

用户报告的问题（见 `F:\soft\CherryData\Data\Files\01a05807-09fd-75bb-80da-1c1be6cb8e04.txt`）：

- 修改设置（增加/删除 source）后，dbhub 子进程会自己重载工具列表（日志里能看到 `Detected change in ...dbhub.toml, reloading configuration...`）
- 但系统的 mcp 工具列表（`mcp__dbhub__*`）没有刷新，AI 看到的还是旧 source 的工具

## 现状分析

当前实现位于 `plugins/dsh-plugin-dbhub/src/index.ts:119-169`：在 `ctx.inject(['loader'], ...)` 里订阅 `service.install({ onCommit })`，根据 view 计算 signature（running / enabled / port / 排序后 source id 列表），signature 变化时调用：

```typescript
for (const t of teardown.splice(0)) await t()           // loader.remove(id)
await lctx.loader.create({ id, name, config: { ... } })  // 新建 row
```

问题：
1. **`loader.create` 的隐含约束**：见 `vendor/loader/src/config/tree.ts:97-104`。它无条件把 entry push 到 `group.data`，不负责清理旧的。remove 是手动调用的，如果中间任何一个 await 抛错，`data` 数组可能残留旧 entry，HMR 后续重建时会拿脏数据。
2. **绕过 HMR**：loader 内部本就有完整的 HMR 通道（`Group.update(config)` 见 `vendor/loader/src/config/group.ts:59-106`），它对一批 entries 变更有专门的 diff + rollback。手动 remove+create 是在 HMR 之外另起炉灶。
3. **时序竞争**：onCommit 在 `writeToml()` 之后立刻触发，但此时 dbhub 自己还在 `Disconnected from source ... -> Connecting ...` 的过程中。新建的 mcp-client 可能连上半个就绪的 dbhub，拿到残缺的工具列表。

## 目标

复用 `dsh-mcp-manager` 已验证的 **patch YAML + HMR** 模式：

- dbhub 插件只写一份补丁 YAML（类似 `$DSH_HOME/profiles/web/dbhub.patch.yml`）
- harness 的 loader 监听这个文件，文件变化时自动热重载 `@deepseek-ai/dsh-mcp-client` row
- dbhub 不再直接调 `loader.create/remove`

## 设计

### 文件路径

```
$DSH_HOME/profiles/web/dbhub.patch.yml
```

用和 `dsh-mcp-manager` 一样的 `cordis-plugin-include` dialect：

```yaml
# dbhub MCP server row (managed by the dsh-plugin-dbhub plugin).
- id: mcp-dbhub
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: dbhub
    transport: streamable-http
    url: 'http://127.0.0.1:18080/mcp'
```

### 关键决策

1. **固定 id 为 `mcp-dbhub`**，不要带 port。
   - 当前实现用 `mcp-dbhub-${port}`，port 变化时 id 变化，HMR 会当成删除+新建，而不是 config 更新。
   - port 改了 URL 自然也改了，HMR diff 出来 `config.url` 不同，触发 `entry.update` 的 `replace` 分支（`vendor/loader/src/config/entry.ts:194` 看一下哪些 key 触发 replace；当前只有 name/inject/group，config 走 `_patchContext`）。

2. **不写 `disabled` 行**。
   - 当前通过 `view.running && view.config.enabled` 决定 row 是否存在：
     - 任一为 false → 把这一行从 patch YAML 里删掉（HMR 会清理 loader tree）
     - 全部为 true → 写（新增）或保留（更新 config.url）这一行
   - 这样禁用状态完全由 dbhub 自己的 view 驱动，不留 patch YAML 的中间状态。

3. **sources 非空是写入的必要条件**。source 列表为空时即便 enabled，也应该把 row 删掉，避免 mcp-client 暴露一个空工具列表。

4. **不要和 dsh-mcp-manager 共用同一个 patch 文件**。两者独立文件，互不影响。

5. **不写 `insert:` 形式**。`insert:` 是给 "往某个 group 里加新 row" 用的 patch 指令。dbhub 的 row 是顶层 row，用 `{ id, name, config }` 即可。

### 模块拆分

新建 `plugins/dsh-plugin-dbhub/src/host/patch.ts`，对应 dsh-mcp-manager 的 `src/patch.ts`，提供：

- `resolvePatchPath()`: 解析 patch YAML 路径
- `readPatchList(file)`: 读 YAML，数组形式
- `writePatchList(file, rows)`: 写 YAML（保留 header comment）
- `editPatchList(file, edit)`: 读-改-写原子操作
- `findDbhubRow(rows)`: 找到 dbhub 的 row（按 id 或 serverName === 'dbhub'）
- `upsertDbhubRow(rows, config)`: 插入或更新 dbhub row；不存在则 append，存在则替换 config
- `removeDbhubRow(rows)`: 删除 dbhub row

YAML schema 复用 `js-yaml` + `JSON_SCHEMA.extend(JsExprType)`（参考 `dsh-mcp-manager/src/patch.ts:67-75`），dbhub 不需要 `!!js` 表达式但保持 schema 一致便于后续扩展。

### apply() 改造

`plugins/dsh-plugin-dbhub/src/index.ts` 移除 `loader` 依赖。新的 `apply()`：

1. `new DbhubService(ctx)` 仍然先创建（settings 命名空间、watcher、runtime reconcile 都需要）
2. 保留 `connection` RPC handler
3. 不再 `ctx.inject(['loader'], ...)`，改为订阅 `service.install({ onCommit })`
4. `onCommit(view)` 里调用 `patch.ts` 的 helper：
   - `running && enabled && sources.length > 0` → `upsertDbhubRow({serverName: 'dbhub', transport: 'streamable-http', url})`
   - 否则 → `removeDbhubRow()`
5. 不需要 `lastSignature`：HMR 自己有 diff，重复写相同文件内容由 yaml.dump 决定是否真的写出（其实总是会写出，所以保留一个简单的去重即可，省一次文件 IO）

### signature 的处理

方案 B 不再用内存 signature，但仍然需要避免每次 view 都触发文件写入（onCommit 可能在 settings 任何字段变动时都触发）。两种选择：

a) 完全依赖 view 内容做 diff
b) 在 settings.onChange 里只关心 `running / enabled / port / sources.length`，其它字段变化（如注释、保留字段）不触发 patch YAML 写入

选 (b)，逻辑和当前 signature 检查等价，只是搬到 onCommit 里：

```typescript
const desired = view.running && view.config.enabled && view.config.sources.length > 0
const current = await readPatchList(file).then(rows => findDbhubRow(rows) !== undefined)
if (desired === current) return
```

简单 boolean diff，不写文件。

### 与 dbhub 进程重载的协调

dbhub 子进程的 TOML watcher 仍然由 dbhub 自己负责（`dbhub/src/utils/config-watcher.ts`）。新的协调关系：

```
settings UI save
  ↓
DbhubService.save() → settings.replace() + writeToml()
  ↓                          ↓
  onChange()            fs.write (dbhub.toml)
  ↓                          ↓
  writePatchYAML()       dbhub 子进程 watcher 触发重连
  ↓                          ↓
  HMR 检测 patch YAML 变化     dbhub 重新连接源、暴露新工具
  ↓                          ↓
  entry.update → mcp-client 重新连接 dbhub
  ↓
  mcp-client 重新 list tools
```

两条路径并行：
- 路径 A：dbhub 自己重载 TOML，重连数据源
- 路径 B：HMR 重载 mcp-client row，重新 list tools

即使路径 B 比路径 A 快（mcp-client 重新连 dbhub 时 dbhub 还没准备好），mcp-client 的 reconnect backoff（见 `packages/mcp/mcp-client/src/connection.ts:192-225`）会兜底，最终拿到正确工具列表。

### 与现有代码的兼容

- `DbhubService` 接口不变：`install({ onCommit })` / `list()` / `save()` 等都保留
- onCommit 签名不变，只是实现从 `loader.create/remove` 改为 `writePatchYAML`
- 客户端 UI（`DbhubSettingsSection.tsx`）无改动
- 测试：现有 `tests/` 下的单元测试如果 mock 了 loader，需要改成 mock patch YAML

## 文件改动清单

新增：
- `plugins/dsh-plugin-dbhub/src/host/patch.ts`：patch YAML 编辑器
- `plugins/dsh-plugin-dbhub/src/host/__tests__/patch.test.ts`：单元测试

修改：
- `plugins/dsh-plugin-dbhub/src/index.ts`：移除 `loader` 依赖，改用 patch YAML
- `plugins/dsh-plugin-dbhub/src/host/settings.ts`：onCommit 回调里增加 patch YAML 写入
- `plugins/dsh-plugin-dbhub/README.md`：补充 "MCP row refresh" 说明

## 实施顺序

1. 新建 `patch.ts` + 单元测试
2. 在 `settings.ts` 的 onCommit 里接入（保留旧的 loader 代码路径，加开关）
3. 手动验证：调整设置 → 等 dbhub 重载 → AI 端工具列表更新
4. 确认稳定后，删除 `index.ts` 里旧的 `loader.create/remove` 逻辑
5. 更新 README

## 风险

- **HMR 时机**：patch YAML 写入 → HMR 触发 → mcp-client 重建，如果此时 dbhub 还没准备好，mcp-client 会进入 reconnect backoff。理论上有 30s + 的窗口让 dbhub 重新就绪，应该够。
- **文件路径解析**：profile dir 解析逻辑（`src/host/config-file.ts` 的 `resolveConfigPath`）要复用，不能再写一份。
- **YAML 序列化**：header comment + line width + JsonSchema extend 三件套要保持，否则 dsh-web 启动时 loader 解析 patch 文件可能失败。
- **首次启动**：apply() 第一次跑时 HMR 还没建立连接，patch YAML 里的 row 还没生效。需要在 `install` 末尾触发一次 initial reconcile（同当前实现的最后那段 `if (currentConfig.enabled && sources.length > 0)`）。