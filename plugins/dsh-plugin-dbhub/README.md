# @xcr1234/dsh-plugin-dbhub

DSH web 插件：把 DBHub（一个 token 高效的数据库 MCP 服务器）变成设置面板的一等公民。插件以子进程方式启动 DBHub，管理它的 `dbhub.toml`，把已注册的工具回写到面板，并通过 `@deepseek-ai/dsh-mcp-client` 把 MCP 端点接到 DSH，让模型自动看到工具。

本文档是**新贡献者的上手指南**。如果只想安装使用，滚到底部看用户向快速开始。

---

## 1. 仓库里到底有什么

```
plugins/dsh-plugin-dbhub/
├── package.json              # 双面 npm 包；包名 @xcr1234/dsh-plugin-dbhub
├── cordis.patch.yml          # 一行 loader row: name: '@xcr1234/dsh-plugin-dbhub'
├── tsconfig.json             # strict ESM, allowImportingTsExtensions
├── tsup.config.ts            # host bundle (ESM, dts)
├── scripts/
│   └── build-client.mjs      # esbuild CJS -> __ModuleLoader__ factory 包装
├── src/
│   ├── index.ts              # host apply() 入口
│   ├── typert.ts             # host TYPERT manifest (dbhub/list, save, listTools)
│   ├── typert-bridge.ts      # 强制 deepseek-harness typert-protocol identity
│   ├── host/
│   │   ├── settings.ts       # ctx.dbhub service + settings section + onCommit
│   │   ├── runtime.ts        # dbhub 子进程生命周期 + /api/sources 探针
│   │   └── config-file.ts    # profile-dir 发现 + dbhub.toml 路径
│   ├── client/               # 浏览器半
│   │   ├── index.ts          # client plugin body
│   │   ├── DbhubSettingsSection.tsx   # 设置页（React）
│   │   ├── typert-remote.ts  # 客户端 TYPERT manifest（typert.ts 的镜像）
│   │   ├── locales.ts        # zh + en 字典
│   │   └── styles.ts         # 主题相关 CSS（data-plugin-css 注入）
│   └── shared/
│       ├── types.ts          # zod wire schemas + DbhubConfig/Tool/View
│       └── toml.ts           # configToToml / tomlToConfig / inferDbType
├── tests/
│   ├── runner.mjs            # 入口，代理到 tests/run-tests.ts
│   ├── run-tests.ts          # node:assert 测试框架（无 vitest / esbuild spawn）
│   └── toml.test.ts          # 往返 + schema 验证
├── README.md (本文档英文版)
├── README.zh.md (本文)
├── LICENSE                    # MIT
└── .gitignore                 # 排除 lib/、client/client.js、.smoke/
```

**构建产物（gitignored，由 `pnpm build` 重新生成）**：`lib/index.js`、
`lib/typert.js`、`lib/*.d.ts`、`client/client.js`、
`client/client.js.map`。

---

## 2. 它在 DSH 里的位置

DSH 把插件当作一个 `cordis:include` row 加载。包声明了
`dsh.client`（浏览器半），并导出一个 typert manifest（host
半）；dsh-host plugin inventory 和 dsh-typert-loader 会自动识别两者。

```
                  ┌──────────────────────────────────────────────┐
                  │  dsh web 进程 (E:\dev\deepseek-harness)      │
                  │                                              │
  用户面板  ◀──▶│  typert gateway  ──▶ ctx.dbhub.save()       │
       点击     │                     (host service)        │
                  │           │                              │
                  │           ▼                              │
                  │  settings.replace(ns, section)             │
                  │           │                              │
                  │           ├─▶ settings/<profile>/...yaml │
                  │           │                              │
                  │           ▼ (commit 触发 watcher)        │
                  │  onChange → writeToml → runtime.ensure   │
                  │                  │                       │
                  │                  ├─▶ <profile>/dbhub.toml │
                  │                  │                       │
                  │                  └─▶ spawn dbhub 子进程    │
                  │                                              │
                  │  dsh-mcp-client row (url=http://127.0.0.1:  │
                  │  <port>/mcp)                                │
                  └────────────────┬─────────────────────────────┘
                                   │ HTTP
                                   ▼
                  ┌──────────────────────────────────────────────┐
                  │  dbhub 子进程 (node dbhub-fork dist)        │
                  │  fs.watch dbhub.toml（500ms 防抖）          │
                  │  HTTP /mcp、/api/sources、/api/sources/:id  │
                  └──────────────────────────────────────────────┘
```

---

## 3. 端到端数据流

### 3.1 用户在面板编辑连接

1. `DbhubSettingsSection.tsx` 维护一个本地 `draft`（用户编辑中的配置）。
2. 点**保存** → `onSave` 调 `remote.save(draft)`（TYPERT） → 走 wire
   → `dbhub/save` host 方法。
