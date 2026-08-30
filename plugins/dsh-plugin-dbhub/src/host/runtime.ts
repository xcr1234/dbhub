/**
 * In-process dbhub server runtime: starts dbhub's HTTP transport
 * by spawning a child `node` process that runs dbhub's compiled
 * `dist/index.js` with `--transport=http --port=... --config=...`.
 *
 * Why a child process, not `import` from `@xcr1234/dbhub-fork`?
 *
 *  - DSH's loader resolves plugin packages by name from the
 *    profile's `node_modules`. Bringing `@xcr1234/dbhub-fork`
 *    along requires either publishing it to a registry the
 *    profile can reach, or symlinking, or a workspace setup that
 *    does not survive the dsh launcher's own `node_modules`
 *    reorganisation. None of those are robust across a profile
 *    upgrade.
 *  - Spawning the bundled `node dist/index.js` is exactly what
 *    `npx dbhub` does, just with a known absolute path. The
 *    dbhub process is otherwise identical to a CLI invocation.
 *  - It also matches the user's stated preference ("最好能通过
 *    代码触发，不依赖 npx 命令") — we still avoid `npx`, and the
 *    only side effect is one process per active dbhub instance,
 *    which is what the dsh settings panel already implies.
 *
 * The child process is owned by the plugin fiber: the disposer
 * sends SIGTERM and waits up to 5s before SIGKILL.
 *
 * @module @xcr1234/dsh-plugin-dbhub/host
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DbhubConfig, DbhubTool } from '../shared/types.ts'

/** Options the host passes to dbhub via argv. */
export interface StartServerOptions {
  configPath: string
  port: number
}

/** Public lifecycle handle returned by {@link DbhubRuntime.ensure}. */
export interface DbhubHandle {
  /** Re-bind to a new port; tears down the current process and starts a new one. */
  restart(): Promise<void>
  /** Stop the child process. Idempotent. */
  stop(): Promise<void>
  /** True when the child process is alive. */
  isRunning(): boolean
}

interface ActiveServer {
  child: ChildProcess
  port: number
  /** Resolves once the child exits; lets `stop()` wait for clean shutdown. */
  exited: Promise<void>
}

const SIGTERM_GRACE_MS = 5_000

/**
 * Resolve the absolute path of the dbhub executable. Three sources,
 * in priority order:
 *
 *  1. `process.env.DBHUB_BIN` — set by the dsh launcher (or a
 *     wrapper script) when the operator knows exactly which build
 *     to run. Most reliable.
 *  2. `<plugin>/node_modules/@xcr1234/dbhub-fork/dist/index.js` —
 *     the package was installed alongside this plugin (the common
 *     local-dev case).
 *  3. Hard-coded workspace path on the developer's machine. Lets
 *     a freshly-built dbhub be picked up without an `npm install`
 *     round-trip.
 */
export function resolveDbhubBin(): string {
  const env = process.env.DBHUB_BIN
  if (typeof env === 'string' && env.length > 0 && existsSync(env)) {
    return resolve(env)
  }
  // 2: walk up from this file's compiled location to the plugin
  // root, then look for the optional bundled dbhub.
  // For the host bundle, runtime.js sits under `<plugin>/lib/`,
  // so the plugin root is one level up.
  const here = import.meta.dirname
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url))
  for (let dir = here; ; dir = dirname(dir)) {
    const candidate = resolve(dir, 'node_modules/@xcr1234/dbhub-fork/dist/index.js')
    if (existsSync(candidate)) return candidate
    if (dirname(dir) === dir) break
  }
  // 3: hard-coded workspace fallback. Keep in sync with the
  // dbhub project's `dist/index.js` output.
  return resolve('E:/dev/dbhub/dist/index.js')
}

/**
 * Owns at most one dbhub child process at a time. Each `ensure`
 * reconciles that one process to the requested config: if
 * `enabled` is false, the server is stopped; if the port changed,
 * it is restarted; otherwise no action (dbhub's own TOML watcher
 * is doing the work).
 */
export class DbhubRuntime {
  private active: ActiveServer | null = null
  private lastError: string | null = null

  /** Read the most recent start/stop error, or null. Cleared on next success. */
  getLastError(): string | null {
    return this.lastError
  }

