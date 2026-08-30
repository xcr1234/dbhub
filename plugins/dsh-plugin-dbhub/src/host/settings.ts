/**
 * Settings namespace ownership and the `ctx.dbhub` typert service.
 *
 * Owns:
 *  - the `dbhub` settings namespace (schema + watcher)
 *  - the `dbhub/list` / `dbhub/save` host service methods the panel
 *    calls through TYPERT
 *  - the lifecycle for the in-process dbhub server and the on-disk
 *    dbhub.toml that backs it
 *
 * Settings writes are routed through `ctx.settings.update` / `.replace`
 * (the standard provider API). The `installSettingsSection` helper
 * gives us the read-side wiring for free (base -> user -> schema
 * defaults, fiber-scoped disposal, schema-declared `applies`). The
 * write side is just `ctx.settings.replace(ns, section)`.
 *
 * @module @xcr1234/dsh-plugin-dbhub/host
 */

import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { type Context } from '@deepseek-ai/cordis'
// See `../typert-bridge.js` for the full rationale: the plugin and
// dsh-web must share the SAME module instance of
// `@deepseek-ai/dsh-typert-protocol` for the `@Remote` marker
// WeakMap to be visible to the typert gateway.
import { Remote, TypertRemoteService } from '../typert-bridge.js'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { dbhubConfigSchema, type DbhubConfig, type DbhubView } from '../shared/types.ts'
import { assertValidDsn, configToToml } from '../shared/toml.ts'
import { ensureConfigDir, resolveConfigPath } from './config-file.ts'
import { DbhubRuntime } from './runtime.ts'

/** Default settings value when no user section exists yet. */
const DEFAULT_CONFIG: DbhubConfig = {
  port: 18080,
  enabled: true,
  sources: [],
}

const NS = settingsNamespace('dbhub')

/** Hook fired after every settings commit, with the post-reconcile view. */
export type DbhubServiceCommitHook = (view: DbhubView) => void | Promise<void>

/**
 * Host service exposed at `ctx.dbhub`. Inheriting
 * {@link TypertRemoteService} binds the same key to the typert
 * gateway so the panel's `dbhub/list` and `dbhub/save` calls
 * dispatch here directly, with the strict codecs declared in
 * `typert.ts`. Methods marked `@Remote` are the gateway's
 * source-mode discovery targets.
 */
export class DbhubService extends TypertRemoteService {
  private currentConfig: DbhubConfig = DEFAULT_CONFIG
  private readonly runtime = new DbhubRuntime()

  constructor(public readonly ctx: Context) {
    super(ctx, 'dbhub')
  }

  /**
   * Resolve the live profile directory. dsh-web's loader has the
   * root `cordis:include` entry whose `config.path` is the profile's
   * `cordis.yml`; we read it for the authoritative profile dir.
   * Falls back to env-var / install-path heuristics when the
   * loader isn't reachable (unit tests, early bootstrap).
   */
  private resolveConfigPath(): string {
    const loader = this.ctx.get('loader')
    return resolveConfigPath(loader)
  }

  /** TYPERT: read the current view. */
  @Remote
  list(): DbhubView {
    return {
      config: this.currentConfig,
      running: this.runtime.isRunning(),
      lastError: this.runtime.getLastError(),
      configPath: this.resolveConfigPath(),
    }
  }

  /**
   * TYPERT: persist a new config, rewrite dbhub.toml, reconcile the
   * in-process server, and return the new view. Validates DSNs and
   * source-id uniqueness BEFORE writing; a malformed input rejects
   * without touching the file.
   */
  @Remote
  async save(input: DbhubConfig): Promise<DbhubView> {
    for (const s of input.sources) {
      assertValidDsn(s.dsn, s.id)
    }
    const seen = new Set<string>()
    for (const s of input.sources) {
      if (seen.has(s.id)) {
        throw new Error(`duplicate source id "${s.id}"`)
      }
      seen.add(s.id)
    }
    const settings = this.ctx.get('settings')
    if (!settings) {
      throw new Error('dbhub settings service is not mounted')
    }
    await settings.replace(NS, input as unknown as Record<string, unknown>)
    // The watcher fires onChange synchronously inside the settings
    // service; one microtask yield lets currentConfig pick up the new
    // value before we read it.
    await Promise.resolve()
    return this.list()
  }

  /**
   * Wire up the settings namespace, watchers, and first-run start.
   * Called once from `apply` after the service is registered.
   *
   * The optional `onCommit` hook fires after the TOML is rewritten
   * and the in-process server has been reconciled, so the apply()
   * can use it to insert / remove the `dsh-mcp-client` row in lockstep
   * with the port.
   */
  install(opts: { onCommit?: (view: DbhubView) => void } = {}): void {
    installSettingsSection(this.ctx, NS, dbhubConfigSchema, DEFAULT_CONFIG, {
      setSource: (source) => {
        this.currentConfig = source()
      },
      onChange: () => {
        this.writeToml()
        void this.reconcile().then(() => {
          opts.onCommit?.(this.list())
        })
      },
    })
    // Disposer: stop the in-process server when this fiber unloads.
    this.ctx.effect(() => {
      return () => {
        void this.runtime.stop()
      }
    }, 'dbhub.runtime.dispose')
    // First-run bring-up: installSettingsSection already called
    // onChange once during attach, but reconcile was inside a void
    // promise; trigger one more in case the initial state is
    // enabled+has-sources and the install path's call did not
    // successfully start.
    if (this.currentConfig.enabled && this.currentConfig.sources.length > 0) {
      void this.reconcile().then(() => {
        opts.onCommit?.(this.list())
      })
    }
  }

  /**
   * Read the live config so callers (the apply() row) can insert the
   * mcp-client entry with the right URL. Re-snapshotted every call.
   */
  public snapshot(): DbhubView {
    return this.list()
  }

  private async reconcile(): Promise<void> {
    try {
      await this.runtime.ensure(this.currentConfig, this.resolveConfigPath())
    } catch {
      // runtime records the error in its lastError; nothing to do
      // here besides preventing an unhandled rejection.
    }
  }

  private writeToml(): void {
    if (!this.currentConfig.enabled || this.currentConfig.sources.length === 0) {
      return
    }
    const loader = this.ctx.get('loader')
    ensureConfigDir(loader)
    const text = configToToml(this.currentConfig)
    const target = this.resolveConfigPath()
    const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(tmp, text, 'utf8')
    try {
      if (existsSync(target)) unlinkSync(target)
      renameSync(tmp, target)
    } catch {
      // Swallow: the runtime's lastError already gets set by ensure();
      // the next write will retry. Leaving a half-written file on disk
      // is preferable to crashing the panel.
    }
  }
}