3. `DbhubService.save` 校验 DSN，断言 source id 唯一，然后
   `ctx.settings.replace('dbhub', section)`。
4. settings commit 触发 `installSettingsSection` 注册的 watcher。
   `onChange`：
   - 重新读 `ctx.settings.get('dbhub')` 刷新 `currentConfig`（settings
     的 `setSource` 只在 attach/detach 时触发，**不会**每次 commit 都触发——这是一个真实坑点）
   - 原子地写 `dbhub.toml`（tmp + rename）
   - 调 `runtime.ensure(config, configPath)`，比较 port + enabled +
     source-count，启动/停止子进程
   - 触发 host 的 `onCommit` 钩子（`apply()` 用），如果 signature
     变了就重建 `dsh-mcp-client` row
5. `save()` 返回 live `DbhubView`。面板渲染结果。**面板还调度一个
   1.5s 后 `listTools()` 的 follow-up**，因为 dbhub 的 fs.watch
   （500ms）+ 冷启动 reconciliation 意味着 save 返回的 view.tools
   是 *reload 前的快照*。
6. dbhub 看到 `dbhub.toml` 变化 → 解析 → 重新连接 sources → 注册工具。

### 3.2 面板展示 vs. 模型可见

| 真相来源                                      | 谁读它                              |
| ---------------------------------------------- | ---------------------------------- |
| DSH settings 文件（`~/.dsh/settings.yaml`）→ `dbhub` 段 | panel `list()` 调用 |
| `<profile>/dbhub.toml`                        | dbhub 子进程；面板只显示路径，不直接读 |
| dbhub 的 `/api/sources` JSON 响应               | `DbhubService.listTools()`（live tools） |
| `dsh-mcp-client` loader row                   | 模型（以 `mcp__dbhub__*` 前缀）       |

三个独立的文件。面板不直接读 `dbhub.toml`，只读 DSH settings 段。
dbhub 读它的 TOML。模型两个都不读——它看到的是 `dsh-mcp-client`
暴露的 MCP 工具。

#### 真相来源 vs. 产物（容易踩的坑）

`dbhub.toml` **不是配置，它是面板→插件→dbhub 这条链路上的产物**。
数据流是单向的：

```
面板编辑 ──▶ settings.yaml  ──▶ 插件 onChange ──▶ dbhub.toml  ──▶ dbhub 子进程
              (DSH 写入)         (writeToml)        (fs.watch)
```

后果：

- **`id` 和 `dsn` 由面板拥有。** 你在 `dbhub.toml` 里手改这两个字段
  不会流回 `settings.yaml`，下次面板保存会被面板的值覆盖。如果想改
  连接身份，走面板或者改 `settings.yaml`。
- **其它字段（`ssh_host` / `sslmode` / `query_timeout` / `[[tools]]`）
  会被插件保留。** `host/settings.ts` 的 `writeToml` 在写盘前会先
  `readFileSync` 上一份 TOML，按 source id 抽出所有非 `id`/`dsn` 字段
  （`shared/toml.ts` 的 `parsePreservedFields`），合并进新的输出。
  你在 `dbhub.toml` 里加的 SSH 隧道在面板改 dsn 之后还会留着。
- **不要把 `dbhub.toml` 当配置来管理。** 删了它下次启动会被插件按
  `settings.yaml` 重建。如果想真的清空某个连接，走面板「移除」+
  保存，或编辑 `settings.yaml` 把对应 `sources` 条目删掉。
- **多 profile 共用一份 `dbhub.toml`（手动设了 `DBHUB_TOML_PATH` 到
  共享路径）是反模式。** 后写覆盖先写，没有合并语义。

---

## 4. 为何实现长这样

### 4.1 用子进程，而不是 `import('@xcr1234/dbhub-fork')`

最初我们试过 `import { startServer } from '@xcr1234/dbhub-fork'`，
但 dsh web loader 通过名字从 profile 的 `node_modules` 解析插件包。
对插件自己的代码这没问题，但运行时依赖 `@xcr1234/dbhub-fork` 在同一
workspace 可装——跨升级脆弱、对下游安装者困惑。

`DbhubRuntime`（`src/host/runtime.ts`）改为用 `process.execPath`
spawn `resolveDbhubBin()`（env 覆盖 `DBHUB_BIN`，再
`<plugin>/node_modules/@xcr1234/dbhub-fork/...`，再 workspace 兜底
`E:/dev/dbhub/dist/index.js`）。子进程 SIGTERM 杀掉（5s 宽限，
再 SIGKILL）。日志加 `[dbhub:<port>]` 前缀。

### 4.2 `src/typert-bridge.ts` 存在的原因

`@deepseek-ai/dsh-typert-protocol` 是 **deepseek-harness monorepo
内部包**，没有以可用形式发到 npm。插件的 `@Remote()` 装饰器把
marker 记录写到那个包的模块级 WeakMap 里。dsh-web 的 typert gateway
读同一个 map 来发现标记的方法。