  isRunning(): boolean {
    return this.active !== null
  }

  /** Current bound port, or null when dbhub is not running. */
  currentPort(): number | null {
    return this.active?.port ?? null
  }

  /**
   * Fetch the live tool inventory from dbhub's HTTP API and flatten
   * it into the panel's `(sourceId, name, description, readonly)`
   * shape. Returns an empty array when dbhub is not running or
   * the `/api/sources` request fails — the panel treats empty as
   * "no tools yet", not as an error.
   */
  async listTools(): Promise<DbhubTool[]> {
    const port = this.active?.port
    if (port === undefined) return []
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3_000)
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/api/sources`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) return []
      const payload = (await res.json()) as Array<{
        id: string
        tools?: Array<{ name?: string; description?: string; readonly?: boolean }>
      }>
      const out: DbhubTool[] = []
      for (const src of payload) {
        for (const tool of src.tools ?? []) {
          if (typeof tool.name !== 'string' || tool.name.length === 0) continue
          out.push({
            sourceId: src.id,
            name: tool.name,
            description: typeof tool.description === 'string' ? tool.description : null,
            readonly: tool.readonly === true,
          })
        }
      }
      return out
    } catch {
      // dbhub just restarted, /api/sources 5xx, fetch aborted —
      // all the same outcome: try again on the next refresh.
      return []
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Reconcile the dbhub child process to `config`. Safe to call
   * many times. Returns a handle the host can use to force-stop
   * on disposal.
   */
  async ensure(config: DbhubConfig, configPath: string | null): Promise<DbhubHandle> {
    if (!config.enabled || config.sources.length === 0) {
      await this.stopInternal('disabled or no sources')
      return this.handle()
    }

    // Same port and already running: nothing to do. dbhub's own
    // fs.watch is responsible for picking up TOML edits.
    if (this.active && this.active.port === config.port) {
      return this.handle()
    }

    // Port changed (or first start): tear down, then start.
    if (this.active) {
      await this.stopInternal('port change')
    }
    if (configPath === null) {
      return this.handle()
    }
    await this.startInternal(config, configPath)
    return this.handle()
  }

  /** Force-stop; used by the host fiber's dispose. */
  async stop(): Promise<void> {
    await this.stopInternal('host dispose')
  }

  private handle(): DbhubHandle {
    const self = this
    return {
      isRunning: () => self.isRunning(),
      stop: () => self.stop(),
      restart: async () => {
        if (self.active) await self.stopInternal('manual restart')
      },
    }
  }

  private async startInternal(config: DbhubConfig, configPath: string): Promise<void> {
    const bin = resolveDbhubBin()
    if (!existsSync(bin)) {
      const err = `dbhub binary not found at ${bin} (set DBHUB_BIN env or install @xcr1234/dbhub-fork alongside this plugin)`
      this.lastError = err
      throw new Error(err)
    }
    const args = [
      bin,
      '--transport=http',
      `--port=${String(config.port)}`,
      `--config=${configPath}`,
    ]
    try {
      const child = spawn(process.execPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: { ...process.env, NODE_ENV: 'production' },
      })
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
      })
      // Forward the child's stdout/stderr to our log under a
      // `dbhub:` prefix so the user can correlate.
      const prefix = `[dbhub:${String(config.port)}] `
      child.stdout?.on('data', (chunk: Buffer) => {
        process.stdout.write(prefix + chunk.toString('utf8'))
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(prefix + chunk.toString('utf8'))
      })
      child.once('error', (err) => {
        this.lastError = err.message
      })
      this.active = { child, port: config.port, exited }
      this.lastError = null
      // Give dbhub a moment to bind the HTTP listener.
      await new Promise((resolve) => setTimeout(resolve, 250))
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.active = null
      throw err
    }
  }

  private async stopInternal(_reason: string): Promise<void> {
    const active = this.active
    if (!active) return
    this.active = null
    const { child, exited } = active
    try {
      child.kill('SIGTERM')
    } catch {
      // already dead
    }
    const force = new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // already dead
        }
        resolve()
      }, SIGTERM_GRACE_MS)
      t.unref?.()
    })
    await Promise.race([exited, force])
  }
}
