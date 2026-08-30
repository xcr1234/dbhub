# @xcr1234/dsh-plugin-dbhub

[English](README.md) | 中文

DSH 插件：**在设置面板里管理 DBHub 数据库 MCP 服务**。DBHub 进程内嵌
启动（不依赖 `npx` 子进程），面板配置写入 `dbhub.toml`，模型通过
`@deepseek-ai/dsh-mcp-client` 看到 DBHub 提供的工具。热更新由 DBHub
自带的 `fs.watch` 接管，插件只需要在保存时重写 TOML。

## 功能

- **进程内 DBHub** — 直接调用 `@xcr1234/dbhub-fork/server` 的
  `startServer({ transport: 'http', port, configPath })`。不依赖
  `npx` / 子进程。
- **设置面板** — 设置列表新增"数据库连接"一项。增删改、改端口、
  开关，全部**保存**后即生效。面板通过 TYPERT 调
  `dbhub/save`，Host 端写 `dbhub.toml`，DBHub 自己检测。
- **工具自动暴露** — 第一次成功启动后插入一行
  `@deepseek-ai/dsh-mcp-client`，指向 `http://127.0.0.1:<port>/mcp`；
  卸载时删除；端口变化时重建（dsh-mcp-client 对同一个 serverName
  拒绝换 URL）。
- **热更新** — DBHub 自带 `config-watcher.ts`（500ms 防抖），每次
  TOML 编辑后自动重连 sources，失败回滚。插件不需自己实现重载。

## 架构

双面 npm 包，安装到 `web` profile：

| 端     | 入口                              | 角色 |
| ------ | --------------------------------- | ---- |
| Server | `lib/index.js`                    | Cordis 插件：注册 `ctx.dbhub` (typert)，启动进程内 DBHub，监听 `dbhub` settings 命名空间，维护 `dsh-mcp-client` 行。 |
| TYPERT | `lib/typert.js`                   | Host 端 typert (`dbhub/list`, `dbhub/save`)。 |
| 浏览器 | `client/client.js`                | `window.__ModuleLoader__.load` 工厂：挂载 `dbhub` remote、注册 locale 字典、向 `settings.section` 槽位注入 React 设置页。 |

```
设置面板 (浏览器)              Host 插件                DBHub (进程内)
──────────────────           ──────────────           ──────────────
用户编辑 DSN  ── dbhub/save ─▶ zod 校验 ─▶ settings.replace
                                     │
                                     ├─▶ writeToml()  ──────▶ fs.watch (500ms)
                                     │                          │
                                     └─▶ runtime.ensure()     ├─▶ 解析 TOML
                                          │                  ├─▶ 重连 sources
                                          ▼                  ├─▶ 重建 tool registry
                                     mcp-client 行           └─▶ 注册工具
                                     (http://.../mcp)             │
                                                           模型工具 (live)
```

## 安装

```sh
dsh plugin --profile web add @xcr1234/dsh-plugin-dbhub
```

插件依赖 `@xcr1234/dbhub-fork`；monorepo 场景下两者在同一个 workspace。

## 配置

插件独占一个 settings 命名空间：**`dbhub`**。Schema：

```ts
{
  port: number           // 1-65535，默认 8080
  enabled: boolean       // 默认 true
  sources: Array<{
    id: string           // [A-Za-z0-9_-]{1,64}
    dsn: string          // postgres://、mysql://、mariadb://、sqlserver://、sqlite://、oracle://
  }>
}
```

用户文档通过设置面板编辑；同样的结构会写到
`<DSH_PROFILE_DIR>/dbhub.toml`。

### 文件位置

插件写到 `${DSH_PROFILE_DIR}/dbhub.toml`。`DSH_PROFILE_DIR` 由 dsh
launcher 设置；回退到 `~/.dsh/profile-data/`。DBHub 用
`--config=<该文件>` 启动，cwd 不影响。

### 高级选项（SSH、SSL、query_timeout、自定义工具）

面板不暴露。直接手编辑 TOML 加进去即可；面板下次加载只读文件路径，
DBHub 的 watcher 立刻接管。下次面板保存时，**只覆盖 `id` 和 `dsn`
字段**——其他字段（ssh_host、sslmode 等）原样保留。

## 开发

```sh
pnpm install
pnpm --filter @xcr1234/dsh-plugin-dbhub build
pnpm --filter @xcr1234/dsh-plugin-dbhub test
pnpm --filter @xcr1234/dsh-plugin-dbhub typecheck
```

构建产物：
- `lib/index.js`、`lib/typert.js`、`lib/*.d.ts` — Host 端。
- `client/client.js` — 浏览器端，包在 `window.__ModuleLoader__.load`
  里。

## 生命周期

- 插件激活 → 注册 settings 命名空间 → 首次写 TOML → 启动进程内
  DBHub → 插入 `dsh-mcp-client` 行。
- 用户保存 → settings 提交 → 重写 TOML → DBHub watcher 重连。端口
  变化时，进程内 DBHub 重新拉起，`dsh-mcp-client` 行用新 id 重建。
- 卸载 → 进程内 DBHub 关闭（微任务里 `process.exit(0)`，相当于
  SIGTERM），`dsh-mcp-client` 行删除。
