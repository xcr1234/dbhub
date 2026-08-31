/**
 * DSH plugin entry: registers the `ctx.dbhub` Cordis service, wires the
 * Connection RPC channel that the browser panel calls into, and inserts a
 * single `@deepseek-ai/dsh-mcp-client` row whose URL points at the
 * running dbhub server.
 *
 * Architecture (mirrors dsh-mcp-manager):
 *   - `apply()` creates one `DbhubService` Cordis service instance and
 *     binds it on the context (so internal helpers can `ctx.dbhub`).
 *   - The host-side RPC handler is registered with
 *     `ctx.connection.rpc.handle('/dbhub', dispatch, ...)`. The
 *     dispatch lives in `./host/rpc.ts` and routes endpoint names to
 *     `DbhubService` methods.
 *   - The browser half lives in `./client/index.ts` (mounted by
 *     dsh-web's client-modules node half from the same npm package
 *     because the package declares `dsh.client`).
 *
 * Why no typert manifest anymore: the old `@Remote` decorator path
 * forced the plugin and dsh-web to share the exact same module
 * instance of `@deepseek-ai/dsh-typert-protocol` (the marker WeakMap
 * was module-level). That only worked via a source-tree bridge that
 * broke for npm-distributed consumers. Connection RPC uses cordis
 * services, which are shared at the process level — no module
 * identity tricks required.
 *
 * @module @xcr1234/dsh-plugin-dbhub
 */

import type { Context } from '@deepseek-ai/cordis'
import { DbhubService, type DbhubServiceCommitHook } from './host/settings.ts'
import { dispatch, RPC_CHANNEL } from './host/rpc.ts'

/**
 * Augment the Cordis `Context` shape with the DSH services this
 * plugin reads. `settings` is already declared by
 * `@deepseek-ai/dsh-settings`. `loader` and `connection` are mounted
 * by the host composition (`dsh-base` + `dsh-web-app`); their absence
 * at apply time is a configuration error surfaced at plugin load.
 *
 * `connection.rpc.handle` is modelled as returning any of
 * `Promise<...> | (() => void) | { dispose }` because the runtime
 * shape depends on which Connection RPC implementation the host has
 * loaded — we only need to be able to call the returned disposer.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    loader: {
      create(opts: { id: string; name: string; config: unknown }): Promise<unknown>
      remove(id: string): Promise<void>
    }
    connection: {
      rpc: {
        handle(
          channel: string,
          handler: (endpoint: string, payload: unknown) => Promise<unknown>,
          opts?: { authority?: string },
        ): unknown
      }
    }
  }
}

/** Stable Cordis plugin name (used by loader diagnostics). */
export const name = 'dbhub'

/** Services this plugin needs before activation. */
export const inject = ['connection', 'loader']

/**
 * Mount the host half. The `DbhubService` constructor registers itself
 * with Cordis via `new Service(ctx, 'dbhub')`, so `ctx.dbhub` becomes
 * available as soon as `apply` returns.
 *
 * Lifecycle (top to bottom):
 *   1. Create the service so its install() can wire the settings
 *      namespace + watchers + runtime reconcile before the RPC
 *      handler is registered.
 *   2. Wait for `connection`, then register the RPC channel handler
 *      with disposer (`ctx.effect` cleanup).
 *   3. Wait for `loader`, then drive the mcp-client row
 *      insert/remove in lockstep with the live dbhub state via
 *      `service.install({ onCommit })`.
 */
export async function apply(ctx: Context): Promise<void> {
  const service = new DbhubService(ctx)

  ctx.inject(['connection'], () => {
    ctx.effect(() => {
      const handler = async (endpoint: string, payload: unknown) =>
        dispatch(service, endpoint, payload)
      const disposer = ctx.connection.rpc.handle(
        RPC_CHANNEL,
        handler,
        { authority: 'loopback' },
      )
      return () => {
        // The Connection RPC API returns either a sync disposer
        // function or a Promise<disposer>; normalise both forms to
        // a void fire-and-forget so fiber teardown never throws.
        Promise.resolve(disposer).then((d) => {
          if (typeof d === 'function') d()
          else if (d !== null && typeof d === 'object' && 'dispose' in d) {
            (d as { dispose: () => void }).dispose()
          }
        }).catch(() => {
          // Best-effort cleanup; swallow so an unload-time error
          // doesn't surface to the user.
        })
      }
    }, 'dbhub: rpc channel')
  })

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