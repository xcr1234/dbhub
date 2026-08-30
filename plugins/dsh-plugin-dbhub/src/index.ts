/**
 * DSH plugin entry: registers the `ctx.dbhub` typert service, wires it
 * to the in-process dbhub server, and inserts a single
 * `@deepseek-ai/dsh-mcp-client` row whose URL points at the running
 * server. The browser half lives in `./client/index.ts` (mounted by
 * dsh-web's client-modules node half from the same npm package
 * because the package declares `dsh.client`).
 *
 * The host TYPERT face lives in `./typert.ts` (auto-registered by
 * `dsh-typert-loader` when the loader row's `name` field is the
 * package name and `./typert.ts` exports `TYPERT`).
 *
 * @module @xcr1234/dsh-plugin-dbhub
 */

import type { Context } from '@deepseek-ai/cordis'
import { DbhubService, type DbhubServiceCommitHook } from './host/settings.ts'

/**
 * Augment the Cordis `Context` shape with the DSH `loader` service
 * this plugin reads. `settings` is already declared by
 * `@deepseek-ai/dsh-settings`. Both are mounted by the host
 * composition (`dsh-base` + `dsh-web-app`); their absence is a
 * configuration error surfaced at plugin load time.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    loader: {
      create(opts: { id: string; name: string; config: unknown }): Promise<unknown>
      remove(id: string): Promise<void>
    }
  }
}

/** Stable Cordis plugin name (used by loader diagnostics and the typert row). */
export const name = 'dbhub'

/** Services this plugin needs before activation. */
export const inject = ['loader']

/**
 * Mount the host half. The `DbhubService` constructor registers itself
 * with Cordis via `new Service(ctx, 'dbhub')`, so `ctx.dbhub` becomes
 * available as soon as `apply` returns. The first-run TOML is emitted
 * synchronously inside `install()`; the in-process dbhub server may
 * still be starting up at that point and is reconciled asynchronously.
 */
export async function apply(ctx: Context): Promise<void> {
  // The service's constructor (`super(ctx, 'dbhub')`) registers the
  // service into Cordis immediately; the typert host gateway can
  // dispatch `dbhub/list` and `dbhub/save` here as soon as apply returns.
  const service = new DbhubService(ctx)

  // The mcp-client row follows the live dbhub state. We let
  // DbhubService install the settings section, and we receive the
  // post-commit view so we can insert / remove the row in lockstep
  // with the port. The previous row is removed first; that matters
  // because dsh-mcp-client refuses a new URL for a serverName it
  // already holds a namespace reservation for.
  ctx.inject(['loader'], (lctx) => {
    const teardown: Array<() => Promise<void>> = []
    let lastSignature: string | null = null
    lctx.effect(() => {
      return async () => {
        for (const t of teardown.splice(0)) await t()
      }
    }, 'dbhub.mcp-client.disposer')

    const onCommit: DbhubServiceCommitHook = async (view) => {
      const signature = [
        view.running ? '1' : '0',
        view.config.enabled ? '1' : '0',
        view.config.sources.length > 0 ? '1' : '0',
        String(view.config.port),
      ].join(':')
      if (signature === lastSignature) return
      lastSignature = signature
      for (const t of teardown.splice(0)) await t()
      if (!view.running || !view.config.enabled || view.config.sources.length === 0) {
        return
      }
      const id = `mcp-dbhub-${String(view.config.port)}`
      await lctx.loader.create({
        id,
        name: '@deepseek-ai/dsh-mcp-client',
        config: {
          serverName: 'dbhub',
          transport: 'streamable-http',
          url: `http://127.0.0.1:${String(view.config.port)}/mcp`,
        },
      })
      teardown.push(async () => {
        await lctx.loader.remove(id)
      })
    }
    service.install({ onCommit })
  })
}