如果插件加载自己那份包（通过 profile 的 `node_modules` 的 pnpm），
dsh-web 用 deepseek-harness 那份，两份是不同的模块实例，gateway
永远看不到插件的 marker——症状：**"Service has no visible
typertRemote binding"**。

`src/typert-bridge.ts` 用 `createRequire(import.meta.url)` 直接
加载 `deepseek-harness/packages/typert/protocol/lib/index.js`（可用
`DSH_HARNESS_ROOT` 覆盖）。两边现在共享完全相同的模块实例，
marker map 也共享。**不要"修"成裸的 `@deepseek-ai/dsh-typert-protocol`
import**——会重新引入 binding 错误。

### 4.3 为什么 TOML 写盘用 `tmp + rename`

Windows 的 `fs.rename` 不会覆盖已存在的目标文件。我们先删目标，
再把临时文件 rename 上去。这样给 dbhub 的 `fs.watch` 一个离散的
事件，而不是中间出现一个空文件窗口。

### 4.4 为什么只改 sources 不重启 dbhub 子进程

`DbhubRuntime.ensure` 只在 port / enabled / source-count 变化时
才重启。只改 sources 会写新 `dbhub.toml`；dbhub 自己的 watcher
（500ms 防抖）原地重连 sources，失败回滚。每次保存都重启子进程
会丢失缓存状态、浪费 ~1s。

### 4.5 为什么通过 `dbhub/listTools` 暴露工具，不重读 `dbhub.toml`

`dbhub.toml` 在产物侧只关心 `id` + `dsn`，但 **写盘时** 会先
`parsePreservedFields` 把上一份 TOML 里每个 source 的未知字段（SSH、
SSL、`query_timeout`、`[[tools]]` …）按 id 抽出，合并进新输出；只有
`id` 和 `dsn` 永远由面板拥有。所以面板保存能保住用户手编辑的高级
字段，但 id/dsn 本身的修改只能从面板或 `settings.yaml` 来。

工具清单本身走 dbhub 的 `fetch /api/sources` 实时拿——那个端点返回扁平的
`{ id, tools: [{ name, description, readonly }] }`。

fetch 有 3s `AbortController` 超时，失败时静默返回 `[]`——从不抛，
因为面板把空当作"暂无工具"（dbhub 正在启动中），不是错误。

---

## 5. 编码约定

- **所有副作用走 `ctx.effect(...)`**，这样插件 fiber 卸载时一并清理。
  不要模块级 timer、监听器、进程级状态。
- **必需服务在 `index.ts` 的 `inject` 中声明**，不要直接属性访问
  `ctx.xxx`。当前插件注入 `loader`。
- **TOML 序列化是唯一写盘的地方。** 其它都走 `ctx.settings`（DSH 管理）
  或 `ctx.loader`（DSH 管理）。
- **客户端面板从不直接调 dbhub**——只能调 host typert 端点。
  如果面板需要新数据，加一个 `DbhubService` 的 `@Remote` 方法，
  并在 `src/typert.ts` + `src/client/typert-remote.ts` 加对应条目。
- **所有字符串 UI 文案在 `src/client/locales.ts` 中。** 同时加到 `zh`
  和 `en`；中文字典是 key 集来源。

---

## 6. 加功能：常规清单

加新字段到 config 时：

1. `src/shared/types.ts` — 加到 `DbhubConfig` interface 和
   `dbhubConfigZodSchema`（wire）和 `dbhubConfigSchema`（schemastery，
   settings-file 用的）。
2. `src/client/DbhubSettingsSection.tsx` — 加到编辑表单和视图布局。
3. `src/client/locales.ts` — 两个字典都加 label + hint。
4. `src/shared/toml.ts` — 仅当字段需要通过 `dbhub.toml` 往返时（大多数
   仅用户字段不需要）。
5. 如果字段影响 runtime（比如要传给 dbhub 的新环境变量），更新
   `DbhubRuntime.ensure` 和 `src/index.ts` 的 `onCommit` 签名。

加新 typert 端点时：

1. `DbhubService` 加 `@Remote()` 方法。
2. `src/typert.ts` 加 invocation 条目（host）。
3. `src/client/typert-remote.ts` 加匹配 descriptor（client）。
4. 两边的 zod schema 都从 `src/shared/types.ts` import —— 单一来源，
   双向校验。

---

## 7. 调试

### 日志位置

插件日志全部进 **dsh-web 的 stderr**（你启动 `dsh web` 的终端）。
一些值得注意的前缀：

