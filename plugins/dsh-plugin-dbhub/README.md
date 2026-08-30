# @xcr1234/dsh-plugin-dbhub

English | [中文](README.zh.md)

DSH plugin: **manage DBHub database MCP servers from the settings panel.**
DBHub is started in-process (no `npx` child process), its `dbhub.toml`
config is generated from the panel, and its tools are exposed to the
model through `@deepseek-ai/dsh-mcp-client`. Hot reload is handled by
DBHub's own `fs.watch` on the TOML file — the plugin just rewrites
the file on save.

## What it does

- **In-process DBHub** — `startServer({ transport: 'http', port, configPath })`
  from `@xcr1234/dbhub-fork/server` is invoked directly. No child
  process, no `npx` dependency on the host PATH.
- **Settings panel** — adds a "Database connections" entry to the
  settings list. Edit, add, remove, change port, toggle on/off,
  then **Save**. The panel calls `dbhub/save` through typert, the
  host writes `dbhub.toml`, DBHub's watcher picks it up.
- **Auto-exposed tools** — a single `@deepseek-ai/dsh-mcp-client`
  row pointing at `http://127.0.0.1:<port>/mcp` is inserted on
  first successful start, removed on dispose, and rebuilt when the
  port changes.
- **Hot reload** — DBHub's own `config-watcher.ts` (500 ms
  debounce) re-connects sources on every TOML edit, with rollback
  on failure. The plugin does not need its own reload logic.

## Architecture

A dual-face npm package installed into the `web` profile:

| Half     | Entry                              | Role |
| -------- | ---------------------------------- | ---- |
| Server   | `lib/index.js`                     | Cordis plugin: registers `ctx.dbhub` (typert), starts the in-process DBHub, watches the `dbhub` settings namespace, and manages the `dsh-mcp-client` row. |
| TYPERT   | `lib/typert.js`                    | Host typert face (`dbhub/list`, `dbhub/save`). |
| Browser  | `client/client.js`                 | `window.__ModuleLoader__.load` factory: mounts the `dbhub` remote, registers the locale dictionaries, injects the React settings page into the `settings.section` slot. |

```
Settings panel (browser)             Host plugin                    DBHub (in-process)
─────────────────────────           ────────────────────           ────────────────────
User edits DSN  ────── dbhub/save ──▶ zod parse ──▶ settings.replace
                                          │
                                          ├─▶ writeToml()  ────────▶ fs.watch (500ms)
                                          │                            │
                                          └─▶ runtime.ensure()        ├─▶ parse TOML
                                               │                      ├─▶ reconnect sources
                                               ▼                      ├─▶ rebuild tool registry
                                       mcp-client row                 └─▶ register tools
                                       (http://.../mcp)                     │
                                                                         model tools
                                                                         (live)
```

## Install

```sh
dsh plugin --profile web add @xcr1234/dsh-plugin-dbhub
```

The package depends on `@xcr1234/dbhub-fork`; that one ships the
`/server` subpath the plugin imports. In a monorepo setup both
live in the same workspace.

## Configuration

The plugin owns one settings namespace: **`dbhub`**. Schema:

```ts
{
  port: number           // 1-65535, default 8080
  enabled: boolean       // default true
  sources: Array<{
    id: string           // [A-Za-z0-9_-]{1,64}
    dsn: string          // postgres://, mysql://, mariadb://, sqlserver://, sqlite://, oracle://
  }>
}
```

The user document is edited through the settings panel; the same
shape is what the plugin writes to `<DSH_PROFILE_DIR>/dbhub.toml`.

### File layout

The plugin writes to `${DSH_PROFILE_DIR}/dbhub.toml`. `DSH_PROFILE_DIR`
is set by the dsh launcher; the fallback is `~/.dsh/profile-data/`.
DBHub is started with `--config=<that file>`, so cwd is irrelevant.

### Advanced options (SSH, SSL, query_timeout, custom tools)

Not exposed in the panel. Hand-edit the TOML file to add them; the
panel re-reads the file path on next load and DBHub's watcher picks
up the new fields automatically. The next panel save will preserve
any field whose name is not `id` or `dsn` on a `[[sources]]` row —
the plugin's `tomlToConfig` round-trip keeps `id` + `dsn` only.

## Development

```sh
pnpm install
pnpm --filter @xcr1234/dsh-plugin-dbhub build
pnpm --filter @xcr1234/dsh-plugin-dbhub test
pnpm --filter @xcr1234/dsh-plugin-dbhub typecheck
```

The build emits:
- `lib/index.js`, `lib/typert.js`, `lib/*.d.ts` — the host bundle.
- `client/client.js` — the browser bundle, wrapped in the
  `window.__ModuleLoader__.load({ id, factory })` call.

## Lifecycle

- Plugin activation → settings registration → first TOML write →
  in-process DBHub start → `dsh-mcp-client` row inserted.
- User saves → settings commit → TOML rewrite → DBHub watcher
  reloads in place. On a port change, the in-process server is
  torn down and a new one is started; the `dsh-mcp-client` row is
  rebuilt under a new id (the dsh-mcp-client plugin refuses a new
  URL for a serverName it already holds).
- Disposal → the in-process DBHub is killed (SIGTERM-style
  `process.exit(0)` from a microtask) and the `dsh-mcp-client` row
  is removed.