| 前缀                              | 含义 |
| --------------------------------- | ---- |
| `[dbhub] save called with ...`    | 面板触发 save，入口 |
| `[dbhub] writeToml called ...`    | settings commit 触发 watcher |
| `[dbhub] writeToml wrote <path> (<n> bytes)` | 文件已落盘 |
| `[dbhub] profile dir resolved from cordis:include -> <dir>` | 路径解析成功 |
| `[dbhub] no cordis:include in loader; entries seen: ...` | 路径解析失败——通常是 loader 还没准备好，回退到默认 |
| `[dbhub:18080] ...`               | dbhub 子进程透传 |

### "我保存了但面板没更新"

链路：`save → settings.replace → watcher → onChange → writeToml →
runtime.ensure`。任何一步静默抛错，面板看起来没动。

- **Watcher 没触发：**`installSettingsSection.onChange` 读
  `ctx.settings.get('dbhub')` 来刷新 `currentConfig`（settings
  的 `setSource` 只在 attach/detach 时触发，**不是**每次 commit——
  见 §4.5）。如果你重构那个钩子丢了 `settings.get(ns)` 刷新，
  `writeToml` 会一直写 install 时的快照。
- **dsh.toml 路径错：** 检查 `cordis:include` entry 的
  `config.path` 是否解析到真实的 `cordis.yml`。
  `resolveProfileDirFromLoader` 记了具体决定日志。

### "模型看不到 dbhub 的工具"

1. 插件的 `apply()` 只在 signature 变化时插入 `dsh-mcp-client` row。
   在 dsh-host-plugin-inventory 列表（或者 dsh web 库存 UI 如果开启
   了）里找 `mcp-dbhub-<port>`。插件还要求 `view.running &&
  view.config.enabled && view.config.sources.length > 0`——任一为假，
  下次 reconcile 时 row 就被删了。
2. dbhub 自己的 `execute_sql` / `search_objects` / `explain_sql`
  通过 `dbhub/listTools` 在面板可见。模型在 **serverName** 前缀下
  看到，例如 `mcp__dbhub__execute_sql`。

### "dsh web 根本加载不了插件"

启动错误在 `dsh web` stderr。常见原因：
- **没装 `@xcr1234/dbhub-fork` 也没设 `DBHUB_BIN`。**
  `DbhubRuntime.resolveDbhubBin()` 在 startInternal 时两者都没有
  就抛错。
- **`cordis:include` entry 的 `config.path` 格式错。** dsh
  会打印 loader 错误。先跑 `pnpm typecheck` 捕获 schema 漂移。

---

## 8. 用户向快速开始

```sh
# 在 dbhub monorepo 根
pnpm install
pnpm run build:backend            # 编译 @xcr1234/dbhub-fork
pnpm --filter @xcr1234/dsh-plugin-dbhub build

# 把插件接入 dsh profile（junction symlink 或 npm install）
cd C:\Users\xcr_1\.dsh\profiles\web
pnpm install E:\dev\dbhub\plugins\dsh-plugin-dbhub

# 加到 cordis.patch.yml：
#   - insert:
#       - id: dbhub
#         name: '@xcr1234/dsh-plugin-dbhub'

# 启动 dsh web 打开 http://127.0.0.1:3080
# 设置 -> 数据库连接 -> 新增连接 -> 保存
```

### 配置

```ts
// settings namespace "dbhub"
{
  port: number        // 1-65535, 默认 18080
  enabled: boolean    // 默认 true
  sources: Array<{
    id: string        // [A-Za-z0-9_-]{1,64}
    dsn: string       // postgres://、mysql://、mariadb://、sqlserver://、sqlite://、oracle://
  }>
}
```

`dbhub.toml` 落到 `<profile>/dbhub.toml`（如
`C:\Users\xcr_1\.dsh\profiles\web\dbhub.toml`）。用
`DBHUB_TOML_PATH=<完整路径>` 覆盖到其它位置。

高级选项（SSH、SSL、`query_timeout`、自定义工具）面板不暴露，
直接编辑 `dbhub.toml`。dbhub 的 watcher（500ms 防抖）保存时重载。

写在 `dbhub.toml` 里的非 `id`/`dsn` 字段 **会被插件保留**：见 §3.2。
`id` 和 `dsn` 是面板的字段，要改走面板或 `settings.yaml`。

---

## 9. 测试

`pnpm test` 跑 `node tests/runner.mjs`，代理到一个 `node:assert`
测试框架（`tests/run-tests.ts`）。没有 vitest、没有 esbuild spawn
——在沙盒 Windows shell 上会撞 EPERM，所以测试框架刻意保持精简。
每个测试文件（`tests/*.test.ts`）是自包含的：内联自己的 `describe`
/ `t` / `expect`，模块求值时打印汇总。

如果你想要 fixtures 或异步 helpers，考虑这测试是否真的属于本仓
——任何需要 spawn dbhub 或打网络的应该是 dbhub 项目的集成测试，
不是这里。
